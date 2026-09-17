//! Native menus.
//!
//! Two things live here:
//!
//! * the **menu bar**, built once at startup;
//! * the **context menus** for the track list and the column headers, built on
//!   demand and popped up under the cursor.
//!
//! Both are real native menus (`NSMenu` on macOS, the Win32 menu on Windows),
//! so they get the platform's own highlighting, keyboard navigation, submenu
//! behaviour and — for "Open With" — the application icons the file manager
//! shows. Nothing here is macOS-only: the one part that *is* platform-specific,
//! enumerating the applications that can open a file, lives in [`crate::apps`].
//!
//! Selection is reported through a single event (`yame://menu`) carrying the
//! item id, which the frontend turns back into an action.
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow};

#[cfg(target_os = "macos")]
use tauri::menu::{AboutMetadata, IconMenuItemBuilder};

use crate::apps;

/// Menu glyphs differ per platform: a tick reads as "on" everywhere, but a
/// blank column in a menu is conventionally a couple of spaces on macOS and a
/// wider gap on Windows.
#[cfg(target_os = "macos")]
const TICK: &str = "✓  ";
#[cfg(target_os = "macos")]
const NO_TICK: &str = "   ";

#[cfg(not(target_os = "macos"))]
const TICK: &str = "✓  ";
#[cfg(not(target_os = "macos"))]
const NO_TICK: &str = "     ";

/// Escape a literal "&" so it is not swallowed as a mnemonic marker.
///
/// Windows menus treat the character after "&" as the keyboard mnemonic and
/// drop the "&" itself, so an application called "R&B" would render as "RB".
/// macOS menus do the same. Doubling escapes it on both.
fn menu_text(raw: &str) -> String {
    raw.replace('&', "&&")
}

/// Event the frontend listens on for every menu selection.
pub const MENU_EVENT: &str = "yame://menu";

/// One row of the app menu bar.
///
/// The structure is shared; the macOS-only conveniences are gated because they
/// are inert or meaningless elsewhere, not because they fail to build.
/// `services`, `show_all`, `hide` and `hide_others` are macOS concepts with no
/// Windows equivalent, and `undo`/`redo` are documented as unsupported there.
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    // macOS renders the first submenu as the bold application menu, so it gets
    // About/Services/Hide/Quit. On Windows those belong under Help and the
    // window's own system menu, so no application submenu is added at all.
    #[cfg(target_os = "macos")]
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

    let open_item = MenuItemBuilder::with_id("file.open", "Open Files…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let add_item = MenuItemBuilder::with_id("file.add", "Add Files…")
        .accelerator("CmdOrCtrl+Shift+O")
        .build(app)?;

    let file_menu = {
        let builder = SubmenuBuilder::new(app, "File")
            .item(&open_item)
            .item(&add_item);
        // Windows convention puts Exit at the bottom of the File menu, because
        // there is no application menu to hold it.
        #[cfg(target_os = "macos")]
        let builder = builder;
        #[cfg(not(target_os = "macos"))]
        let builder = builder.separator().item(&PredefinedMenuItem::quit(app, None)?);
        builder.build()?
    };

    // Undo/Redo are unsupported on Windows and Linux; the rest of the Edit menu
    // is what makes Ctrl+C/Ctrl+V work in the text fields.
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit_menu = {
        let builder = SubmenuBuilder::new(app, "Edit");
        #[cfg(target_os = "macos")]
        let builder = builder
            .item(&PredefinedMenuItem::undo(app, None)?)
            .item(&PredefinedMenuItem::redo(app, None)?)
            .separator();
        let builder = builder
            .item(&cut)
            .item(&copy)
            .item(&paste)
            .item(&select_all);
        builder.build()?
    };

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("view.search", "Search")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .build()?;

    // A Window menu holds Minimize/Maximize/Close, which need the window whose
    // menu bar they belong to. Windows puts those in the title bar's own system
    // menu instead, and a Window menu duplicating them would be inert, so this
    // is macOS-only.
    #[cfg(target_os = "macos")]
    let window_menu = SubmenuBuilder::new(app, "Window")
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;

    #[cfg(target_os = "macos")]
    let menu = MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu])
        .build()?;

    // Windows and Linux apps conventionally end with Help, holding About, and
    // put Exit at the foot of File rather than in a Window menu.
    #[cfg(not(target_os = "macos"))]
    let menu = {
        let help_menu = SubmenuBuilder::new(app, "Help")
            // An explicit item rather than `PredefinedMenuItem::about`: the
            // predefined one opens the OS's own dialog, which on Windows shows
            // a bare message box with no version and no config path. Routing it
            // through the app's dialog keeps the same information visible on
            // every platform.
            .item(
                &MenuItemBuilder::with_id("help.about", "About YAME.mp3")
                    .build(app)?,
            )
            .build()?;
        MenuBuilder::new(app)
            .items(&[&file_menu, &edit_menu, &view_menu, &help_menu])
            .build()?
    };

    Ok(menu)
}

/// Pop up the song context menu at a logical position inside the window.
///
/// `apps` comes from the platform's application list (see [`crate::apps`]);
/// passing them in keeps the menu building here free of platform code.
pub fn show_track_menu<R: Runtime>(
    window: &WebviewWindow<R>,
    path: &str,
    x: f64,
    y: f64,
    selection_count: usize,
) -> tauri::Result<()> {
    let app = window.app_handle();

    // "Open With" is a submenu of the applications the platform recommends for
    // this exact file, plus an escape hatch to pick any application.
    let apps = apps::recommended_apps(path);
    let icons = apps::app_icons(
        app,
        &apps.iter().map(|a| a.path.clone()).collect::<Vec<_>>(),
    );

    // The submenu is built from whatever the platform could enumerate. When a
    // platform can name no applications, it still gets a single "Open With…"
    // entry that routes to the platform's own chooser — losing the feature
    // entirely would be worse than a shorter menu.
    enum OpenWith<R: Runtime> {
        Submenu(tauri::menu::Submenu<R>),
        Chooser,
    }

    let open_with = if apps.is_empty() {
        Some(OpenWith::Chooser)
    } else {
        let mut submenu = SubmenuBuilder::new(app, "Open With");
        for (choice, icon) in apps.iter().zip(icons) {
            let id = format!("openwith:{}", choice.path);
            submenu = submenu.item(&build_app_item(app, id, &choice.name, icon)?);
        }
        // "Other…" is deliberately icon-less: there is no single sensible icon
        // for "any application".
        Some(OpenWith::Submenu(
            submenu
                .separator()
                .item(&MenuItemBuilder::with_id("openwith.other", "Other…").build(app)?)
                .build()?,
        ))
    };

    let copy_label = if selection_count > 1 {
        format!("Copy {selection_count} Songs")
    } else {
        "Copy".to_string()
    };

    let mut menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("open", "Open").build(app)?);
    match &open_with {
        Some(OpenWith::Submenu(submenu)) => menu = menu.item(submenu),
        Some(OpenWith::Chooser) => {
            let item = MenuItemBuilder::with_id("openwith.other", "Open With…").build(app)?;
            menu = menu.item(&item);
        }
        None => {}
    }
    let menu = menu
        .separator()
        .item(&MenuItemBuilder::with_id("copy", copy_label).build(app)?)
        .item(&MenuItemBuilder::with_id("paste", "Paste").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("remove", "Remove from List").build(app)?)
        .item(&MenuItemBuilder::with_id("reveal", reveal_label()).build(app)?)
        .build()?;

    window.popup_menu_at(&menu, tauri::LogicalPosition::new(x, y))?;
    Ok(())
}

/// "Show in Finder" on macOS, "Show in Explorer" on Windows, and the neutral
/// wording elsewhere — the action is the same, but the file manager's name is
/// what the user is looking for.
fn reveal_label() -> &'static str {
    #[cfg(target_os = "macos")]
    {
        "Show in Finder"
    }
    #[cfg(target_os = "windows")]
    {
        "Show in Explorer"
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        "Show in Files"
    }
}

/// One "Open With" row.
///
/// Only macOS can put an icon on a menu item, so on other platforms this
/// degrades to a plain item — and the icon crate (and its PNG encoder) is not
/// even compiled in.
#[cfg(target_os = "macos")]
fn build_app_item<R: Runtime>(
    app: &AppHandle<R>,
    id: String,
    name: &str,
    icon: Option<Vec<u8>>,
) -> tauri::Result<tauri::menu::MenuItemKind<R>> {
    let mut item = IconMenuItemBuilder::with_id(id, menu_text(name));
    if let Some(rgba) = icon {
        item = item.icon(tauri::image::Image::new_owned(rgba, apps::ICON_PX, apps::ICON_PX));
    }
    Ok(tauri::menu::MenuItemKind::Icon(item.build(app)?))
}

#[cfg(not(target_os = "macos"))]
fn build_app_item<R: Runtime>(
    app: &AppHandle<R>,
    id: String,
    name: &str,
    _icon: Option<Vec<u8>>,
) -> tauri::Result<tauri::menu::MenuItemKind<R>> {
    Ok(tauri::menu::MenuItemKind::MenuItem(
        MenuItemBuilder::with_id(id, menu_text(name)).build(app)?,
    ))
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
        let mark = if hidden.iter().any(|h| h == key) { NO_TICK } else { TICK };
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
