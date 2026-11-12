//! Sidecar supervision for the Python engine.
//!
//! YAME's engine is a FastAPI app frozen with PyInstaller. This module
//! picks a free loopback port, launches the binary bound to it, and makes sure
//! the whole process group dies with the app.
//!
//! The port is chosen *before* the webview exists, so the origin can be handed
//! to the frontend through an initialization script — the UI then polls
//! `/api/rules/registry` until the engine answers, which means the window can
//! appear instantly instead of waiting on Python startup.
use std::io::{BufRead, BufReader};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use crate::process_group::ProcessGroup;

/// Where the engine lives once it is running, and the handle to stop it.
pub struct Engine {
    pub origin: String,
    child: Mutex<Option<Child>>,
    /// Everything the engine forked dies with this (process group / job object).
    group: ProcessGroup,
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

/// The engine, embedded in this executable at build time.
///
/// This is what makes the portable build a single file: rather than shipping
/// `YAME.exe` *and* `yame-engine.exe` — which invites the two to be separated,
/// renamed by a browser's duplicate-name suffix, or just look like clutter —
/// the engine travels inside the app and is unpacked on first run.
///
/// The `cfg` is set by `build.rs` only when a real (non-empty) sidecar was
/// present, so a compile-only checkout embeds nothing instead of a stub.
#[cfg(embed_sidecar)]
static EMBEDDED_ENGINE: &[u8] = include_bytes!(env!("YAME_SIDECAR_PATH"));

/// Where an unpacked embedded engine lives.
///
/// Per-user application data, not the temp directory: a temp cleaner must not
/// be able to delete the engine out from under a running app, and the path
/// stays stable across launches so the file is written once rather than every
/// time. Windows and macOS both give each user their own tree.
#[cfg(embed_sidecar)]
fn unpack_dir() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        std::env::var("LOCALAPPDATA").ok().map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home_dir().map(|home| home.join("Library").join("Application Support"))
    } else {
        std::env::var("XDG_CACHE_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|home| home.join(".cache")))
    }?;
    // The version is in the path so an upgrade cannot leave a stale engine
    // behind that the new app then runs.
    Some(base.join("YAME").join("engine").join(env!("CARGO_PKG_VERSION")))
}

/// The engine binary's own file name on this platform.
///
/// Three places name this file and they must agree: `build.rs` stages
/// `<name>-<triple>` in `binaries/`, [`unpack_embedded_engine`] writes `<name>`
/// into the per-user directory, and [`sidecar_path`] looks for both. A mismatch
/// is not a compile error — it shows up as a silent "no bundled engine", which
/// is exactly what a missing `.exe` did to Windows `tauri dev`.
fn engine_exe_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "yame-engine.exe"
    } else {
        "yame-engine"
    }
}

/// The name `scripts/build-sidecar.mjs` stages the engine under for a target
/// triple — the same name `build.rs` compiles in with `include_bytes!`.
///
/// Split out from [`sidecar_path`] so the naming rule is testable without
/// touching the filesystem, and so the suffix is derived in exactly one place:
/// `build.rs` decides it from the triple string, and this must not disagree.
fn staged_sidecar_name(triple: &str) -> String {
    let suffix = if triple.contains("windows") { ".exe" } else { "" };
    format!("yame-engine-{triple}{suffix}")
}

/// Write the embedded engine to disk, reusing an existing copy when it matches.
///
/// Returns None when there is nothing embedded, so the caller falls back to the
/// sidecar file (the installed layout) and then to a developer's own engine.
#[cfg(embed_sidecar)]
fn unpack_embedded_engine() -> Option<PathBuf> {
    let dir = unpack_dir()?;
    let name = engine_exe_name();
    let target = dir.join(name);

    // Size is enough to tell "already unpacked from this build" from "partial
    // write" or "an older engine": the bytes are the same on every run.
    if let Ok(meta) = std::fs::metadata(&target) {
        if meta.len() == EMBEDDED_ENGINE.len() as u64 {
            return Some(target);
        }
    }

    std::fs::create_dir_all(&dir).ok()?;
    // Write beside the target and rename, so a crash mid-write cannot leave a
    // half-written engine that the next launch would happily execute.
    let staging = dir.join(format!("{name}.new"));
    std::fs::write(&staging, EMBEDDED_ENGINE).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o755));
    }
    std::fs::rename(&staging, &target).ok()?;
    println!("[yame] unpacked the engine to {}", target.display());
    Some(target)
}

#[cfg(not(embed_sidecar))]
fn unpack_embedded_engine() -> Option<PathBuf> {
    None
}

/// Locate the sidecar binary.
///
/// Three places, in order of preference:
///
/// 1. an engine unpacked from this executable (the shipped single-file build);
/// 2. `yame-engine[.exe]` sitting next to the executable — the layout Tauri's
///    `externalBin` used to produce, kept so an engine placed beside an
///    installed app still wins over a developer's staged copy;
/// 3. `src-tauri/binaries/`, where `scripts/build-sidecar.mjs` stages the engine
///    as `yame-engine-<triple>[.exe]` — the same file this build embeds, and what
///    `tauri dev` runs against.
///
/// Returning None means "no bundled engine": `start` then attaches to whatever
/// a developer already has running.
fn sidecar_path() -> Option<PathBuf> {
    if let Some(unpacked) = unpack_embedded_engine() {
        return Some(unpacked);
    }

    let name = engine_exe_name();

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
        .join(staged_sidecar_name(env!("TARGET_TRIPLE")));
    dev.is_file().then_some(dev)
}

/// The home directory, on every platform.
///
/// Windows has no `HOME`; it uses `USERPROFILE`. Falling back matters here
/// because an unset `HOME` silently produced a *relative* `.config/yame` path,
/// so a Windows developer's engine port file was never found.
fn home_dir() -> Option<PathBuf> {
    for name in ["HOME", "USERPROFILE"] {
        if let Ok(value) = std::env::var(name) {
            if !value.is_empty() {
                return Some(PathBuf::from(value));
            }
        }
    }
    None
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
        .ok()
        .or_else(|| home_dir().map(|home| home.join(".config").join("yame")))?;
    std::fs::read_to_string(config_dir.join("engine.port"))
        .ok()?
        .trim()
        .parse()
        .ok()
}

/// Where the engine and its supervisor write diagnostics.
///
/// A packaged GUI app has no console, so anything the sidecar prints used to be
/// thrown away — which is why a user's "Cannot reach the YAME engine" arrived
/// with no explanation attached. The engine writes application-level lines to
/// `<config>/engine.log`; this appends the sidecar's raw stdout/stderr to the
/// same file, so one file tells the whole story of a failed launch.
fn diagnostic_log_path() -> Option<PathBuf> {
    let config_dir = std::env::var("YAME_CONFIG_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(|| home_dir().map(|home| home.join(".config").join("yame")))?;
    std::fs::create_dir_all(&config_dir).ok()?;
    Some(config_dir.join("engine.log"))
}

/// Append a supervisor line to the diagnostic log, ignoring any failure.
///
/// Used for the moments that leave no other trace: a launch attempt, the
/// resolved sidecar path, a spawn error. Without them a log that ends after the
/// engine's own startup says nothing about who was at fault.
fn note(message: &str) {
    use std::io::Write;

    let Some(path) = diagnostic_log_path() else { return };
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[yame] {message}");
    }
}

/// Copy a stream to stdout *and* the diagnostic log.
///
/// Both, not either: stdout is what a developer sees in `tauri dev`, and the
/// file is what survives on a machine we cannot inspect.
fn forward_output<R: std::io::Read + Send + 'static>(stream: R, label: &'static str) {
    std::thread::spawn(move || {
        use std::io::Write;

        let mut log = diagnostic_log_path().and_then(|path| {
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .ok()
        });

        for line in BufReader::new(stream).lines().map_while(Result::ok) {
            println!("[{label}] {line}");
            if let Some(file) = log.as_mut() {
                // Best effort: a full disk must not take the engine down.
                let _ = writeln!(file, "[{label}] {line}");
            }
        }
    });
}

/// Start (or attach to) the engine and return where to reach it.
pub fn start() -> Engine {
    let port = free_port();
    let origin = format!("http://127.0.0.1:{port}");

    // One line marking a launch attempt, so a log with nothing after it means
    // the sidecar never ran at all — which is a different bug from a sidecar
    // that ran and failed.
    note(&format!(
        "launching engine on port {port} (app pid {})",
        std::process::id()
    ));

    let Some(binary) = sidecar_path() else {
        // No bundled engine (a plain `tauri dev` before the sidecar is built):
        // use whatever the developer already has running.
        let port = published_port().unwrap_or(8000);
        note("no sidecar binary found; expecting an engine already running");
        println!("[yame] no sidecar binary found; expecting an engine on port {port}");
        return Engine {
            origin: format!("http://127.0.0.1:{port}"),
            child: Mutex::new(None),
            group: ProcessGroup::new(),
            owned: false,
        };
    };

    note(&format!("sidecar binary: {}", binary.display()));

    let mut command = Command::new(&binary);
    command
        .env("YAME_PORT", port.to_string())
        // The engine watches this and exits if we disappear; a crash or a
        // force-quit never runs our shutdown path.
        .env("YAME_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Own process group on Unix: the PyInstaller one-file bootloader forks the
    // real server, so signalling only the direct child would orphan it. Windows
    // uses a job object instead, applied in `adopt` below — processes inherit
    // their parent's job, so it covers the forked server too.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }

    let group = ProcessGroup::new();

    match command.spawn() {
        Ok(mut child) => {
            group.adopt(&child);
            if let Some(out) = child.stdout.take() {
                forward_output(out, "engine");
            }
            if let Some(err) = child.stderr.take() {
                forward_output(err, "engine");
            }
            println!("[yame] engine started on {origin}");
            note(&format!("spawned sidecar (pid {})", child.id()));
            Engine {
                origin,
                child: Mutex::new(Some(child)),
                group,
                owned: true,
            }
        }
        Err(err) => {
            // The most valuable line in the file: the sidecar exists but the OS
            // refused to run it (missing, not executable, blocked by policy).
            note(&format!("could not start the engine: {err}"));
            eprintln!("[yame] could not start the engine ({err}); falling back to port 8000");
            Engine {
                origin: "http://127.0.0.1:8000".to_string(),
                child: Mutex::new(None),
                group,
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

        // Terminates the whole group — the bootloader *and* the server it
        // forked — then we reap the direct child so no zombie is left.
        self.group.terminate(&mut child);
        let _ = child.wait();
        println!("[yame] engine stopped");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The staged name is what `build.rs` embeds, so it must be byte-identical
    /// to what `scripts/build-sidecar.mjs` writes: `<name>-<triple>`, plus
    /// `.exe` — after the triple — on Windows.
    #[test]
    fn the_staged_name_is_the_triple_suffixed_engine() {
        assert_eq!(
            staged_sidecar_name("aarch64-apple-darwin"),
            "yame-engine-aarch64-apple-darwin"
        );
        assert_eq!(
            staged_sidecar_name("x86_64-unknown-linux-gnu"),
            "yame-engine-x86_64-unknown-linux-gnu"
        );
        assert_eq!(
            staged_sidecar_name("x86_64-pc-windows-msvc"),
            "yame-engine-x86_64-pc-windows-msvc.exe"
        );
    }

    /// The two halves of the naming rule are derived differently — `build.rs`
    /// and `staged_sidecar_name` read the target *triple*, `engine_exe_name`
    /// reads `cfg!(target_os)` — and they have to agree on the platform being
    /// built. When they did not, a Windows dev build looked for
    /// `yame-engine-<triple>` while the staged file was `…-<triple>.exe`, and
    /// the shell silently attached to a port with nothing on it instead.
    #[test]
    fn the_suffix_rules_agree_on_this_target() {
        assert_eq!(
            staged_sidecar_name(env!("TARGET_TRIPLE")).ends_with(".exe"),
            cfg!(target_os = "windows"),
        );
        assert_eq!(
            engine_exe_name().ends_with(".exe"),
            cfg!(target_os = "windows"),
        );
    }

    /// The standalone name is the unpacked one, so it takes the `.exe` but not
    /// the triple.
    #[test]
    fn the_standalone_name_carries_the_triple_only_when_staged() {
        let standalone = engine_exe_name();
        assert!(!standalone.contains(env!("TARGET_TRIPLE")));
        assert!(standalone.starts_with("yame-engine"));
        assert_eq!(
            standalone,
            if cfg!(target_os = "windows") { "yame-engine.exe" } else { "yame-engine" }
        );
    }
}
