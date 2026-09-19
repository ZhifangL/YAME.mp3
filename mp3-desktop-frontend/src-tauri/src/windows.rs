//! Windows-specific support that a webview cannot reach.
//!
//! The counterpart to [`crate::macos`]: each module owns the calls that only
//! make sense on its own platform, and the commands in [`crate::platform`] pick
//! between them with a `cfg`. Nothing here talks to the frontend directly.
#![cfg(target_os = "windows")]

use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::System::Registry::{
    RegCloseKey, RegEnumKeyExW, RegEnumValueW, RegOpenKeyExW, RegQueryValueExW, HKEY,
    HKEY_CLASSES_ROOT, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_EXPAND_SZ, REG_SZ,
};
use windows_sys::Win32::UI::Shell::{
    ShellExecuteW, SHOpenWithDialog, OAIF_ALLOW_REGISTRATION, OAIF_EXEC, OPENASINFO,
};
use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// Sentinel "application" meaning *ask the user*, rather than naming an
/// executable. The frontend reports it as the Open With entry.
pub const CHOOSE_APP: &str = "__choose__";

/// How Windows itself words that entry.
pub const CHOOSE_APP_LABEL: &str = "Choose another app";

/// NUL-terminated UTF-16, for the wide Win32 entry points.
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Open `path` with whatever the user has associated with it.
///
/// `ShellExecuteW` with the "open" verb is what double-clicking the file in
/// Explorer does. Deliberately not `cmd /C start`: that goes through a shell
/// which expands `%VAR%` and needs quoting rules of its own, so `100% Pure.mp3`
/// would open the wrong thing — and it flashes a console for good measure.
pub fn open_default(path: &str) -> Result<(), String> {
    let file = wide(path);
    let verb = wide("open");
    // SW_SHOWNORMAL: the application decides its own state, as a double-click
    // would. A return value above 32 means success; the low values are the
    // documented error codes.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            file.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err(format!("Windows could not open {path} (code {}).", result as isize));
    }
    Ok(())
}

/// Show the shell's own Open With dialog for `path`.
///
/// Deliberately *not* `rundll32 shell32.dll,OpenAs_RunDLL` via `cmd /C start`:
/// that routes the path through a shell which expands `%VAR%` and whose quoting
/// rules `rundll32` does not undo, so `100% Pure.mp3` or `My Song.mp3` could
/// open the wrong thing or nothing at all. `SHOpenWithDialog` takes the path as
/// a proper UTF-16 argument, is the documented API for this, and spawns no
/// console.
pub fn open_with_chooser(path: &str) -> Result<(), String> {
    let file = wide(path);
    let info = OPENASINFO {
        pcszFile: file.as_ptr(),
        pcszClass: std::ptr::null(),
        // ALLOW_REGISTRATION is what makes "Always use this app" work, so the
        // choice sticks for the next file too.
        oaifInFlags: OAIF_ALLOW_REGISTRATION | OAIF_EXEC,
    };

    // A null parent lets the shell use the foreground window.
    let hr = unsafe { SHOpenWithDialog(std::ptr::null_mut(), &info) };
    if hr < 0 {
        return Err(format!("Windows could not open the Open With dialog (0x{hr:08X})."));
    }
    Ok(())
}

/// Applications the registry associates with `path`'s extension.
///
/// Best effort by design. Windows 10 and 11 keep most per-user choices — and
/// every packaged app — outside the classes hive, so this list is often short
/// or empty. That is why the menu always offers [`CHOOSE_APP_LABEL`] alongside
/// it: the shell's dialog knows about applications this cannot see.
pub fn recommended_apps(path: &str) -> Vec<(String, String)> {
    let Some(ext) = extension_of(path) else {
        return Vec::new();
    };

    let mut found: Vec<(String, String)> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    let push = |prog_id: &str, found: &mut Vec<(String, String)>, seen: &mut Vec<String>| {
        if let Some((name, exe)) = resolve_prog_id(prog_id) {
            let key = exe.to_ascii_lowercase();
            if !seen.contains(&key) {
                seen.push(key);
                found.push((name, exe));
            }
        }
    };

    // Both hives: HKCR merges machine and user associations, HKCU adds the
    // per-user choices the user made themselves.
    for hive in [HKEY_CLASSES_ROOT, HKEY_CURRENT_USER] {
        for prog_id in subkey_names(hive, &format!("{ext}\\OpenWithList")) {
            push(&prog_id, &mut found, &mut seen);
        }
        for prog_id in value_names(hive, &format!("{ext}\\OpenWithProgids")) {
            push(&prog_id, &mut found, &mut seen);
        }
    }

    found
}

/// The lower-case extension of a path, including the dot.
fn extension_of(path: &str) -> Option<String> {
    Path::new(path)
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_ascii_lowercase()))
}

/// Display name and executable for a programmatic identifier, if usable.
fn resolve_prog_id(prog_id: &str) -> Option<(String, String)> {
    // A ProgID's default value is its friendly description; a bare executable
    // name has none.
    let description = default_value(HKEY_CLASSES_ROOT, prog_id).unwrap_or_default();
    let exe = default_value(HKEY_CLASSES_ROOT, &format!("{prog_id}\\shell\\open\\command"))
        .and_then(|command| executable_from_command(&command))?;
    let path = resolve_executable_path(&exe)?;

    let name = if description.trim().is_empty() || description.eq_ignore_ascii_case(prog_id) {
        Path::new(&path)
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_else(|| prog_id.to_string())
    } else {
        description
    };
    Some((name, path))
}

/// Pull the program out of a shell command line.
///
/// These are `"C:\Program Files\App\app.exe" "%1"` or `C:\App\app.exe %1`, so a
/// quoted program is taken verbatim and an unquoted one stops after `.exe`.
fn executable_from_command(command: &str) -> Option<String> {
    let trimmed = command.trim().trim_matches('"');
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    match lower.find(".exe") {
        Some(index) => Some(trimmed[..index + 4].to_string()),
        None => trimmed.split_whitespace().next().map(str::to_string),
    }
}

/// Turn an executable name into a path that exists, or give up.
///
/// `App Paths` is the registry's own answer for "where is this program?", which
/// is how a bare name like `wmplayer.exe` resolves without searching the disk.
fn resolve_executable_path(exe: &str) -> Option<String> {
    let candidate = PathBuf::from(exe);
    if candidate.is_absolute() {
        return candidate.is_file().then(|| candidate.display().to_string());
    }
    let app_path = default_value(
        HKEY_LOCAL_MACHINE,
        &format!("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{exe}"),
    )?;
    let resolved = PathBuf::from(app_path.trim().trim_matches('"'));
    resolved.is_file().then(|| resolved.display().to_string())
}

/// One string value from a key, or None when the key or value is absent.
fn string_value(hive: HKEY, subkey: &str, value: Option<&str>) -> Option<String> {
    let key = wide(subkey);
    let mut handle: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(hive, key.as_ptr(), 0, KEY_READ, &mut handle) } != ERROR_SUCCESS {
        return None;
    }

    let name = value.map(wide);
    let name_ptr = name.as_ref().map_or(std::ptr::null(), |n| n.as_ptr());

    // Ask for the size first: registry values are not length-prefixed.
    let mut kind: u32 = 0;
    let mut size: u32 = 0;
    let sized = unsafe {
        RegQueryValueExW(handle, name_ptr, std::ptr::null(), &mut kind, std::ptr::null_mut(), &mut size)
    };
    if sized != ERROR_SUCCESS || size == 0 {
        unsafe { RegCloseKey(handle) };
        return None;
    }

    let mut buffer = vec![0u8; size as usize];
    let read = unsafe {
        RegQueryValueExW(handle, name_ptr, std::ptr::null(), &mut kind, buffer.as_mut_ptr(), &mut size)
    };
    unsafe { RegCloseKey(handle) };
    if read != ERROR_SUCCESS {
        return None;
    }

    match kind {
        REG_SZ | REG_EXPAND_SZ => {
            let utf16: Vec<u16> = buffer
                .chunks_exact(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .take_while(|unit| *unit != 0)
                .collect();
            Some(String::from_utf16_lossy(&utf16))
        }
        _ => None,
    }
}

fn default_value(hive: HKEY, subkey: &str) -> Option<String> {
    string_value(hive, subkey, None)
}

/// The names of a key's values (its `OpenWithProgids` entries, say).
fn value_names(hive: HKEY, subkey: &str) -> Vec<String> {
    let key = wide(subkey);
    let mut handle: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(hive, key.as_ptr(), 0, KEY_READ, &mut handle) } != ERROR_SUCCESS {
        return Vec::new();
    }

    let mut names = Vec::new();
    let mut index = 0u32;
    loop {
        let mut buffer = [0u16; 512];
        let mut length = buffer.len() as u32;
        let status = unsafe {
            RegEnumValueW(
                handle,
                index,
                buffer.as_mut_ptr(),
                &mut length,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            break;
        }
        // A nameless value cannot be a ProgID, so the default is skipped.
        if length > 0 {
            names.push(String::from_utf16_lossy(&buffer[..length as usize]));
        }
        index += 1;
    }
    unsafe { RegCloseKey(handle) };
    names
}

/// The names of a key's subkeys (its `OpenWithList` entries, say).
fn subkey_names(hive: HKEY, subkey: &str) -> Vec<String> {
    let key = wide(subkey);
    let mut handle: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(hive, key.as_ptr(), 0, KEY_READ, &mut handle) } != ERROR_SUCCESS {
        return Vec::new();
    }

    let mut names = Vec::new();
    let mut index = 0u32;
    loop {
        let mut buffer = [0u16; 512];
        let mut length = buffer.len() as u32;
        let status = unsafe {
            RegEnumKeyExW(
                handle,
                index,
                buffer.as_mut_ptr(),
                &mut length,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
            )
        };
        if status != ERROR_SUCCESS {
            break;
        }
        names.push(String::from_utf16_lossy(&buffer[..length as usize]));
        index += 1;
    }
    unsafe { RegCloseKey(handle) };
    names
}

/// Put file references on the clipboard as `CF_HDROP`, so Explorer pastes copies.
///
/// Built by hand rather than by pulling in a clipboard crate: the structure is
/// small and fixed (a `DROPFILES` header followed by a double-NUL-terminated
/// list of UTF-16 paths), and every API needed is one we already link against.
///
/// The memory is allocated with `GMEM_MOVEABLE` and handed to the clipboard,
/// which takes ownership on success — freeing it afterwards would corrupt the
/// clipboard, so the failure path is the only one that cleans up.
pub fn set_clipboard_files(paths: &[String]) -> Result<usize, String> {
    use std::mem::size_of;

    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::DROPFILES;

    if paths.is_empty() {
        return Err("No files to copy".into());
    }

    // Header, then every path as UTF-16, then one extra NUL to end the list.
    let mut utf16: Vec<u16> = Vec::new();
    for path in paths {
        utf16.extend(path.encode_utf16());
        utf16.push(0);
    }
    utf16.push(0);

    let header = size_of::<DROPFILES>();
    let bytes = header + utf16.len() * size_of::<u16>();

    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return Err("Could not open the Windows clipboard.".into());
        }
        // From here on every exit must close the clipboard.
        let result = (|| -> Result<usize, String> {
            let handle = GlobalAlloc(GMEM_MOVEABLE, bytes);
            if handle.is_null() {
                return Err("Could not allocate clipboard memory.".into());
            }
            let base = GlobalLock(handle) as *mut u8;
            if base.is_null() {
                windows_sys::Win32::Foundation::GlobalFree(handle);
                return Err("Could not lock clipboard memory.".into());
            }

            let dropfiles = DROPFILES {
                // Offset of the file list from the start of the structure.
                pFiles: header as u32,
                pt: POINT { x: 0, y: 0 },
                fNC: 0,
                // The paths are UTF-16, which is what Explorer expects.
                fWide: 1,
            };
            std::ptr::copy_nonoverlapping(
                &dropfiles as *const DROPFILES as *const u8,
                base,
                header,
            );
            std::ptr::copy_nonoverlapping(
                utf16.as_ptr() as *const u8,
                base.add(header),
                utf16.len() * size_of::<u16>(),
            );
            GlobalUnlock(handle);

            if EmptyClipboard() == 0 {
                windows_sys::Win32::Foundation::GlobalFree(handle);
                return Err("Could not empty the Windows clipboard.".into());
            }
            if SetClipboardData(CF_HDROP as u32, handle).is_null() {
                // Ownership was not transferred, so this is ours to release.
                windows_sys::Win32::Foundation::GlobalFree(handle);
                return Err("Could not put the files on the Windows clipboard.".into());
            }
            // Success: the clipboard owns the memory now. Do not free it.
            Ok(paths.len())
        })();
        CloseClipboard();
        result
    }
}

/// Read file references off the clipboard, as Explorer's Copy puts them.
///
/// Returns an empty list when the clipboard holds no files at all. Anything
/// else on the clipboard (text, an image) is simply not a file list, and the
/// caller reports that as "no audio files on the clipboard" rather than an
/// error — that is what a user pressing Ctrl+V on a screenshot should see.
pub fn clipboard_files() -> Result<Vec<String>, String> {
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Ole::CF_HDROP;
    use windows_sys::Win32::UI::Shell::DragQueryFileW;

    if unsafe { IsClipboardFormatAvailable(CF_HDROP as u32) } == 0 {
        return Ok(Vec::new());
    }
    if unsafe { OpenClipboard(std::ptr::null_mut()) } == 0 {
        return Err("Could not open the Windows clipboard.".into());
    }

    let files = unsafe {
        let handle = GetClipboardData(CF_HDROP as u32);
        if handle.is_null() {
            Vec::new()
        } else {
            // 0xFFFFFFFF asks for the count rather than a name.
            let count = DragQueryFileW(handle, 0xFFFF_FFFF, std::ptr::null_mut(), 0);
            let mut out = Vec::with_capacity(count as usize);
            for index in 0..count {
                // First call for the length (excluding the terminator), then
                // for the characters themselves.
                let length = DragQueryFileW(handle, index, std::ptr::null_mut(), 0);
                if length == 0 {
                    continue;
                }
                let mut buffer = vec![0u16; length as usize + 1];
                let written = DragQueryFileW(handle, index, buffer.as_mut_ptr(), length + 1);
                if written > 0 {
                    out.push(String::from_utf16_lossy(&buffer[..written as usize]));
                }
            }
            out
        }
    };
    unsafe { CloseClipboard() };
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_is_lowercased_and_includes_the_dot() {
        assert_eq!(extension_of("C:\\Music\\Song.MP3").as_deref(), Some(".mp3"));
        assert_eq!(extension_of("C:\\Music\\Song.flac").as_deref(), Some(".flac"));
        assert_eq!(extension_of("C:\\Music\\no-extension"), None);
    }

    #[test]
    fn a_quoted_shell_command_yields_the_program() {
        assert_eq!(
            executable_from_command("\"C:\\Program Files\\App\\app.exe\" \"%1\"").as_deref(),
            Some("C:\\Program Files\\App\\app.exe")
        );
    }

    #[test]
    fn an_unquoted_shell_command_stops_after_the_exe() {
        assert_eq!(
            executable_from_command("C:\\App\\app.exe %1").as_deref(),
            Some("C:\\App\\app.exe")
        );
    }

    #[test]
    fn a_command_with_no_program_is_rejected() {
        assert_eq!(executable_from_command(""), None);
        assert_eq!(executable_from_command("   "), None);
    }

    #[test]
    fn a_prog_id_without_a_command_is_rejected() {
        assert_eq!(resolve_prog_id("NoSuchProgIdForYameTests"), None);
    }

    // `open_with_chooser` and `open_default` are deliberately untested here.
    // Both hand off to the shell, and `SHOpenWithDialog` does not validate the
    // path before showing — so "call it with a missing file and assert an
    // error" does not merely fail, it *blocks forever* on a machine with no one
    // to dismiss the dialog. That hung a CI runner for 40 minutes. Their
    // arguments are covered by the pure helpers above; the dialogs themselves
    // need a human, which is what ports/windows/CHECKLIST.md is for.
}
