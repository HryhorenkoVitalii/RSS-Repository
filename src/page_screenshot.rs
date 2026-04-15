//! Full-page PNG via headless Chromium (`--screenshot`). Used for “archive full page” instead of raw HTML.

use std::path::Path;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::chromium_binary::{chromium_wants_no_sandbox, resolve_chromium_binary};
use crate::env_util::env_explicitly_off;
use crate::rss::validate_feed_url;
use crate::screenshot_env::{chromium_timeout_secs, screenshot_max_height, screenshot_width};

/// Stored `article_contents.body` prefix for Chromium snapshot versions.
pub const CHROMIUM_SCREENSHOT_MARKER: &str = "<!--rss-repository:chromium-screenshot-->\n";

pub fn chromium_screenshot_body_html(media_src: &str) -> String {
    format!(
        r#"{}<div class="rss-chromium-screenshot"><p class="muted small">Снимок страницы (headless Chromium).</p><img src="{}" alt="Снимок страницы" loading="lazy" style="max-width:100%;height:auto;" /></div>"#,
        CHROMIUM_SCREENSHOT_MARKER,
        media_src.replace('"', "&quot;")
    )
}

pub fn chromium_screenshot_content_hash(body: &str) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(b"rss-repository:chromium-screenshot:v1:");
    h.update(body.as_bytes());
    h.finalize().to_vec()
}

/// Run headless Chromium and write a PNG. По умолчанию CDP: обрезка по `article`/`main` (без пустых полей по бокам).
/// `SCREENSHOT_USE_CDP=0` — старый режим: один кадр всего вьюпорта (`--screenshot`).
pub async fn capture_url_to_png(page_url: &str, out_png: &Path) -> Result<(), String> {
    let use_cdp = !env_explicitly_off("SCREENSHOT_USE_CDP");
    if use_cdp {
        match crate::chromium_cdp::capture_page_clip_png(page_url, out_png).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                tracing::warn!(error = %e, "CDP-скриншот не удался, пробуем CLI-режим");
            }
        }
    }
    capture_url_to_png_cli(page_url, out_png).await
}

/// Полный вьюпорт (без обрезки по контенту).
async fn capture_url_to_png_cli(page_url: &str, out_png: &Path) -> Result<(), String> {
    validate_feed_url(page_url).map_err(|e| e.to_string())?;
    let bin = resolve_chromium_binary()?;
    let w = screenshot_width();
    let h = screenshot_max_height();

    let mut cmd = Command::new(&bin);
    // `--window-size` must be one argv (`--window-size={w},{h}`). If split into two args, recent
    // Chromium treats `{w},{h}` as a second navigation target → exit 13 “Multiple targets…”.
    cmd.arg("--headless=new")
        .arg("--disable-gpu")
        // Podman/Docker: маленький /dev/shm → падения/зависания без этого флага.
        .arg("--disable-dev-shm-usage")
        .arg("--hide-scrollbars")
        .arg(format!("--window-size={w},{h}"))
        .arg(format!("--screenshot={}", out_png.display()))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    if chromium_wants_no_sandbox() {
        cmd.arg("--no-sandbox").arg("--disable-setuid-sandbox");
    }

    cmd.arg(page_url);

    let secs = chromium_timeout_secs();
    let run = cmd.output();
    let out = timeout(Duration::from_secs(secs), run)
        .await
        .map_err(|_| format!("таймаут Chromium ({secs} с)"))?
        .map_err(|e| format!("запуск Chromium: {e}"))?;

    if !out.status.success() {
        let mut err = String::from_utf8_lossy(&out.stderr).into_owned();
        if err.len() > 6000 {
            err.truncate(6000);
            err.push('…');
        }
        return Err(format!(
            "Chromium завершился с кодом {:?}: {}",
            out.status.code(),
            err.trim()
        ));
    }
    if !out_png.is_file() {
        return Err("Chromium не создал PNG (проверьте флаги и версию браузера)".into());
    }
    Ok(())
}

pub fn temp_screenshot_path() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("rss-repository-screenshot-{nanos}.png"))
}
