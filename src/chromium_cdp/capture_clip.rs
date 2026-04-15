use std::path::Path;
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio_tungstenite::connect_async;

use crate::browser_http::{cdp_network_extra_headers_json, cdp_user_agent_parts, FetchProfile};
use crate::chromium_binary::{chromium_wants_no_sandbox, resolve_chromium_binary};
use crate::rss::validate_feed_url;
use crate::screenshot_env::{chromium_timeout_secs, screenshot_max_height, screenshot_width};
use crate::screenshot_trim::trim_solid_footer_png;

use super::devtools::parse_devtools_port;
use super::rpc::cdp_send_recv;

async fn kill_chrome(mut child: Child, profile: &Path) {
    let _ = child.start_kill();
    let _ = child.wait().await;
    let _ = std::fs::remove_dir_all(profile);
}

/// PNG clipped to the best main content node (`article` / `main` / …), so empty side gutters are omitted.
pub async fn capture_page_clip_png(page_url: &str, out_png: &Path) -> Result<(), String> {
    validate_feed_url(page_url).map_err(|e| e.to_string())?;
    let bin = resolve_chromium_binary()?;
    let vw = screenshot_width();
    let max_h = screenshot_max_height();

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let profile = std::env::temp_dir().join(format!("rss-chromium-cdp-{nanos}"));
    if let Err(e) = std::fs::create_dir_all(&profile) {
        return Err(format!("профиль Chromium: {e}"));
    }

    let mut cmd = Command::new(&bin);
    cmd.arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--remote-debugging-port=0")
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    if chromium_wants_no_sandbox() {
        cmd.arg("--no-sandbox").arg("--disable-setuid-sandbox");
    }

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&profile);
            return Err(format!("запуск Chromium: {e}"));
        }
    };

    let stderr = match child.stderr.take() {
        Some(s) => s,
        None => {
            let _ = kill_chrome(child, &profile).await;
            return Err("Chromium: нет stderr".into());
        }
    };

    let mut stderr_reader = BufReader::new(stderr);
    let mut line = String::new();
    let port = loop {
        line.clear();
        let read_line = stderr_reader.read_line(&mut line);
        let n = match tokio::time::timeout(
            std::time::Duration::from_secs(20),
            read_line,
        )
        .await
        {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => {
                let _ = kill_chrome(child, &profile).await;
                return Err(format!("чтение stderr Chromium: {e}"));
            }
            Err(_) => {
                let _ = kill_chrome(child, &profile).await;
                return Err("таймаут: не дождались строки DevTools на stderr".into());
            }
        };
        if n == 0 {
            let _ = kill_chrome(child, &profile).await;
            return Err("Chromium завершился до строки DevTools".into());
        }
        if let Some(p) = parse_devtools_port(&line) {
            break p;
        }
    };

    let stderr_rest = stderr_reader.into_inner();
    tokio::spawn(async move {
        let mut r = stderr_rest;
        let mut buf = [0u8; 8192];
        loop {
            match r.read(&mut buf).await {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(chromium_timeout_secs()))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = kill_chrome(child, &profile).await;
            return Err(format!("reqwest: {e}"));
        }
    };

    let new_url = format!("http://127.0.0.1:{port}/json/new");
    let tab: Value = match http.get(&new_url).send().await {
        Ok(r) => match r.json().await {
            Ok(v) => v,
            Err(e) => {
                let _ = kill_chrome(child, &profile).await;
                return Err(format!("json/new JSON: {e}"));
            }
        },
        Err(e) => {
            let _ = kill_chrome(child, &profile).await;
            return Err(format!("json/new: {e}"));
        }
    };

    let ws_url = match tab
        .get("webSocketDebuggerUrl")
        .and_then(|x| x.as_str())
    {
        Some(u) => u.to_string(),
        None => {
            let _ = kill_chrome(child, &profile).await;
            return Err("json/new: нет webSocketDebuggerUrl".into());
        }
    };

    let (ws, _) = match connect_async(&ws_url).await {
        Ok(p) => p,
        Err(e) => {
            let _ = kill_chrome(child, &profile).await;
            return Err(format!("WebSocket CDP: {e}"));
        }
    };

    let (mut write, mut read) = ws.split();

    let inner = async {
        cdp_send_recv(&mut write, &mut read, "Page.enable", json!({})).await?;
        cdp_send_recv(&mut write, &mut read, "Runtime.enable", json!({})).await?;
        cdp_send_recv(&mut write, &mut read, "Network.enable", json!({})).await?;

        let (ua, lang, platform) = cdp_user_agent_parts();
        cdp_send_recv(
            &mut write,
            &mut read,
            "Emulation.setUserAgentOverride",
            json!({
                "userAgent": ua,
                "acceptLanguage": lang,
                "platform": platform,
            }),
        )
        .await?;

        let extra = cdp_network_extra_headers_json(FetchProfile::ArticleHtml, page_url)?;
        cdp_send_recv(
            &mut write,
            &mut read,
            "Network.setExtraHTTPHeaders",
            json!({ "headers": extra }),
        )
        .await?;

        cdp_send_recv(
            &mut write,
            &mut read,
            "Emulation.setDeviceMetricsOverride",
            json!({
                "width": vw,
                "height": 900_i32,
                "deviceScaleFactor": 1,
                "mobile": false,
            }),
        )
        .await?;

        cdp_send_recv(
            &mut write,
            &mut read,
            "Page.navigate",
            json!({ "url": page_url }),
        )
        .await?;

        let mut ready_ok = false;
        for _ in 0..120 {
            let ready = cdp_send_recv(
                &mut write,
                &mut read,
                "Runtime.evaluate",
                json!({
                    "expression": "document.readyState",
                    "returnByValue": true,
                }),
            )
            .await?;
            let st = ready
                .pointer("/result/value")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if st == "complete" {
                ready_ok = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        if !ready_ok {
            return Err("таймаут загрузки страницы (document.readyState)".into());
        }

        let expr = include_str!("clip_rect.js").replace("@@MAX_H@@", &max_h.to_string());

        let clip_val = cdp_send_recv(
            &mut write,
            &mut read,
            "Runtime.evaluate",
            json!({
                "expression": expr,
                "returnByValue": true,
            }),
        )
        .await?;

        let obj = clip_val
            .pointer("/result/value")
            .ok_or_else(|| "clip: нет result.value".to_string())?;

        let mut x = obj.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let mut y = obj.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let mut w = obj.get("w").and_then(|v| v.as_f64()).unwrap_or(vw as f64);
        let mut h = obj.get("h").and_then(|v| v.as_f64()).unwrap_or(800.0);

        if !(w.is_finite() && h.is_finite() && x.is_finite() && y.is_finite()) || w < 1.0 || h < 1.0
        {
            return Err("clip: некорректные размеры от JS".into());
        }

        w = w.clamp(1.0, 8192.0);
        h = h.clamp(1.0, f64::from(max_h.min(32_767)));
        x = x.max(0.0);
        y = y.max(0.0);

        let shot = cdp_send_recv(
            &mut write,
            &mut read,
            "Page.captureScreenshot",
            json!({
                "format": "png",
                "captureBeyondViewport": true,
                "fromSurface": true,
                "clip": {
                    "x": x,
                    "y": y,
                    "width": w,
                    "height": h,
                    "scale": 1.0
                }
            }),
        )
        .await?;

        let b64 = shot
            .get("data")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "captureScreenshot: нет data".to_string())?;

        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("base64 PNG: {e}"))?;

        let out_bytes = match trim_solid_footer_png(&bytes) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(error = %e, "обрезка однотонного низа PNG пропущена");
                bytes
            }
        };

        std::fs::write(out_png, &out_bytes).map_err(|e| format!("запись PNG: {e}"))?;

        let _ = write.close().await;
        Ok(())
    }
    .await;

    let _ = kill_chrome(child, &profile).await;
    inner
}
