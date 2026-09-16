//! YAME desktop shell.
//!
//! The window is built here rather than declared in `tauri.conf.json` so the
//! engine's origin can be injected as an initialization script — it has to be
//! in place before any page code runs.
mod apps;
mod engine;
#[cfg(target_os = "macos")]
mod macos;
mod menu;
mod platform;
#[cfg(target_os = "windows")]
mod windows;

use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            platform::pick_music,
            platform::open_default,
            platform::apps_for_file,
            platform::open_with_app,
            platform::copy_files_to_clipboard,
            platform::read_files_from_clipboard,
            platform::save_playlist,
            show_track_menu,
            show_column_menu,
        ])
        .setup(|app| {
            let engine = engine::start();

            // Picked before the webview exists, so the UI knows where to look
            // from its very first request. It polls /api/health until the
            // engine is up, which lets the window appear immediately.
            //
            // The platform goes across in the same script so the frontend can
            // style itself for the host it is on, rather than guessing from the
            // user agent.
            let script = format!(
                "window.__YAME_ENGINE__ = {{ origin: {:?} }};\n\
                 window.__YAME_PLATFORM__ = {:?};",
                engine.origin,
                std::env::consts::OS
            );

            #[allow(unused_mut)]
            let mut builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("YAME.mp3")
                .inner_size(1280.0, 820.0)
                .min_inner_size(940.0, 600.0)
                .center()
                .initialization_script(&script);

            // An overlay title bar lets the app draw its own header while
            // macOS keeps the native traffic lights.
            #[cfg(target_os = "macos")]
            {
                builder = builder
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            // A real menu bar on every platform: File > Open Files… / Add
            // Files…, the standard Edit and Window menus, and Help. Only the
            // contents differ per platform (see `menu::build_app_menu`).
            let app_menu = menu::build_app_menu(app.handle())?;
            app.set_menu(app_menu)?;

            builder.build()?;
            app.manage(engine);
            Ok(())
        })
        .on_menu_event(|app, event| {
            menu::emit_selection(app, event.id().as_ref());
        })
        .build(tauri::generate_context!())
        .expect("failed to build the YAME app")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(engine) = app.try_state::<engine::Engine>() {
                    engine.stop();
                }
            }
        });
}

/// Pop up the song context menu where the user right-clicked.
///
/// Returns true so the caller can tell "shown natively" from "no Tauri here"
/// — a unit return would serialise to null either way, and the frontend would
/// also draw its own menu on top.
///
/// `async` on purpose: showing an NSMenu blocks the calling thread inside
/// AppKit's tracking loop, and a synchronous command can land on the main
/// thread — which is the thread that has to service that loop.
#[tauri::command]
async fn show_track_menu(
    window: tauri::WebviewWindow,
    path: String,
    x: f64,
    y: f64,
    selection_count: usize,
) -> Result<bool, String> {
    menu::show_track_menu(&window, &path, x, y, selection_count)
        .map(|_| true)
        .map_err(|err| err.to_string())
}

/// Pop up the column-header menu (freeze / show-hide columns).
///
/// Async for the same reason as [`show_track_menu`].
#[tauri::command]
async fn show_column_menu(
    window: tauri::WebviewWindow,
    columns: Vec<(String, String)>,
    frozen: bool,
    hidden: Vec<String>,
    x: f64,
    y: f64,
) -> Result<bool, String> {
    menu::show_column_menu(&window, &columns, frozen, &hidden, x, y)
        .map(|_| true)
        .map_err(|err| err.to_string())
}
