//! Minitor desktop control panel — Tauri backend.
//!
//! Orchestrates dependencies (Jackett/qBittorrent, via the platform package
//! manager) and the minitor Node sidecar, exposing a handful of commands to the
//! webview UI. Closing the app stops the sidecar.

mod deps;
mod server;

use serde::Serialize;
use server::ServerState;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

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

#[tauri::command]
fn start_server(app: AppHandle, mode: String) -> Result<(), String> {
    // Jackett needs to be up for search; nudge its service (no-op if not installed).
    deps::start_jackett_service();
    server::start(&app, &mode)
}

#[tauri::command]
fn stop_server(app: AppHandle) {
    server::stop(&app);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerState::default())
        .invoke_handler(tauri::generate_handler![
            check_deps,
            install_dep,
            download_url,
            start_server,
            stop_server,
            status
        ])
        .on_window_event(|window, event| {
            // Stop the sidecar when the main window is closed.
            if let WindowEvent::CloseRequested { .. } = event {
                server::stop(&window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running Minitor")
        .run(|app, event| {
            // Belt-and-suspenders: also stop on full app exit.
            if let RunEvent::Exit = event {
                server::stop(app);
            }
        });
}
