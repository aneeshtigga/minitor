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
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

const TRAY_ID: &str = "minitor-tray";
// Black "M" (alpha shape). On macOS this is used as a template image so the OS
// auto-tints it. On Windows we pick black/white explicitly by taskbar theme.
const TRAY_ICON_BLACK: &[u8] = include_bytes!("../icons/tray.png");
#[cfg(target_os = "windows")]
const TRAY_ICON_WHITE: &[u8] = include_bytes!("../icons/tray-white.png");

/// Windows taskbar theme → which tray icon contrasts best.
/// SystemUsesLightTheme=1 means a light taskbar (use the black icon); 0 / absent
/// means a dark taskbar (use the white icon).
#[cfg(target_os = "windows")]
fn windows_tray_icon_bytes() -> &'static [u8] {
    let light_taskbar = std::process::Command::new("reg")
        .args([
            "query",
            r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "/v",
            "SystemUsesLightTheme",
        ])
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("0x1"))
        .unwrap_or(false);
    if light_taskbar {
        TRAY_ICON_BLACK
    } else {
        TRAY_ICON_WHITE
    }
}

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

/// Is the app registered to launch at login?
#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Enable/disable launch-at-login (macOS LaunchAgent / Windows registry / Linux .desktop).
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mgr = app.autolaunch();
    let res = if enabled { mgr.enable() } else { mgr.disable() };
    res.map_err(|e| e.to_string())
}

// check_deps / install_dep shell out to winget/brew/apt, which can take several
// seconds. They're `async` + spawn_blocking so the work runs off the UI thread —
// otherwise a sync command blocks the main thread and freezes the window.
#[tauri::command]
async fn check_deps() -> deps::DepStatus {
    tauri::async_runtime::spawn_blocking(deps::check)
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn install_dep(name: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || deps::install(&name))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
fn download_url(name: String) -> String {
    deps::download_url(&name).to_string()
}

/// Lightweight "is Jackett answering?" probe (TCP connect to 127.0.0.1:9117).
/// Cheap enough for the UI to poll alongside `status` — unlike `check_deps`,
/// which shells out to the package manager. spawn_blocking keeps the (worst
/// case 400ms) connect timeout off the UI thread.
#[tauri::command]
async fn jackett_running() -> bool {
    tauri::async_runtime::spawn_blocking(deps::jackett_reachable)
        .await
        .unwrap_or(false)
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
        let jackett_web = MenuItem::with_id(app, "open_jackett", "Open Jackett web interface", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
        Menu::with_items(app, &[&console, &minitor_web, &qbit_web, &jackett_web, &sep, &quit])
    })();
    let Ok(menu) = menu else { return };

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main_window(app),
            "open_minitor" => {
                let _ = app.opener().open_url(format!("{}/", server::public_url()), None::<&str>);
            }
            "open_qbit" => {
                let _ = app.opener().open_url("http://127.0.0.1:8080", None::<&str>);
            }
            "open_jackett" => {
                let _ = app.opener().open_url("http://127.0.0.1:9117", None::<&str>);
            }
            "quit" => {
                server::stop(app);
                app.exit(0);
            }
            _ => {}
        });

    // Platform-specific icon + click behavior.
    #[cfg(target_os = "macos")]
    {
        // Template image → macOS auto-tints it black/white for the menu bar.
        // Left-click opens the dropdown (the standard macOS menu-bar pattern).
        if let Ok(icon) = tauri::image::Image::from_bytes(TRAY_ICON_BLACK) {
            builder = builder.icon(icon).icon_as_template(true);
        }
        builder = builder.show_menu_on_left_click(true);
    }
    #[cfg(target_os = "windows")]
    {
        // Pick black/white by taskbar theme so it's never low-contrast.
        // Windows convention: LEFT-click opens the app, RIGHT-click shows the menu.
        if let Ok(icon) = tauri::image::Image::from_bytes(windows_tray_icon_bytes()) {
            builder = builder.icon(icon);
        }
        builder = builder
            .show_menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if let tauri::tray::TrayIconEvent::Click {
                    button: tauri::tray::MouseButton::Left,
                    button_state: tauri::tray::MouseButtonState::Up,
                    ..
                } = event
                {
                    show_main_window(&tray.app_handle());
                }
            });
    }
    #[cfg(target_os = "linux")]
    {
        // Linux trays generally only support a menu (no reliable click event);
        // keep the menu on left-click.
        if let Ok(icon) = tauri::image::Image::from_bytes(TRAY_ICON_BLACK) {
            builder = builder.icon(icon);
        }
        builder = builder.show_menu_on_left_click(true);
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
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .manage(ServerState::default())
        .setup(|app| {
            // Auto-start the service in direct mode on launch ONLY when its
            // dependency (Jackett — the search backend) is already installed.
            // On a fresh machine we leave it stopped so the user can install
            // deps / finish setup first.
            //
            // deps::check() shells out to winget/brew (seconds), so we run it on a
            // background thread — doing it inline here would block the main thread
            // and freeze the window before it can even paint.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let jackett = tauri::async_runtime::spawn_blocking(|| deps::check().jackett)
                    .await
                    .unwrap_or(false);
                if jackett {
                    // Tray creation + sidecar spawn back on the main thread.
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || {
                        let _ = launch_service(&h, "direct");
                    });
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            autostart_enabled,
            set_autostart,
            check_deps,
            install_dep,
            download_url,
            jackett_running,
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
