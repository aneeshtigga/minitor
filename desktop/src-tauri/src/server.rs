//! Lifecycle for the minitor Node sidecar binary.
//!
//! We spawn the pkg'd `minitor` sidecar (declared in tauri.conf.json
//! `externalBin`) with the right env, stream its stdout, and flip a shared
//! "running" flag when we see its readiness line. The child handle lives in
//! Tauri-managed state so `stop()` (and app exit) can kill it.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

const PORT: u16 = 11472;

/// Shared server state, stored via `app.manage()`.
#[derive(Default)]
pub struct ServerState {
    pub child: Mutex<Option<CommandChild>>,
    pub running: Mutex<bool>,
    pub mode: Mutex<String>,
}

/// The public URL the addon is reachable at.
pub fn public_url() -> String {
    format!("http://127.0.0.1:{PORT}")
}

/// Is the sidecar currently marked running?
pub fn is_running(app: &AppHandle) -> bool {
    *app.state::<ServerState>().running.lock().unwrap()
}

/// Current stream mode ("direct" | "cache").
pub fn current_mode(app: &AppHandle) -> String {
    app.state::<ServerState>().mode.lock().unwrap().clone()
}

/// Per-app data dir for the cache index (stable, unlike a bundled binary's cwd).
fn data_dir(app: &AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|p| p.join("data").to_string_lossy().to_string())
        .unwrap_or_else(|_| "/tmp/minitor-data".to_string())
}

/// Spawn the sidecar in the given mode. Idempotent-ish: if one is already
/// running we stop it first (used by mode switches).
pub fn start(app: &AppHandle, mode: &str) -> Result<(), String> {
    stop(app);

    let mode = if mode == "cache" { "cache" } else { "direct" };
    let public = public_url();
    let data = data_dir(app);

    let mut sidecar = app
        .shell()
        .sidecar("minitor")
        .map_err(|e| format!("Failed to locate minitor sidecar: {e}"))?
        .env("PORT", PORT.to_string())
        .env("PUBLIC_URL", &public)
        .env("STREAM_MODE", mode)
        .env("MINITOR_DATA_DIR", &data)
        .env("JACKETT_URL", "http://127.0.0.1:9117")
        // JACKETT_API_KEY intentionally unset — the server reads it from
        // Jackett's ServerConfig.json (see src/jackett-setup.js).
        .env("QBIT_URL", "http://127.0.0.1:8080")
        .env("QBIT_USER", "admin")
        .env("QBIT_PASS", "adminadmin");

    // TheTVDB creds for anime absolute-episode lookup (One Piece S23E09 -> 1164).
    // Forward from the host env ONLY when non-empty: passing an empty value would
    // SHADOW a key the user placed in the data-dir .env, because dotenv refuses to
    // override an already-set variable (see src/config.js).
    for key in ["TVDB_API_KEY", "TVDB_PIN"] {
        if let Ok(val) = std::env::var(key) {
            if !val.is_empty() {
                sidecar = sidecar.env(key, val);
            }
        }
    }

    let (mut rx, child) = sidecar
        .spawn()
        .map_err(|e| format!("Failed to spawn minitor: {e}"))?;

    {
        let state = app.state::<ServerState>();
        *state.child.lock().unwrap() = Some(child);
        *state.running.lock().unwrap() = false;
        *state.mode.lock().unwrap() = mode.to_string();
    }

    // Stream stdout/stderr; detect the readiness line and forward logs to the UI.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    if line.contains("minitor running") {
                        *app_handle.state::<ServerState>().running.lock().unwrap() = true;
                        let _ = app_handle.emit("server-ready", public_url());
                    }
                    let _ = app_handle.emit("server-log", line);
                }
                CommandEvent::Terminated(_) => {
                    *app_handle.state::<ServerState>().running.lock().unwrap() = false;
                    let _ = app_handle.emit("server-stopped", ());
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Kill the sidecar if running. Safe to call when nothing is running.
pub fn stop(app: &AppHandle) {
    let state = app.state::<ServerState>();
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
    *state.running.lock().unwrap() = false;
}
