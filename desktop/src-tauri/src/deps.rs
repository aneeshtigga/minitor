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
    /// Jackett is actually answering on its port — installed-but-stopped is a
    /// real state on Windows (the service doesn't always run), and the UI must
    /// distinguish it from healthy.
    pub jackett_running: bool,
    pub qbittorrent: bool,
    /// Human label for the detected package manager (shown in the UI).
    pub pkg_mgr: String,
}

/// Is Jackett answering on its default port? A plain TCP connect to loopback
/// settles in microseconds (refused) or `timeout` at worst; no HTTP needed.
pub fn jackett_reachable() -> bool {
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;
    let addr: SocketAddr = ([127, 0, 0, 1], 9117).into();
    TcpStream::connect_timeout(&addr, Duration::from_millis(400)).is_ok()
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

// ───────────────────────── macOS (Homebrew / direct download) ─────────────────────────
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

    /// Install directory used when downloading Jackett directly (no Homebrew).
    fn jackett_direct_dir() -> String {
        let home = std::env::var("HOME").unwrap_or_else(|_| "~".to_string());
        format!("{home}/Applications/Jackett")
    }

    fn jackett_direct_bin() -> String {
        format!("{}/jackett", jackett_direct_dir())
    }

    pub fn jackett_installed() -> bool {
        brew_list_has("jackett")
            || Path::new("/Applications/Jackett.app").exists()
            || Path::new(&jackett_direct_bin()).exists()
    }

    fn qbittorrent_app_path() -> Option<String> {
        let home = std::env::var("HOME").unwrap_or_default();
        for p in [
            "/Applications/qBittorrent.app",
            "/Applications/qbittorrent.app",
            &format!("{home}/Applications/qBittorrent.app"),
            &format!("{home}/Applications/qbittorrent.app"),
        ] {
            if Path::new(p).exists() {
                return Some(p.to_string());
            }
        }
        None
    }

    pub fn qbittorrent_installed() -> bool {
        brew_list_has("qbittorrent") || qbittorrent_app_path().is_some()
    }

    pub fn install(name: &str) -> Result<String, String> {
        match name {
            // Both downloaded directly from GitHub — avoids Homebrew, which
            // calls xcrun internally and requires Xcode Command Line Tools.
            "jackett" => install_jackett_direct(),
            "qbittorrent" => install_qbittorrent_direct(),
            other => Err(format!("Unknown dependency: {other}")),
        }
    }

    fn install_qbittorrent_direct() -> Result<String, String> {
        let arch_pat = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x86_64" };

        // Resolve the latest release DMG URL via the GitHub API.
        let api = command("/usr/bin/curl")
            .args([
                "-fsSL",
                "-H", "Accept: application/vnd.github+json",
                "https://api.github.com/repos/qbittorrent/qBittorrent/releases/latest",
            ])
            .output()
            .map_err(|e| format!("Failed to fetch release info: {e}"))?;
        if !api.status.success() {
            return Err(format!(
                "Could not fetch qBittorrent release info:\n{}",
                String::from_utf8_lossy(&api.stderr)
            ));
        }
        let json = String::from_utf8_lossy(&api.stdout);
        let url = extract_download_url(&json, arch_pat, ".dmg")
            .ok_or_else(|| format!("No macOS {arch_pat} DMG found in latest qBittorrent release"))?;

        // Download the DMG.
        let tmp = "/tmp/qbittorrent-installer.dmg";
        let dl = command("/usr/bin/curl")
            .args(["-fsSL", "-o", tmp, &url])
            .output()
            .map_err(|e| format!("Download failed: {e}"))?;
        if !dl.status.success() {
            return Err(format!(
                "qBittorrent download failed:\n{}",
                String::from_utf8_lossy(&dl.stderr)
            ));
        }

        // Mount, copy .app, unmount — all with system tools (no Xcode needed).
        let mount = command("/usr/bin/hdiutil")
            .args(["attach", "-nobrowse", "-quiet", "-plist", tmp])
            .output()
            .map_err(|e| format!("hdiutil attach failed: {e}"))?;
        if !mount.status.success() {
            let _ = std::fs::remove_file(tmp);
            return Err(format!(
                "Could not mount DMG:\n{}",
                String::from_utf8_lossy(&mount.stderr)
            ));
        }
        let plist = String::from_utf8_lossy(&mount.stdout);
        let volume = extract_plist_string(&plist, "mount-point")
            .ok_or_else(|| "Could not determine DMG mount point".to_string())?;

        let app_src = find_app_in_dir(&volume)
            .ok_or_else(|| format!("No .app found in mounted volume {volume}"))?;
        let app_name = std::path::Path::new(&app_src)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("qBittorrent.app");

        let home = std::env::var("HOME").unwrap_or_else(|_| "~".to_string());
        let apps_dir = format!("{home}/Applications");
        let _ = std::fs::create_dir_all(&apps_dir);
        let app_dest = format!("{apps_dir}/{app_name}");

        let cp = command("/bin/cp")
            .args(["-r", &app_src, &app_dest])
            .output()
            .map_err(|e| format!("Copy failed: {e}"))?;

        // Always detach and clean up, even if copy failed.
        let _ = command("/usr/bin/hdiutil").args(["detach", &volume, "-quiet"]).output();
        let _ = std::fs::remove_file(tmp);

        if !cp.status.success() {
            return Err(format!(
                "Could not copy app:\n{}",
                String::from_utf8_lossy(&cp.stderr)
            ));
        }

        // Remove the quarantine flag curl adds on downloaded files.
        let _ = command("/usr/bin/xattr")
            .args(["-dr", "com.apple.quarantine", &app_dest])
            .output();

        Ok(format!("qBittorrent installed to {app_dest}"))
    }

    /// Extract the first `browser_download_url` from a GitHub releases JSON
    /// response that matches both `arch_pat` and `ext`.
    fn extract_download_url(json: &str, arch_pat: &str, ext: &str) -> Option<String> {
        for chunk in json.split("browser_download_url") {
            if let Some(start) = chunk.find("https://") {
                if let Some(end) = chunk[start..].find('"') {
                    let url = &chunk[start..start + end];
                    if url.contains(arch_pat) && url.ends_with(ext) {
                        return Some(url.to_string());
                    }
                }
            }
        }
        None
    }

    /// Pull a string value out of an hdiutil plist by key name.
    fn extract_plist_string(plist: &str, key: &str) -> Option<String> {
        let marker = format!("{key}</key>");
        let pos = plist.find(&marker)?;
        let after = &plist[pos + marker.len()..];
        let start = after.find("<string>")? + "<string>".len();
        let end = after[start..].find("</string>")?;
        Some(after[start..start + end].trim().to_string())
    }

    /// Return the path of the first `.app` bundle found directly inside `dir`.
    fn find_app_in_dir(dir: &str) -> Option<String> {
        for entry in std::fs::read_dir(dir).ok()?.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().ends_with(".app") {
                return Some(entry.path().to_string_lossy().to_string());
            }
        }
        None
    }

    fn install_jackett_direct() -> Result<String, String> {
        let asset = if std::env::consts::ARCH == "aarch64" {
            "Jackett.Binaries.macOSARM64.tar.gz"
        } else {
            "Jackett.Binaries.macOS.tar.gz"
        };
        let url = format!(
            "https://github.com/Jackett/Jackett/releases/download/v0.24.2043/{asset}"
        );
        let dir = jackett_direct_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create install directory: {e}"))?;

        let tmp = format!("{dir}/jackett-install.tar.gz");

        let dl = command("/usr/bin/curl")
            .args(["-fsSL", "-o", &tmp, &url])
            .output()
            .map_err(|e| format!("Download failed: {e}"))?;
        if !dl.status.success() {
            return Err(format!(
                "Jackett download failed:\n{}",
                String::from_utf8_lossy(&dl.stderr)
            ));
        }

        let ex = command("/usr/bin/tar")
            .args(["-xzf", &tmp, "-C", &dir])
            .output()
            .map_err(|e| format!("Extraction failed: {e}"))?;
        let _ = std::fs::remove_file(&tmp);
        if !ex.status.success() {
            return Err(format!(
                "Jackett extraction failed:\n{}",
                String::from_utf8_lossy(&ex.stderr)
            ));
        }

        start_jackett_service();
        Ok(format!("Jackett installed to {dir}"))
    }

    pub fn start_jackett_service() {
        // Prefer the brew-managed service if brew-installed; otherwise run the
        // directly-downloaded binary.
        if brew_list_has("jackett") {
            if let Some(brew) = brew_path() {
                let _ = command(&brew).args(["services", "start", "jackett"]).output();
                return;
            }
        }
        let bin = jackett_direct_bin();
        if Path::new(&bin).exists() {
            // --NoUpdates: skip Jackett's self-update (we pin a version); see the
            // Windows start_jackett_service for the full rationale.
            let _ = command(&bin).arg("--NoUpdates").spawn();
        }
    }
}

// ───────────────────────── Windows (direct download) ─────────────────────────
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
        winget_has("Jackett.Jackett") || jackett_console_path().is_some()
    }

    pub fn qbittorrent_installed() -> bool {
        winget_has("qBittorrent.qBittorrent")
    }

    pub fn install(name: &str) -> Result<String, String> {
        match name {
            "jackett" => install_jackett_direct(),
            "qbittorrent" => {
                if !has_cmd("winget") {
                    return Err("winget not found. Install qBittorrent from its download page, then Refresh.".into());
                }
                run(
                    "winget",
                    &["install", "-e", "--id", "qBittorrent.qBittorrent",
                      "--accept-package-agreements", "--accept-source-agreements"],
                    name,
                )
            }
            other => Err(format!("Unknown dependency: {other}")),
        }
    }

    fn install_jackett_direct() -> Result<String, String> {
        let url = "https://github.com/Jackett/Jackett/releases/download/v0.24.2043/Jackett.Installer.Windows.exe";
        let tmp = std::env::temp_dir().join("jackett-installer.exe");
        let tmp_str = tmp.to_string_lossy().to_string();

        let dl = command("curl")
            .args(["-fsSL", "-o", &tmp_str, url])
            .output()
            .map_err(|e| format!("Download failed: {e}"))?;
        if !dl.status.success() {
            return Err(format!(
                "Jackett download failed:\n{}",
                String::from_utf8_lossy(&dl.stderr)
            ));
        }

        // Run the NSIS installer silently. Start-Process -Verb RunAs is required
        // to trigger the UAC elevation prompt — CreateProcess alone won't do it.
        let ps_cmd = format!(
            "Start-Process -FilePath '{}' -ArgumentList '/S' -Verb RunAs -Wait",
            tmp_str.replace('\'', "''")
        );
        let install = command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps_cmd])
            .output()
            .map_err(|e| format!("Installer failed: {e}"))?;
        let _ = std::fs::remove_file(&tmp);

        if !install.status.success() {
            return Err(format!(
                "Jackett installer failed:\n{}",
                String::from_utf8_lossy(&install.stderr)
            ));
        }

        start_jackett_service();
        Ok("Jackett installed".to_string())
    }

    /// Bring Jackett up. The winget package installs a Windows service, but
    /// "installed" ≠ "running": the service is regularly found Stopped (failed
    /// boot start, user stopped it, install session never started it). Try, in
    /// order: already answering → done; `sc start` (works when elevated or the
    /// service ACL allows); else run JackettConsole.exe directly — it lives in
    /// %ProgramData%\Jackett next to the SAME config the service uses, and
    /// needs no elevation.
    pub fn start_jackett_service() {
        if jackett_reachable() {
            return;
        }
        // A standalone Jackett may already be starting up (not listening yet).
        if process_running("JackettConsole.exe") || process_running("jackett.exe") {
            return;
        }
        let service_started = command("sc")
            .args(["start", "Jackett"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if service_started {
            return;
        }
        if let Some(exe) = jackett_console_path() {
            // --NoUpdates: we pin a Jackett version (see install_jackett_direct);
            // its hourly self-update kills this process to run JackettUpdater.exe,
            // which fails for a non-elevated console launch and leaves Jackett down.
            let _ = command(&exe).arg("--NoUpdates").spawn();
        }
    }

    fn process_running(image: &str) -> bool {
        command("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_lowercase().contains(&image.to_lowercase()))
            .unwrap_or(false)
    }

    fn jackett_console_path() -> Option<String> {
        let program_data =
            std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".to_string());
        for dir in [
            format!(r"{program_data}\Jackett"),
            r"C:\Program Files\Jackett".to_string(),
        ] {
            let p = format!(r"{dir}\JackettConsole.exe");
            if std::path::Path::new(&p).exists() {
                return Some(p);
            }
        }
        None
    }
}

// ───────────────────────── Linux (apt/dnf/pacman + direct download) ─────────────────────────
#[cfg(target_os = "linux")]
mod platform {
    use super::*;
    use std::path::Path;

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

    fn jackett_direct_dir() -> String {
        let home = std::env::var("HOME").unwrap_or_else(|_| "~".to_string());
        format!("{home}/.local/share/Jackett")
    }

    fn jackett_direct_bin() -> String {
        format!("{}/jackett", jackett_direct_dir())
    }

    pub fn jackett_installed() -> bool {
        has_cmd("jackett") || has_cmd("Jackett") || Path::new(&jackett_direct_bin()).exists()
    }

    pub fn qbittorrent_installed() -> bool {
        has_cmd("qbittorrent") || has_cmd("qbittorrent-nox")
    }

    pub fn install(name: &str) -> Result<String, String> {
        match name {
            // Jackett is not in standard distro repos — download directly.
            "jackett" => install_jackett_direct(),
            "qbittorrent" => {
                let mgr = detect_mgr().ok_or(
                    "No supported package manager (apt/dnf/pacman). Install qBittorrent manually, then Refresh.",
                )?;
                let elevate = if has_cmd("pkexec") { "pkexec" } else { "sudo" };
                let args: Vec<&str> = match mgr {
                    "apt-get" => vec![elevate, "apt-get", "install", "-y", "qbittorrent"],
                    "dnf"     => vec![elevate, "dnf",     "install", "-y", "qbittorrent"],
                    "pacman"  => vec![elevate, "pacman",  "-S", "--noconfirm", "qbittorrent"],
                    _ => unreachable!(),
                };
                run(args[0], &args[1..], name)
            }
            other => Err(format!("Unknown dependency: {other}")),
        }
    }

    fn install_jackett_direct() -> Result<String, String> {
        let asset = match std::env::consts::ARCH {
            "aarch64" => "Jackett.Binaries.LinuxARM64.tar.gz",
            "arm"     => "Jackett.Binaries.LinuxARM32.tar.gz",
            _         => "Jackett.Binaries.LinuxAMD64.tar.gz",
        };
        let url = format!(
            "https://github.com/Jackett/Jackett/releases/download/v0.24.2043/{asset}"
        );
        let dir = jackett_direct_dir();
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create install directory: {e}"))?;

        let tmp = format!("{dir}/jackett-install.tar.gz");

        let dl = command("curl")
            .args(["-fsSL", "-o", &tmp, &url])
            .output()
            .map_err(|e| format!("Download failed: {e}"))?;
        if !dl.status.success() {
            return Err(format!(
                "Jackett download failed:\n{}",
                String::from_utf8_lossy(&dl.stderr)
            ));
        }

        let ex = command("tar")
            .args(["-xzf", &tmp, "-C", &dir])
            .output()
            .map_err(|e| format!("Extraction failed: {e}"))?;
        let _ = std::fs::remove_file(&tmp);
        if !ex.status.success() {
            return Err(format!(
                "Jackett extraction failed:\n{}",
                String::from_utf8_lossy(&ex.stderr)
            ));
        }

        start_jackett_service();
        Ok(format!("Jackett installed to {dir}"))
    }

    pub fn start_jackett_service() {
        // Try a systemd user service first (covers distro packages).
        let via_systemd = command("systemctl")
            .args(["--user", "start", "jackett"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if via_systemd {
            return;
        }
        // Fall back to running the directly-downloaded binary.
        let bin = jackett_direct_bin();
        if Path::new(&bin).exists() {
            // --NoUpdates: skip Jackett's self-update (we pin a version); see the
            // Windows start_jackett_service for the full rationale.
            let _ = command(&bin).arg("--NoUpdates").spawn();
        }
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
        jackett_running: jackett_reachable(),
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
