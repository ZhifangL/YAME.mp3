//! Windows-specific support that a webview cannot reach.
//!
//! The counterpart to [`crate::macos`]: each module owns the calls that only
//! make sense on its own platform, and the commands in [`crate::platform`] pick
//! between them with a `cfg`. Nothing here talks to the frontend directly.
#![cfg(target_os = "windows")]

use std::process::Command;

/// Open `path` with a specific application.
///
/// There is no Windows equivalent of `open -a <bundle>`: the shell's own
/// Open With dialog is the documented route, and it is also the honest one —
/// the user sees the same chooser Explorer shows, including "Always use this
/// app", rather than YAME pretending to know how to launch every executable.
///
/// `app_path` is validated by the caller ([`crate::apps::is_application`]);
/// a bare executable path is still useful as the dialog's starting point.
pub fn open_with(app_path: &str, path: &str) -> Result<(), String> {
    // rundll32 treats commas as argument separators, and a comma is legal in a
    // Windows path, so a path containing one is refused rather than silently
    // opening the wrong thing.
    if app_path.contains(',') || path.contains(',') {
        return Err("This file's path contains a comma, which the Open With dialog cannot take.".into());
    }

    // `start` is a cmd builtin, hence the shell. The empty "" is the window
    // title: without it `start` would treat a quoted path as the title and
    // open a blank console instead.
    let output = Command::new("cmd")
        .args(["/C", "start", "", "rundll32.exe", "shell32.dll,OpenAs_RunDLL"])
        .arg(path)
        .output()
        .map_err(|err| format!("could not open the Open With dialog: {err}"))?;

    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(if stderr.is_empty() {
        "could not open the Open With dialog".to_string()
    } else {
        stderr
    })
}
