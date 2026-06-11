//! Dependency detection + installation (Homebrew, Jackett, qBittorrent).
//!
//! Detection is cheap (filesystem / `brew list`); installation shells out to
//! Homebrew. Jackett is a brew *formula* (`brew install jackett`), qBittorrent
//! is a brew *cask* (`brew install --cask qbittorrent`). If Homebrew itself is
//! missing we can't silently install it (it needs an interactive sudo), so we
//! report that and let the UI offer a guided install.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize, Clone)]
pub struct DepStatus {
    pub brew: bool,
    pub jackett: bool,
    pub qbittorrent: bool,
}

/// Absolute path to the brew binary, checking both Apple-Silicon and Intel
/// locations (a GUI app doesn't inherit the shell's PATH).
pub fn brew_path() -> Option<String> {
    for p in ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
        if Path::new(p).exists() {
            return Some(p.to_string());
        }
    }
    None
}

fn brew_list_has(formula_or_cask: &str) -> bool {
    let Some(brew) = brew_path() else {
        return false;
    };
    Command::new(&brew)
        .args(["list", formula_or_cask])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// qBittorrent is detectable either via its app bundle or as a brew cask.
fn qbittorrent_installed() -> bool {
    Path::new("/Applications/qbittorrent.app").exists() || brew_list_has("qbittorrent")
}

/// Jackett is a brew formula; also accept the app bundle just in case.
fn jackett_installed() -> bool {
    brew_list_has("jackett") || Path::new("/Applications/Jackett.app").exists()
}

/// Snapshot of all dependency states for the UI.
pub fn check() -> DepStatus {
    DepStatus {
        brew: brew_path().is_some(),
        jackett: jackett_installed(),
        qbittorrent: qbittorrent_installed(),
    }
}

/// Run a brew install for the given dependency name. Returns Ok with the
/// combined stdout/stderr on success, Err with the output on failure.
pub fn install(name: &str) -> Result<String, String> {
    let brew = brew_path().ok_or_else(|| {
        "Homebrew is not installed. Install it from https://brew.sh, then click Refresh."
            .to_string()
    })?;

    let args: Vec<&str> = match name {
        // formula
        "jackett" => vec!["install", "jackett"],
        // cask
        "qbittorrent" => vec!["install", "--cask", "qbittorrent"],
        other => return Err(format!("Unknown dependency: {other}")),
    };

    let out = Command::new(&brew)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run brew: {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        // After installing Jackett, start it as a background service so its
        // API (and config file with the API key) come up.
        if name == "jackett" {
            let _ = Command::new(&brew).args(["services", "start", "jackett"]).output();
        }
        Ok(format!("{stdout}\n{stderr}"))
    } else {
        Err(format!("brew {} failed:\n{stderr}", args.join(" ")))
    }
}

/// Ensure the Jackett background service is running (idempotent).
pub fn start_jackett_service() {
    if let Some(brew) = brew_path() {
        let _ = Command::new(&brew).args(["services", "start", "jackett"]).output();
    }
}
