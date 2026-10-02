//! Native macOS integration that a webview cannot reach.
//!
//! Everything here runs on the main thread: AppKit panels are modal and must
//! not be created anywhere else. Callers use [`on_main`] to hop across.
#![cfg(target_os = "macos")]

use std::collections::HashMap;
use std::sync::{mpsc, Mutex, OnceLock};

use objc2::rc::Retained;
use objc2_app_kit::{
    NSBitmapImageRep, NSCompositingOperation, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage,
    NSModalResponseOK, NSOpenPanel, NSWorkspace,
};
use objc2_foundation::{MainThreadMarker, NSInteger, NSPoint, NSRect, NSSize, NSString, NSURL};
use tauri::{AppHandle, Runtime};

use crate::apps::AppChoice;

/// Run `work` on the main thread and wait for its result.
///
/// A modal panel nested inside Tauri's event loop is exactly what AppKit
/// expects, but it must happen on the main thread while the command itself
/// runs on a worker — hence the channel.
fn on_main<R: Runtime, T, F>(app: &AppHandle<R>, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(work());
    })
    .map_err(|err| err.to_string())?;
    rx.recv().map_err(|err| err.to_string())
}

fn ns_path(path: &str) -> Retained<NSString> {
    NSString::from_str(path)
}

/// The "add music" panel: songs *and* folders, together, in one dialog.
///
/// This is the whole reason for talking to AppKit directly — Tauri's dialog
/// plugin can only offer files or folders, never both.
pub fn pick_music_paths<R: Runtime>(app: &AppHandle<R>, title: &str, prompt: &str) -> Result<Vec<String>, String> {
    let title = title.to_string();
    let prompt = prompt.to_string();
    on_main(app, move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return Vec::new();
        };
        let panel = NSOpenPanel::openPanel(mtm);
        panel.setCanChooseFiles(true);
        panel.setCanChooseDirectories(true);
        panel.setAllowsMultipleSelection(true);
        panel.setResolvesAliases(true);
        panel.setTitle(Some(&NSString::from_str(&title)));
        panel.setPrompt(Some(&NSString::from_str(&prompt)));

        if panel.runModal() != NSModalResponseOK {
            return Vec::new();
        }
        panel
            .URLs()
            .iter()
            .filter_map(|url| url.path().map(|p| p.to_string()))
            .collect()
    })
}

/// Applications LaunchServices considers suitable for this file, in the same
/// order Finder's "Open With" menu shows them.
pub fn recommended_apps(path: &str) -> Vec<AppChoice> {
    let workspace = NSWorkspace::sharedWorkspace();
    let url = NSURL::fileURLWithPath(&ns_path(path));
    let apps = workspace.URLsForApplicationsToOpenURL(&url);

    let mut out = Vec::new();
    for app_url in apps.iter() {
        let Some(app_path) = app_url.path() else {
            continue;
        };
        let app_path = app_path.to_string();
        let name = app_path
            .rsplit('/')
            .next()
            .unwrap_or(&app_path)
            .trim_end_matches(".app")
            .to_string();
        out.push(AppChoice { name, path: app_path });
    }
    out
}

/// Side of the square we rasterise menu icons into, in pixels. Owned by
/// [`crate::apps`] because the menu builder is what needs it, on every platform.
use crate::apps::ICON_PX;

/// Rasterised icons, keyed by application path.
///
/// Building the "Open With" submenu asks for one icon per recommended
/// application. Without this cache every right-click re-rendered all of them.
fn icon_cache() -> &'static Mutex<HashMap<String, Option<Vec<u8>>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<Vec<u8>>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Raw RGBA icons for a list of application bundles, ready for menu items.
///
/// AppKit wants the main thread for image work, so the whole batch is rendered
/// in a single hop rather than one per application. Everything is cached, so
/// only the first right-click of a session pays for rendering.
pub fn app_icons<R: Runtime>(app: &AppHandle<R>, app_paths: &[String]) -> Vec<Option<Vec<u8>>> {
    let paths = app_paths.to_vec();
    let count = paths.len();
    on_main(app, move || {
        let Some(mtm) = MainThreadMarker::new() else {
            return vec![None; count];
        };
        paths.iter().map(|path| cached_icon(mtm, path)).collect()
    })
    .unwrap_or_else(|_| vec![None; count])
}

fn cached_icon(mtm: MainThreadMarker, app_path: &str) -> Option<Vec<u8>> {
    if let Ok(cache) = icon_cache().lock() {
        if let Some(hit) = cache.get(app_path) {
            return hit.clone();
        }
    }
    let rendered = render_icon(mtm, app_path);
    if let Ok(mut cache) = icon_cache().lock() {
        cache.insert(app_path.to_string(), rendered.clone());
    }
    rendered
}

/// Draw an application's icon straight into a small RGBA bitmap.
///
/// Deliberately *not* a PNG round-trip: `NSWorkspace` hands back a
/// multi-resolution image, and flattening all of it cost ~300ms and 1-2MB per
/// application — far too slow to do while opening a context menu.
fn render_icon(mtm: MainThreadMarker, app_path: &str) -> Option<Vec<u8>> {
    let workspace = NSWorkspace::sharedWorkspace();
    let icon: Retained<NSImage> = workspace.iconForFile(&ns_path(app_path));
    let side = ICON_PX as NSInteger;

    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            mtm.alloc(),
            std::ptr::null_mut(),
            side,
            side,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )
    }?;

    let context = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
    // Set the context first, then save: saving beforehand pushes onto the
    // *previous* context's stack and the matching restore pops a stack this
    // one never pushed.
    let previous = NSGraphicsContext::currentContext();
    NSGraphicsContext::setCurrentContext(Some(&context));
    NSGraphicsContext::saveGraphicsState_class();
    unsafe {
        icon.drawInRect_fromRect_operation_fraction_respectFlipped_hints(
            NSRect::new(
                NSPoint::new(0.0, 0.0),
                NSSize::new(ICON_PX as f64, ICON_PX as f64),
            ),
            // NSZeroRect: draw the whole image into that square.
            NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(0.0, 0.0)),
            NSCompositingOperation::SourceOver,
            1.0,
            false,
            None,
        );
    }
    NSGraphicsContext::restoreGraphicsState_class();
    NSGraphicsContext::setCurrentContext(previous.as_deref());

    let data = rep.bitmapData();
    if data.is_null() {
        return None;
    }
    let len = (ICON_PX * ICON_PX * 4) as usize;
    Some(unsafe { std::slice::from_raw_parts(data, len).to_vec() })
}

/// True when `app_path` is an application bundle we can hand a file to.
pub fn is_application(app_path: &str) -> bool {
    app_path.ends_with(".app") && std::path::Path::new(app_path).is_dir()
}
