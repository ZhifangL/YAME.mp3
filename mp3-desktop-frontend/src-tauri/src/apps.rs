//! "Open With" support, and the seam that keeps the menu code platform-neutral.
//!
//! Enumerating the applications that can open a file is genuinely
//! platform-specific: macOS asks Launch Services, Windows asks the registry's
//! file associations, Linux has no standard answer at all. Everything *built*
//! from that list — the submenu, the icons, the item ids — is shared, so
//! `menu.rs` only ever sees this module's types and never a `cfg`.
//!
//! Each platform module exposes the same three things:
//!
//! * [`AppChoice`] — what to show and what to launch;
//! * `recommended_apps(path)` — the list for one file, best first;
//! * `app_icons(app, paths)` — raw RGBA squares for the list, `None` when an
//!   icon is unavailable (a menu item without an icon is perfectly valid).
//!
//! Icon side length: menu items display at roughly 16pt, so 64px covers Retina
//! with room to spare.

/// An application that can open a file.
///
/// A plain serialisable data type with no platform behaviour: the menu builder
/// turns each entry into an `openwith:<path>` item id, and the frontend hands
/// that path straight back to `open_with_app`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AppChoice {
    pub name: String,
    pub path: String,
}

/// Side of the square menu icons are rasterised into, in pixels.
///
/// Only macOS can draw an icon on a native menu item, so the rasteriser — and
/// this constant with it — is macOS-only.
#[cfg(target_os = "macos")]
pub const ICON_PX: u32 = 64;

#[cfg(target_os = "macos")]
mod imp {
    use super::AppChoice;
    use crate::macos;
    use tauri::{AppHandle, Runtime};

    pub fn recommended_apps(path: &str) -> Vec<AppChoice> {
        macos::recommended_apps(path)
    }

    pub fn app_icons<R: Runtime>(app: &AppHandle<R>, app_paths: &[String]) -> Vec<Option<Vec<u8>>> {
        macos::app_icons(app, app_paths)
    }

    /// True when this path is something we can hand a file to.
    pub fn is_application(app_path: &str) -> bool {
        macos::is_application(app_path)
    }
}

/// Windows asks the registry which applications claim the file's extension.
#[cfg(target_os = "windows")]
mod imp {
    use super::AppChoice;
    use tauri::{AppHandle, Runtime};

    pub fn recommended_apps(path: &str) -> Vec<AppChoice> {
        let mut choices: Vec<AppChoice> = crate::windows::recommended_apps(path)
            .into_iter()
            .map(|(name, path)| AppChoice { name, path })
            .collect();
        // Always offer the shell's own chooser. The registry's view of
        // associations is incomplete on Windows 10 and 11 — it cannot see
        // packaged apps or most per-user choices — so without this a user whose
        // player is not listed would have no route to it at all.
        choices.push(AppChoice {
            name: crate::windows::CHOOSE_APP_LABEL.to_string(),
            path: crate::windows::CHOOSE_APP.to_string(),
        });
        choices
    }

    pub fn app_icons<R: Runtime>(
        _app: &AppHandle<R>,
        app_paths: &[String],
    ) -> Vec<Option<Vec<u8>>> {
        // Tauri cannot put an icon on a Windows menu item, so asking for one
        // would be work with nowhere to go.
        vec![None; app_paths.len()]
    }

    pub fn is_application(app_path: &str) -> bool {
        if app_path == crate::windows::CHOOSE_APP {
            return true;
        }
        // An executable, or a shortcut the shell will resolve — accepting `.lnk`
        // lets the user pick the Start-menu entries the Open With dialog shows.
        let lower = app_path.to_ascii_lowercase();
        let launchable = lower.ends_with(".exe")
            || lower.ends_with(".lnk")
            || lower.ends_with(".bat")
            || lower.ends_with(".cmd");
        launchable && std::path::Path::new(app_path).is_file()
    }
}

/// Linux has no standard answer to "which applications can open this?".
///
/// An empty list is honest, and the caller copes: the track context menu falls
/// back to its own "Open With…" entry. `is_application` stays permissive about
/// an existing file so that path reaches `open_with_app`'s real "not
/// implemented yet" message instead of a misleading "Not an application".
#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
mod imp {
    use super::AppChoice;
    use tauri::{AppHandle, Runtime};

    pub fn recommended_apps(_path: &str) -> Vec<AppChoice> {
        Vec::new()
    }

    pub fn app_icons<R: Runtime>(
        _app: &AppHandle<R>,
        app_paths: &[String],
    ) -> Vec<Option<Vec<u8>>> {
        vec![None; app_paths.len()]
    }

    pub fn is_application(app_path: &str) -> bool {
        std::path::Path::new(app_path).is_file()
    }
}

pub use imp::{app_icons, is_application, recommended_apps};
