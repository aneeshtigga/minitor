//! Dependency detection + installation for Jackett and qBittorrent.
//!
//! Detection is cheap; installation shells out to the platform's package
//! manager and falls back to a download URL when none is available:
//!
//!   macOS    Homebrew — `brew install jackett` (formula),
//!            `brew install --cask qbittorrent` (cask)
//!   Windows  winget — `Jackett.Jackett`, `qBittorrent.qBittorrent`
//!   Linux    apt / dnf / pacman (whichever is present)
//!
//! `brew`/`pkg_mgr` field reflects whether a usable package manager exists; the
//! UI uses it to decide between showing [Install] buttons vs. download links.

use serde::Serialize;
use std::process::Command;

/// Build a Command that never flashes a console window on Windows. Every
/// subprocess we spawn (where/winget/reg/brew/apt…) goes through this; without
/// CREATE_NO_WINDOW, each one pops a cmd window on Windows. No-op elsewhere.
pub(crate) fn command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

#[derive(Serialize, Clone, Default)]
pub struct DepStatus {
    /// Whether a usable package manager is present (Homebrew / winget / apt…).
    pub brew: bool,
    pub jackett: bool,
    pub qbittorrent: bool,
    /// Human label for the detected package manager (shown in the UI).
    pub pkg_mgr: String,
}

/// Official download pages, used as the fallback when no package manager works.
pub const JACKETT_URL: &str = "https://github.com/Jackett/Jackett/releases/latest";
pub const QBITTORRENT_URL: &str = "https://www.qbittorrent.org/download";

/// Does `cmd` exist on PATH? (Used by the Windows/Linux modules.)
#[allow(dead_code)]
fn has_cmd(cmd: &str) -> bool {
    let probe = if cfg!(windows) { "where" } else { "which" };
    command(probe)
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

// ───────────────────────── macOS (Homebrew) ─────────────────────────
#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::path::Path;

    pub fn pkg_mgr_label() -> Option<String> {
        brew_path().map(|_| "Homebrew".to_string())
    }

    /// brew lives outside a GUI app's PATH; check both arch locations.
    pub fn brew_path() -> Option<String> {
        for p in ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"] {
            if Path::new(p).exists() {
                return Some(p.to_string());
            }
        }
        None
    }

    fn brew_list_has(name: &str) -> bool {
        let Some(brew) = brew_path() else { return false };
        command(&brew)
            .args(["list", name])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }

    pub fn jackett_installed() -> bool {
        brew_list_has("jackett") || Path::new("/Applications/Jackett.app").exists()
    }

    pub fn qbittorrent_installed() -> bool {
        Path::new("/Applications/qbittorrent.app").exists() || brew_list_has("qbittorrent")
    }

    pub fn install(name: &str) -> Result<String, String> {
        let brew = brew_path()
            .ok_or("Homebrew not found. Install it from https://brew.sh, then Refresh.")?;
        let args: Vec<&str> = match name {
            "jackett" => vec!["install", "jackett"],
            "qbittorrent" => vec!["install", "--cask", "qbittorrent"],
            other => return Err(format!("Unknown dependency: {other}")),
        };
        run(&brew, &args, name)
    }

    pub fn start_jackett_service() {
        if let Some(brew) = brew_path() {
            let _ = command(&brew).args(["services", "start", "jackett"]).output();
        }
    }
}

// ───────────────────────── Windows (winget) ─────────────────────────
#[cfg(target_os = "windows")]
mod platform {
    use super::*;

    pub fn pkg_mgr_label() -> Option<String> {
        has_cmd("winget").then(|| "winget".to_string())
    }

    /// winget reports installed packages; grep its list output.
    fn winget_has(id: &str) -> bool {
        command("winget")
            .args(["list", "--id", id, "-e"])
            .output()
            .map(|o| o.status.success() && String::from_utf8_lossy(&o.stdout).contains(id))
            .unwrap_or(false)
    }

    pub fn jackett_installed() -> bool {
        winget_has("Jackett.Jackett")
    }

    pub fn qbittorrent_installed() -> bool {
        winget_has("qBittorrent.qBittorrent")
    }

    pub fn install(name: &str) -> Result<String, String> {
        if !has_cmd("winget") {
            return Err("winget not found. Install the dependency from its download page, then Refresh.".into());
        }
        let id = match name {
            "jackett" => "Jackett.Jackett",
            "qbittorrent" => "qBittorrent.qBittorrent",
            other => return Err(format!("Unknown dependency: {other}")),
        };
        run(
            "winget",
            &["install", "-e", "--id", id, "--accept-package-agreements", "--accept-source-agreements"],
            name,
        )
    }

    pub fn start_jackett_service() {
        // The Jackett winget package installs a Windows service that autostarts.
    }
}

// ───────────────────────── Linux (apt/dnf/pacman) ─────────────────────────
#[cfg(target_os = "linux")]
mod platform {
    use super::*;

    fn detect_mgr() -> Option<&'static str> {
        for m in ["apt-get", "dnf", "pacman"] {
            if has_cmd(m) {
                return Some(m);
            }
        }
        None
    }

    pub fn pkg_mgr_label() -> Option<String> {
        detect_mgr().map(|m| m.to_string())
    }

    pub fn jackett_installed() -> bool {
        has_cmd("jackett") || has_cmd("Jackett")
    }

    pub fn qbittorrent_installed() -> bool {
        has_cmd("qbittorrent") || has_cmd("qbittorrent-nox")
    }

    pub fn install(name: &str) -> Result<String, String> {
        let mgr = detect_mgr()
            .ok_or("No supported package manager (apt/dnf/pacman). Install the dependency manually, then Refresh.")?;
        // Package names differ a little across distros; these cover the common case.
        let pkg = match (name, mgr) {
            ("qbittorrent", _) => "qbittorrent",
            ("jackett", _) => "jackett",
            (other, _) => return Err(format!("Unknown dependency: {other}")),
        };
        // Most installs need root; use pkexec for a GUI password prompt, else sudo.
        let elevate = if has_cmd("pkexec") { "pkexec" } else { "sudo" };
        let args: Vec<&str> = match mgr {
            "apt-get" => vec![elevate, "apt-get", "install", "-y", pkg],
            "dnf" => vec![elevate, "dnf", "install", "-y", pkg],
            "pacman" => vec![elevate, "pacman", "-S", "--noconfirm", pkg],
            _ => unreachable!(),
        };
        run(args[0], &args[1..], name)
    }

    pub fn start_jackett_service() {
        // Best-effort: try a systemd user/system service if packaged that way.
        let _ = command("systemctl").args(["--user", "start", "jackett"]).output();
    }
}

/// Shared install runner: spawn `cmd args…`, map success/failure to Result.
fn run(cmd: &str, args: &[&str], name: &str) -> Result<String, String> {
    let out = command(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run {cmd}: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() {
        if name == "jackett" {
            start_jackett_service();
        }
        Ok(format!("{stdout}\n{stderr}"))
    } else {
        Err(format!("{cmd} {} failed:\n{stderr}", args.join(" ")))
    }
}

// ───────────────────────── public API ─────────────────────────

/// Snapshot of dependency states for the UI.
pub fn check() -> DepStatus {
    let label = platform::pkg_mgr_label();
    DepStatus {
        brew: label.is_some(),
        jackett: platform::jackett_installed(),
        qbittorrent: platform::qbittorrent_installed(),
        pkg_mgr: label.unwrap_or_else(|| "none".to_string()),
    }
}

/// Install a dependency via the platform package manager.
pub fn install(name: &str) -> Result<String, String> {
    platform::install(name)
}

/// Ensure Jackett's background service is running (idempotent, best-effort).
pub fn start_jackett_service() {
    platform::start_jackett_service();
}

/// Official download page for a dependency (UI fallback when no pkg manager).
pub fn download_url(name: &str) -> &'static str {
    match name {
        "jackett" => JACKETT_URL,
        "qbittorrent" => QBITTORRENT_URL,
        _ => "",
    }
}
