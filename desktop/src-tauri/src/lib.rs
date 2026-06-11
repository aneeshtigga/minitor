//! Minitor desktop control panel — Tauri backend.
//!
//! Orchestrates dependencies (Jackett/qBittorrent, via the platform package
//! manager) and the minitor Node sidecar, exposing a handful of commands to the
//! webview UI.
//!
//! Lifecycle is macOS-native: clicking the window's red close button HIDES the
//! window (the app + service keep running); the dock/tray reopens it. A menu-bar
//! tray icon appears while the service is running. Real quit (Cmd-Q or the tray
//! Quit item) stops the sidecar and exits.

mod deps;
mod server;

use serde::Serialize;
use server::ServerState;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager, RunEvent, WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

const TRAY_ID: &str = "minitor-tray";
// Monochrome template icon (black + alpha); macOS tints it for the menu bar.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");

#[derive(Serialize)]
struct Status {
    running: bool,
    mode: String,
    public_url: String,
    addon_url: String,
    qbittorrent_url: String,
    jackett_url: String,
}

#[tauri::command]
fn app_version() -> String {
    // Compile-time crate version (kept in sync with the release tag by CI).
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn check_deps() -> deps::DepStatus {
    deps::check()
}

#[tauri::command]
fn install_dep(name: String) -> Result<String, String> {
    deps::install(&name)
}

#[tauri::command]
fn download_url(name: String) -> String {
    deps::download_url(&name).to_string()
}

/// Start the sidecar in `mode` and show the tray. Shared by the UI command and
/// the launch auto-start.
fn launch_service(app: &AppHandle, mode: &str) -> Result<(), String> {
    // Jackett needs to be up for search; nudge its service (no-op if not installed).
    deps::start_jackett_service();
    server::start(app, mode)?;
    show_tray(app); // menu-bar presence while the service runs
    Ok(())
}

#[tauri::command]
fn start_server(app: AppHandle, mode: String) -> Result<(), String> {
    launch_service(&app, &mode)
}

#[tauri::command]
fn stop_server(app: AppHandle) {
    server::stop(&app);
    hide_tray(&app);
}

#[tauri::command]
fn status(app: AppHandle) -> Status {
    let public = server::public_url();
    Status {
        running: server::is_running(&app),
        mode: server::current_mode(&app),
        addon_url: format!("{public}/manifest.json"),
        public_url: public.clone(),
        qbittorrent_url: "http://127.0.0.1:8080".to_string(),
        jackett_url: "http://127.0.0.1:9117".to_string(),
    }
}

/// Bring the main window back into view (from hidden/minimized).
fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Create the menu-bar tray icon if it isn't already there. Idempotent: keyed by
/// TRAY_ID, so repeated calls (e.g. start → mode-switch → start) are no-ops.
fn show_tray(app: &AppHandle) {
    if app.tray_by_id(TRAY_ID).is_some() {
        return;
    }
    let menu = (|| {
        let console = MenuItem::with_id(app, "open", "Open Minitor Console", true, None::<&str>)?;
        let minitor_web = MenuItem::with_id(app, "open_minitor", "Open Minitor web interface", true, None::<&str>)?;
        let qbit_web = MenuItem::with_id(app, "open_qbit", "Open qBittorrent web interface", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        Menu::with_items(app, &[&console, &minitor_web, &qbit_web, &sep, &quit])
    })();
    let Ok(menu) = menu else { return };

    let icon = tauri::image::Image::from_bytes(TRAY_ICON).ok();
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon_as_template(true) // auto black/white for the menu bar
        .menu(&menu)
        .show_menu_on_left_click(true) // click the icon → dropdown menu
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "open_minitor" => {
                let _ = app.opener().open_url(format!("{}/", server::public_url()), None::<&str>);
            }
            "open_qbit" => {
                let _ = app.opener().open_url("http://127.0.0.1:8080", None::<&str>);
            }
            "quit" => {
                server::stop(app);
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = icon {
        builder = builder.icon(icon);
    }
    let _ = builder.build(app);
}

/// Remove the menu-bar tray icon (service stopped).
fn hide_tray(app: &AppHandle) {
    let _ = app.remove_tray_by_id(TRAY_ID);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerState::default())
        .setup(|app| {
            // Auto-start the service in direct mode on launch ONLY when its
            // dependency (Jackett — the search backend) is already installed.
            // On a fresh machine we leave it stopped so the user can install
            // deps / finish setup first, instead of spinning up a server that
            // can't search. Once Jackett is present, every later launch comes up
            // ready with no Start click.
            if deps::check().jackett {
                let handle = app.handle().clone();
                let _ = launch_service(&handle, "direct");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            check_deps,
            install_dep,
            download_url,
            start_server,
            stop_server,
            status
        ])
        .on_window_event(|window, event| {
            // macOS-native: the red close button HIDES the window instead of
            // quitting. The sidecar keeps running; reopen via dock or tray.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Minitor")
        .run(|app, event| match event {
            // Dock icon clicked while no window is visible → show the window.
            #[cfg(target_os = "macos")]
            RunEvent::Reopen { has_visible_windows, .. } => {
                if !has_visible_windows {
                    show_main_window(app);
                }
            }
            // A real quit (Cmd-Q / tray Quit / app.exit) → stop the sidecar.
            RunEvent::ExitRequested { .. } | RunEvent::Exit => {
                server::stop(app);
            }
            _ => {}
        });
}
