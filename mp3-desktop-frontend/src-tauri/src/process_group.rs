//! Process-tree ownership for the engine sidecar.
//!
//! The PyInstaller one-file sidecar is *two* processes: a bootloader that
//! unpacks the archive, and the real server it forks. Killing only the process
//! we spawned therefore orphans the server, and the orphan keeps the loopback
//! port and keeps running after the window is gone.
//!
//! Each platform has one mechanism for "everything in this tree dies together":
//!
//! * **Unix** — a process group, signalled with `kill(-pid)`. Nothing to set up
//!   beyond `process_group(0)` at spawn time, which `engine.rs` does.
//! * **Windows** — a Job Object. Processes cannot join a job after they are
//!   running, but they *inherit* their parent's job, so assigning the bootloader
//!   covers the server it forks. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` then makes
//!   the whole tree die when the job handle closes — which the OS does for us
//!   even if YAME itself crashes, so this is strictly stronger than signalling.
#![allow(dead_code)]

use std::process::Child;
#[cfg(target_os = "windows")]
use std::sync::Mutex;

/// Owns the platform's process-group mechanism for one spawned engine.
///
/// The job handle is behind a `Mutex` because terminating means *dropping* it —
/// that is what kills the tree on Windows — and `Engine` is shared behind a
/// `&self` when the app shuts down.
pub struct ProcessGroup {
    #[cfg(target_os = "windows")]
    job: Mutex<Option<JobHandle>>,
}

impl ProcessGroup {
    /// Set up whatever the platform needs. Never fails the launch: an engine
    /// that runs is better than no engine, and the parent-PID watchdog in
    /// `main.py` is the backstop when this is unavailable.
    pub fn new() -> Self {
        #[cfg(target_os = "windows")]
        {
            return Self { job: Mutex::new(JobHandle::create()) };
        }
        #[cfg(not(target_os = "windows"))]
        {
            Self {}
        }
    }

    /// Put a freshly spawned child (and everything it forks) in the group.
    pub fn adopt(&self, child: &Child) {
        #[cfg(target_os = "windows")]
        {
            let guard = self.job.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(job) = guard.as_ref() {
                if let Err(err) = job.assign(child) {
                    // Most likely the process already exited, or it is already
                    // in a job that forbids nesting (some CI sandboxes). The
                    // watchdog covers us; say so rather than failing loudly.
                    eprintln!("[yame] could not attach the engine to a job object: {err}");
                }
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = child;
        }
    }

    /// Terminate the whole group. The caller still reaps the direct child.
    pub fn terminate(&self, child: &mut Child) {
        #[cfg(unix)]
        {
            // Signal the group first, then the process itself as belt and
            // braces — the group may not have been created (e.g. a tested
            // child that was never spawned through `engine::start`).
            let pid = child.id() as i32;
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
            let _ = child.kill();
        }
        #[cfg(target_os = "windows")]
        {
            // Taking the handle out drops it, and closing the job is what kills
            // the tree. `child.kill` stays as the fallback for when the
            // assignment above never happened.
            let taken = {
                let mut guard = self.job.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
                guard.take()
            };
            drop(taken);
            let _ = child.kill();
        }
        #[cfg(all(not(unix), not(target_os = "windows")))]
        {
            let _ = child.kill();
        }
    }
}

impl Default for ProcessGroup {
    fn default() -> Self {
        Self::new()
    }
}

/// A Windows Job Object configured to kill its members when it is closed.
#[cfg(target_os = "windows")]
struct JobHandle(windows_sys::Win32::Foundation::HANDLE);

// The handle is only ever used to assign once and then closed; Windows handles
// are process-wide, so moving it between threads is sound.
#[cfg(target_os = "windows")]
unsafe impl Send for JobHandle {}
#[cfg(target_os = "windows")]
unsafe impl Sync for JobHandle {}

#[cfg(target_os = "windows")]
impl JobHandle {
    fn create() -> Option<Self> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            // HANDLE is a raw pointer in windows-sys; a failed call returns null.
            if handle.is_null() {
                return None;
            }

            // KILL_ON_JOB_CLOSE is the whole point: it makes the tree's lifetime
            // follow the handle's, so a YAME crash still cleans up.
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                windows_sys::Win32::Foundation::CloseHandle(handle);
                return None;
            }
            Some(Self(handle))
        }
    }

    fn assign(&self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;

        let ok = unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as _) };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
impl Drop for JobHandle {
    fn drop(&mut self) {
        // Closing the handle terminates every process still in the job, because
        // of the limit flag set in `create`.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}
