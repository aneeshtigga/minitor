//! Lifecycle for the minitor Node sidecar binary.
//!
//! We spawn the pkg'd `minitor` sidecar (declared in tauri.conf.json
//! `externalBin`) with the right env, stream its stdout, and forward logs to the
//! UI. The child handle lives in Tauri-managed state so `stop()` (and app exit)
//! can kill it.
//!
//! The UI's "running" indicator is NOT driven by an in-memory flag — that goes
//! stale when the app restarts while a sidecar (or a stray `node src/index.js`)
//! is still listening, which made the panel show "Stopped" over a live server.
//! Instead `probe_port()` asks the port directly, so the indicator always
//! reflects what's actually serving.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Default addon port. If it's free we bind here; if a *minitor* instance is
/// already serving here we adopt it; if a *foreign* process holds it we offer to
/// relocate to the next free port in the scan range.
pub const DEFAULT_PORT: u16 = 11472;
/// Highest port we'll relocate to when DEFAULT_PORT is taken by another app.
const PORT_SCAN_LIMIT: u16 = 11482;

/// Shared server state, stored via `app.manage()`.
#[derive(Default)]
pub struct ServerState {
    /// Handle to the sidecar WE spawned. `None` when stopped or when we've
    /// adopted an instance we didn't start (then `stop` reclaims by port).
    pub child: Mutex<Option<CommandChild>>,
    /// Port the active instance is on (0 → not yet set, treated as DEFAULT_PORT).
    /// The UI/tray read this so every URL points at whatever port we ended up on.
    pub port: Mutex<u16>,
    /// Mode we last launched in ("direct" | "cache"); a fallback for the UI when
    /// nothing is currently serving (a live instance's mode comes from its
    /// manifest, see `probe_port`).
    pub mode: Mutex<String>,
}

/// What's answering on a port right now.
pub enum PortState {
    /// Nothing is listening.
    Free,
    /// A minitor server — carries its mode ("direct" | "cache"), read from the
    /// addon manifest id.
    Minitor(String),
    /// Some other process holds the port.
    Foreign,
}

/// The public URL the addon is reachable at, for a given port.
pub fn public_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Port the active (running, adopted, or last-launched) instance uses.
pub fn active_port(app: &AppHandle) -> u16 {
    let p = *app.state::<ServerState>().port.lock().unwrap();
    if p == 0 {
        DEFAULT_PORT
    } else {
        p
    }
}

/// Mode the UI should fall back to when nothing is serving.
pub fn launched_mode(app: &AppHandle) -> String {
    let m = app.state::<ServerState>().mode.lock().unwrap().clone();
    if m.is_empty() {
        "direct".to_string()
    } else {
        m
    }
}

/// Do we own the running child? (True → a "start" is really a restart/mode-switch
/// of our own sidecar, not an adopt of a foreign instance.)
pub fn owns_child(app: &AppHandle) -> bool {
    app.state::<ServerState>().child.lock().unwrap().is_some()
}

/// Probe a port: free, serving minitor (which mode?), or held by something else.
/// This is the UI's source of truth. A refused connection settles instantly on
/// loopback; a live minitor answers `/manifest.json` in ~1ms. Kept dependency-
/// free (raw HTTP/1.0) — there's no HTTP client crate in the tree.
pub fn probe_port(port: u16) -> PortState {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let addr: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, Duration::from_millis(300)) else {
        return PortState::Free; // nothing listening
    };
    // Something's there — ask whether it's our addon.
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    let req = format!(
        "GET /manifest.json HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(req.as_bytes()).is_err() {
        return PortState::Foreign;
    }
    let mut body = String::new();
    let _ = stream.read_to_string(&mut body); // best-effort; a timeout just truncates
    if body.contains("org.minitor") {
        let mode = if body.contains("org.minitor.cache") {
            "cache"
        } else {
            "direct"
        };
        PortState::Minitor(mode.to_string())
    } else {
        PortState::Foreign
    }
}

/// First free port at/after DEFAULT_PORT within the scan range.
pub fn find_free_port() -> Option<u16> {
    (DEFAULT_PORT..=PORT_SCAN_LIMIT).find(|&p| matches!(probe_port(p), PortState::Free))
}

/// Record an already-running minitor instance (one we did NOT spawn) as the
/// active one, so the UI shows it Running with its real mode. There's no child
/// handle — `stop` reclaims the port by killing its listener.
pub fn adopt(app: &AppHandle, port: u16, mode: &str) {
    let state = app.state::<ServerState>();
    *state.child.lock().unwrap() = None;
    *state.port.lock().unwrap() = port;
    *state.mode.lock().unwrap() = mode.to_string();
}

/// Reset the active port back to the default (after a stop), so the next Start
/// targets DEFAULT_PORT again.
pub fn reset_port(app: &AppHandle) {
    *app.state::<ServerState>().port.lock().unwrap() = DEFAULT_PORT;
}

/// Per-app data dir for the cache index (stable, unlike a bundled binary's cwd).
fn data_dir(app: &AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|p| p.join("data").to_string_lossy().to_string())
        .unwrap_or_else(|_| "/tmp/minitor-data".to_string())
}

/// Spawn the sidecar in the given mode on `port`. Kills our previously-spawned
/// child first (used by mode switches); never touches a foreign process.
pub fn start(app: &AppHandle, mode: &str, port: u16) -> Result<(), String> {
    stop(app);

    let mode = if mode == "cache" { "cache" } else { "direct" };
    let public = public_url(port);
    let data = data_dir(app);

    let mut sidecar = app
        .shell()
        .sidecar("minitor")
        .map_err(|e| format!("Failed to locate minitor sidecar: {e}"))?
        .env("PORT", port.to_string())
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
        *state.port.lock().unwrap() = port;
        *state.mode.lock().unwrap() = mode.to_string();
    }

    // Stream stdout/stderr; nudge the UI to re-probe on readiness/exit, and
    // forward logs. (The indicator's truth comes from probe_port, not these
    // events — they just make the UI refresh promptly instead of on the next poll.)
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(bytes) | CommandEvent::Stderr(bytes) => {
                    let line = String::from_utf8_lossy(&bytes).to_string();
                    if line.contains("minitor running") {
                        let port = active_port(&app_handle);
                        let _ = app_handle.emit("server-ready", public_url(port));
                    }
                    let _ = app_handle.emit("server-log", line);
                }
                CommandEvent::Terminated(_) => {
                    let _ = app_handle.emit("server-stopped", ());
                }
                _ => {}
            }
        }
    });

    Ok(())
}

/// Kill the sidecar WE spawned, if any. Safe to call when nothing is running.
/// Does NOT touch an adopted/foreign process — see `crate::stop_server` for the
/// user-initiated reclaim that does.
pub fn stop(app: &AppHandle) {
    let state = app.state::<ServerState>();
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        let _ = child.kill();
    }
}
