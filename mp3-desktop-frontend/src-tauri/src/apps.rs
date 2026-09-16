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
/// Deliberately a plain data type with no platform behaviour: the menu builder
/// serialises it to the frontend for `apps_for_file`, and the frontend treats
/// `name` and `path` as opaque strings.
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

/// A Windows application is an executable (or a shortcut the shell resolves).
#[cfg(target_os = "windows")]
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

/// No "Open With" enumeration and no way to launch a chosen application yet.
///
/// Returning an empty list is the honest answer, and the callers already handle
/// it: the track context menu omits the whole submenu rather than showing an
/// empty one, and `open_with_app` reports that the feature is unavailable
/// instead of silently doing nothing. Filling this in is a Linux-only job;
/// see the module docs above for the shape it has to satisfy.
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

    pub fn is_application(_app_path: &str) -> bool {
        false
    }
}

pub use imp::{app_icons, is_application, recommended_apps};
