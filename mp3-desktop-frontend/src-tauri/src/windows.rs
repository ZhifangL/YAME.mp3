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
