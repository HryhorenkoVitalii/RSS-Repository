//! Поиск исполняемого файла Chromium / Chrome.

use std::path::{Path, PathBuf};

use crate::env_util::env_truthy;

fn path_if_executable(p: &Path) -> Option<PathBuf> {
    p.is_file().then(|| p.to_path_buf())
}

fn command_v_in_login_shell(cmd: &str) -> Option<PathBuf> {
    let out = std::process::Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {}", cmd))
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        return None;
    }
    path_if_executable(&PathBuf::from(s))
}

/// `CHROMIUM_PATH`, известные пути, затем `command -v` в login-`sh` и короткий `$PATH`.
pub fn resolve_chromium_binary() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("CHROMIUM_PATH") {
        let t = p.trim();
        if !t.is_empty() {
            let pb = PathBuf::from(t);
            if let Some(ok) = path_if_executable(&pb) {
                return Ok(ok);
            }
            return Err(format!(
                "CHROMIUM_PATH={t:?} не указывает на существующий файл"
            ));
        }
    }

    for fixed in [
        "/usr/bin/chromium",
        "/usr/bin/google-chrome-stable",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/brave-browser",
        "/usr/bin/microsoft-edge-stable",
        "/usr/bin/microsoft-edge",
        "/usr/local/bin/chromium",
        "/usr/local/bin/google-chrome-stable",
        "/snap/bin/chromium",
        "/opt/google/chrome/chrome",
    ] {
        if let Some(pb) = path_if_executable(Path::new(fixed)) {
            return Ok(pb);
        }
    }

    for name in [
        "chromium",
        "google-chrome-stable",
        "chromium-browser",
        "google-chrome",
        "brave-browser",
        "microsoft-edge-stable",
    ] {
        if let Some(pb) = command_v_in_login_shell(name) {
            return Ok(pb);
        }
        if let Ok(o) = std::process::Command::new(name).arg("--version").output() {
            if o.status.success() {
                return Ok(PathBuf::from(name));
            }
        }
    }

    Err(
        "не найден Chromium/Chrome: установите пакет (Arch: pacman -S chromium; Debian/Ubuntu: apt install \
         chromium или google-chrome-stable) или задайте CHROMIUM_PATH на исполняемый файл (например /usr/bin/chromium)"
            .into(),
    )
}

/// Добавить `--no-sandbox` при `CHROMIUM_NO_SANDBOX=1|true|yes`.
pub fn chromium_wants_no_sandbox() -> bool {
    env_truthy("CHROMIUM_NO_SANDBOX")
}
