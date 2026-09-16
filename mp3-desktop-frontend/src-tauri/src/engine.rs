//! Sidecar supervision for the Python engine.
//!
//! YAME's engine is a FastAPI app frozen with PyInstaller. This module
//! picks a free loopback port, launches the binary bound to it, and makes sure
//! the whole process group dies with the app.
//!
//! The port is chosen *before* the webview exists, so the origin can be handed
//! to the frontend through an initialization script — the UI then polls
//! `/api/health` until the engine answers, which means the window can appear
//! instantly instead of waiting on Python startup.
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

/// Where the engine lives once it is running, and the handle to stop it.
pub struct Engine {
    pub origin: String,
    child: Mutex<Option<Child>>,
    /// False when we attached to an engine somebody else started (dev mode).
    owned: bool,
}

/// Ask the OS for an unused loopback port.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|addr| addr.port())
        .unwrap_or(8000)
}

/// Locate the sidecar binary.
///
/// In a bundled app Tauri places `externalBin` files next to the executable
/// (inside `Contents/MacOS/` on macOS). During `tauri dev` they live in
/// `src-tauri/binaries/` with the target-triple suffix Tauri requires.
fn sidecar_path() -> Option<PathBuf> {
    let name = "yame-engine";

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bundled = dir.join(name);
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("{}-{}", name, env!("TARGET_TRIPLE")));
    dev.is_file().then_some(dev)
}

/// The port a developer's manually started engine published, if any.
fn published_port() -> Option<u16> {
    if let Ok(explicit) = std::env::var("YAME_PORT") {
        if let Ok(port) = explicit.parse() {
            return Some(port);
        }
    }
    let config_dir = std::env::var("YAME_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/yame")
        });
    std::fs::read_to_string(config_dir.join("engine.port"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

fn forward_output<R: std::io::Read + Send + 'static>(stream: R, label: &'static str) {
    std::thread::spawn(move || {
        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            println!("[{label}] {line}");
        }
    });
}

/// Start (or attach to) the engine and return where to reach it.
pub fn start() -> Engine {
    let port = free_port();
    let origin = format!("http://127.0.0.1:{port}");

    let Some(binary) = sidecar_path() else {
        // No bundled engine (a plain `tauri dev` before the sidecar is built):
        // use whatever the developer already has running.
        let port = published_port().unwrap_or(8000);
        println!("[yame] no sidecar binary found; expecting an engine on port {port}");
        return Engine {
            origin: format!("http://127.0.0.1:{port}"),
            child: Mutex::new(None),
            owned: false,
        };
    };

    let mut command = Command::new(&binary);
    command
        .env("YAME_PORT", port.to_string())
        // The engine watches this and exits if we disappear; a crash or a
        // force-quit never runs our shutdown path.
        .env("YAME_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Own process group: the PyInstaller one-file bootloader forks the real
    // server, so signalling only the direct child would orphan it.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    match command.spawn() {
        Ok(mut child) => {
            if let Some(out) = child.stdout.take() {
                forward_output(out, "engine");
            }
            if let Some(err) = child.stderr.take() {
                forward_output(err, "engine");
            }
            println!("[yame] engine started on {origin}");
            Engine {
                origin,
                child: Mutex::new(Some(child)),
                owned: true,
            }
        }
        Err(err) => {
            eprintln!("[yame] could not start the engine ({err}); falling back to port 8000");
            Engine {
                origin: "http://127.0.0.1:8000".to_string(),
                child: Mutex::new(None),
                owned: false,
            }
        }
    }
}

impl Engine {
    /// Stop the engine, if this app started it.
    pub fn stop(&self) {
        if !self.owned {
            return;
        }
        let mut guard = match self.child.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let Some(mut child) = guard.take() else { return };

        #[cfg(unix)]
        {
            // Signal the group, then the process itself as a belt-and-braces.
            let pid = child.id() as i32;
            unsafe {
                libc::kill(-pid, libc::SIGTERM);
            }
            let _ = child.kill();
        }
        #[cfg(not(unix))]
        {
            let _ = child.kill();
        }
        let _ = child.wait();
        println!("[yame] engine stopped");
    }
}
