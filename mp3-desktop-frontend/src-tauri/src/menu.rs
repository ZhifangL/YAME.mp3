//! Native macOS menus.
//!
//! Two things live here:
//!
//! * the **menu bar** (File / Edit / View / Window), built once at startup;
//! * the **context menus** for the track list and the column headers, built on
//!   demand and popped up under the cursor.
//!
//! Both are real `NSMenu`s, so they get macOS's own highlighting, keyboard
//! navigation, submenu behaviour and — for "Open With" — the application icons
//! Finder shows.
//!
//! Selection is reported through a single event (`yame://menu`) carrying the
//! item id, which the frontend turns back into an action.
use tauri::menu::{
    AboutMetadata, IconMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

use crate::macos;

/// macOS menus treat a lone "&" as a mnemonic marker and delete it, so an
/// application called "R&B" would render as "RB". Doubling escapes it.
fn menu_text(raw: &str) -> String {
    raw.replace('&', "&&")
}

/// Event the frontend listens on for every menu selection.
pub const MENU_EVENT: &str = "yame://menu";

/// One row of the app menu bar.
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    // macOS renders the first submenu as the bold app menu.
    let app_menu = SubmenuBuilder::new(app, "YAME")
        .item(&PredefinedMenuItem::about(
            app,
            None,
            Some(AboutMetadata {
                name: Some("YAME.mp3".into()),
                ..AboutMetadata::default()
            }),
        )?)
        .separator()
        .item(&PredefinedMenuItem::services(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("file.open", "Open Files…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.add", "Add Files…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?,
        )
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("view.search", "Search")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()
}

/// Pop up the song context menu at a logical position inside the window.
///
/// `apps` comes from LaunchServices; passing them in keeps the menu building
/// here free of platform code.
pub fn show_track_menu<R: Runtime>(
    window: &WebviewWindow<R>,
    path: &str,
    x: f64,
    y: f64,
    selection_count: usize,
) -> tauri::Result<()> {
    let app = window.app_handle();

    // "Open With" is a submenu of the applications LaunchServices recommends
    // for this exact file, plus an escape hatch to pick any application.
    let apps = macos::recommended_apps(path);
    let icons = macos::app_icons(
        app,
        &apps.iter().map(|a| a.path.clone()).collect::<Vec<_>>(),
    );

    let mut open_with = SubmenuBuilder::new(app, "Open With");
    for (choice, icon) in apps.iter().zip(icons) {
        let id = format!("openwith:{}", choice.path);
        let mut item = IconMenuItemBuilder::with_id(id, menu_text(&choice.name));
        if let Some(rgba) = icon {
            item = item.icon(tauri::image::Image::new_owned(
                rgba,
                macos::ICON_PX,
                macos::ICON_PX,
            ));
        }
        open_with = open_with.item(&item.build(app)?);
    }
    // "Other…" is deliberately icon-less: macOS puts it in its own group, and
    // there is no single sensible icon for "any application".
    let open_with = open_with
        .separator()
        .item(&MenuItemBuilder::with_id("openwith.other", "Other…").build(app)?)
        .build()?;

    let copy_label = if selection_count > 1 {
        format!("Copy {selection_count} Songs")
    } else {
        "Copy".to_string()
    };

    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open").build(app)?)
        .item(&open_with)
        .separator()
        .item(&MenuItemBuilder::with_id("copy", copy_label).build(app)?)
        .item(&MenuItemBuilder::with_id("paste", "Paste").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("remove", "Remove from List").build(app)?)
        .item(&MenuItemBuilder::with_id("reveal", "Show in Finder").build(app)?)
        .build()?;

    window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y))?;
    Ok(())
}

/// Pop up the column-header menu (freeze + visibility) at a logical position.
pub fn show_column_menu<R: Runtime>(
    window: &WebviewWindow<R>,
    columns: &[(String, String)],
    frozen: bool,
    hidden: &[String],
    x: f64,
    y: f64,
) -> tauri::Result<()> {
    let app = window.app_handle();
    let mut menu = MenuBuilder::new(app).item(
        &MenuItemBuilder::with_id("col.freeze", if frozen { "Unfreeze Column" } else { "Freeze Column" })
            .build(app)?,
    );
    menu = menu.separator();
    for (key, label) in columns {
        let mark = if hidden.iter().any(|h| h == key) { "   " } else { "✓  " };
        menu = menu.item(
            &MenuItemBuilder::with_id(format!("col.toggle:{key}"), menu_text(&format!("{mark}{label}")))
                .build(app)?,
        );
    }
    let menu = menu.build()?;
    window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y))?;
    Ok(())
}

/// Forward a menu selection to the frontend.
pub fn emit_selection<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let _ = app.emit(MENU_EVENT, id.to_string());
}
