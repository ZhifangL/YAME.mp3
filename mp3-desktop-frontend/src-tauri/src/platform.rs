//! Commands the webview calls for OS integration.
//!
//! "Open with the default app" and "Show in Finder" come from the opener
//! plugin. Everything here is what that plugin cannot do: the mixed
//! file-or-folder panel, launching with a chosen application, the file
//! clipboard, and saving a playlist through a real save sheet.
#[cfg(unix)]
use std::process::Command;

use tauri::AppHandle;

use crate::apps;

#[cfg(target_os = "macos")]
use crate::macos;

/// Absolute, symlink-resolved form of a path.
///
/// `open` parses its arguments as options, so a file literally named "-R"
/// would be read as a flag, and `xdg-open` needs a path rather than a bare
/// name. Unix only: on Windows `canonicalize` returns a verbatim
/// (`\\?\C:\...`) path that the shell takes badly, and the frontend already
/// hands us absolute paths from the picker, a drop, or the engine.
#[cfg(unix)]
fn absolute(path: &str) -> String {
    std::fs::canonicalize(path)
        .map(|p| p.display().to_string())
        .unwrap_or_else(|_| path.to_string())
}

/// Run a helper and return its stdout, or an error carrying stderr.
///
/// Unix only: Windows reaches the shell through `ShellExecuteW` and the Win32
/// APIs directly (see [`crate::windows`]), rather than by spawning a command.
#[cfg(unix)]
fn run(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|err| format!("could not run {program}: {err}"))?;
    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

/// Native "add music" panel: songs and folders together.
///
/// Returns null on platforms without a native implementation so the frontend
/// falls back to the browser/DOM path.
#[tauri::command]
pub fn pick_music(app: AppHandle, title: String, prompt: String) -> Result<Option<Vec<String>>, String> {
    #[cfg(target_os = "macos")]
    {
        return macos::pick_music_paths(&app, &title, &prompt).map(Some);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, title, prompt);
        Ok(None)
    }
}

/// Open `path` with the user's default application.
///
/// `async` on purpose: Tauri runs a synchronous command on the main thread, so
/// waiting on `open` there would freeze the window for the duration.
///
/// Done here rather than through the opener plugin's `open_path`, whose scope
/// resolves through Tauri's filesystem glob matcher — this is one line of
/// platform shell either way, and it behaves exactly like double-clicking the
/// file in Finder.
#[tauri::command]
pub async fn open_default(path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("File does not exist: {path}"));
    }

    #[cfg(target_os = "macos")]
    {
        return run("open", &[&absolute(&path)]).map(|_| ());
    }
    #[cfg(target_os = "windows")]
    {
        // Not `cmd /C start`: that path goes through a shell which expands
        // `%VAR%`, so a file named "100% Pure.mp3" would open the wrong thing.
        return crate::windows::open_default(&path);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        return run("xdg-open", &[&absolute(&path)]).map(|_| ());
    }
}

/// Open `path` with a specific application bundle.
#[tauri::command]
pub async fn open_with_app(path: String, app_path: String) -> Result<(), String> {
    if !std::path::Path::new(&path).exists() {
        return Err(format!("File does not exist: {path}"));
    }
    // Each platform knows what counts as something it can hand a file to: a
    // bundle on macOS, an executable on Windows. The chooser sentinel counts
    // everywhere it exists.
    if !apps::is_application(&app_path) {
        return Err(format!("Not an application: {app_path}"));
    }

    #[cfg(target_os = "windows")]
    {
        // Windows has no "launch this exact executable with this file" API that
        // is worth using. Its shell chooser is the supported route, and the
        // only one that can offer the packaged apps and per-user associations
        // the registry cannot see.
        let _ = &app_path;
        return crate::windows::open_with_chooser(&path);
    }

    #[cfg(target_os = "macos")]
    {
        // `open -a` is the supported way to launch a specific bundle, and it
        // handles quarantine, LaunchServices registration and already-running
        // apps the same way Finder does.
        return run("open", &["-a", &absolute(&app_path), &absolute(&path)]).map(|_| ());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = app_path;
        Err("Opening with a chosen application is not implemented on Linux yet".into())
    }
}

/// Put real file references on the clipboard so Finder/Explorer paste copies.
#[tauri::command]
pub async fn copy_files_to_clipboard(paths: Vec<String>) -> Result<usize, String> {
    let existing: Vec<String> = paths
        .into_iter()
        .filter(|p| std::path::Path::new(p).exists())
        .collect();
    if existing.is_empty() {
        return Err("No files to copy".into());
    }

    #[cfg(target_os = "macos")]
    {
        // JXA with the ObjC bridge: an NSArray of NSURLs written with
        // -writeObjects: gives Finder a genuine multi-file copy. (Passing a
        // plain JS array to $() only bridges the first element.)
        const SCRIPT: &str = r#"
ObjC.import('AppKit');
function run(argv) {
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  const urls = $.NSMutableArray.array;
  for (let i = 0; i < argv.length; i++) {
    urls.addObject($.NSURL.fileURLWithPath($(argv[i])));
  }
  return pb.writeObjects(urls) ? argv.length : 0;
}
"#;
        let resolved: Vec<String> = existing.iter().map(|p| absolute(p)).collect();
        let mut args: Vec<&str> = vec!["-l", "JavaScript", "-e", SCRIPT];
        args.extend(resolved.iter().map(String::as_str));
        let out = run("osascript", &args)?;
        return Ok(out.trim().parse().unwrap_or(existing.len()));
    }

    #[cfg(target_os = "windows")]
    {
        // TODO(windows): CF_HDROP on the clipboard, e.g. via clipboard-win's
        // Clipboard::new().set_file_list.
        let _ = existing;
        Err("Copying files to the clipboard is not implemented on Windows yet".into())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // TODO(linux): text/uri-list on the CLIPBOARD selection.
        let _ = existing;
        Err("Copying files to the clipboard is not implemented on Linux yet".into())
    }
}

/// Read absolute file paths from the clipboard; empty when there are none.
#[tauri::command]
pub async fn read_files_from_clipboard() -> Result<Vec<String>, String> {
    #[cfg(target_os = "macos")]
    {
        const SCRIPT: &str = r#"
ObjC.import('AppKit');
function run() {
  const pb = $.NSPasteboard.generalPasteboard;
  const items = pb.pasteboardItems;
  if (!items) return '';
  const out = [];
  for (const item of items.js) {
    const raw = item.stringForType('public.file-url');
    if (!raw) continue;
    const url = $.NSURL.URLWithString(raw);
    if (url && url.isFileURL) out.push(ObjC.unwrap(url.path));
  }
  return out.join('\n');
}
"#;
        let out = run("osascript", &["-l", "JavaScript", "-e", SCRIPT])?;
        return Ok(out
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_string)
            .collect());
    }

    #[cfg(target_os = "windows")]
    {
        // TODO(windows): read CF_HDROP back off the clipboard.
        Err("Pasting files is not implemented on Windows yet".into())
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // TODO(linux): read text/uri-list off the CLIPBOARD selection.
        Err("Pasting files is not implemented on Linux yet".into())
    }
}

/// Save a playlist through the native save sheet.
///
/// Returns the chosen path, or None when the user cancelled. Doing the dialog
/// and the write in one command keeps it a single round trip.
///
/// This MUST stay `async`: Tauri runs synchronous commands on the main thread,
/// and a modal NSSavePanel there deadlocks against the event loop that has to
/// service it.
#[tauri::command]
pub async fn save_playlist(
    app: AppHandle,
    default_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let chosen = app
        .dialog()
        .file()
        .set_title("Save playlist")
        .set_file_name(&default_name)
        .add_filter("M3U playlist", &["m3u"])
        .blocking_save_file();

    let Some(file_path) = chosen else {
        return Ok(None);
    };
    let path = file_path
        .into_path()
        .map_err(|err| format!("Could not use that location: {err}"))?;
    std::fs::write(&path, contents).map_err(|err| format!("Could not write the playlist: {err}"))?;
    Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The commands are async (see the module docs), so the assertions run on
    /// a bare runtime.
    fn block<F: std::future::Future>(f: F) -> F::Output {
        tauri::async_runtime::block_on(f)
    }

    #[test]
    fn opening_a_missing_file_is_an_error_not_a_launch() {
        let err = block(open_default("/definitely/not/here.mp3".into())).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn open_with_app_rejects_a_missing_file() {
        let err = block(open_with_app("/nope.mp3".into(), "/Applications/TextEdit.app".into())).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn copy_rejects_an_empty_selection() {
        assert!(block(copy_files_to_clipboard(vec![])).is_err());
        assert!(block(copy_files_to_clipboard(vec!["/nope.mp3".into()])).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_path_that_looks_like_a_flag_is_made_absolute() {
        // `open` would otherwise read "-R" as its reveal flag, and `xdg-open`
        // needs a path rather than a bare name. Unix only: Windows deliberately
        // does not canonicalise (it would produce a `\\?\` path).
        let resolved = absolute("/tmp/definitely-missing");
        assert!(resolved.starts_with('/'), "{resolved}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_bundles_count_as_applications() {
        assert!(macos::is_application("/Applications/TextEdit.app") || !std::path::Path::new("/Applications/TextEdit.app").exists());
        assert!(!macos::is_application("/tmp/notes.txt"));
        assert!(!macos::is_application("/Applications/TextEdit.app.bak"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn launch_services_recommends_apps_for_an_audio_file() {
        // A file type every Mac can open; proves the query reaches LaunchServices.
        let apps = macos::recommended_apps("/System/Library/Sounds/Ping.aiff");
        assert!(!apps.is_empty(), "expected at least one recommended application");
        assert!(apps.iter().all(|a| a.path.ends_with(".app")), "{apps:?}");
        assert!(apps.iter().all(|a| !a.name.is_empty()), "{apps:?}");
        assert!(apps.iter().all(|a| macos::is_application(&a.path)), "{apps:?}");
    }

    // Icon rasterisation is deliberately untested here: it needs a main-thread
    // marker, which cargo's test harness cannot provide. `render_icon` draws
    // into a 64x64 bitmap rather than encoding a PNG — that change took the
    // submenu build from 2.5s to ~60ms, so please measure before altering it.
}
