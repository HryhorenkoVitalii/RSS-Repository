//! Ограниченные повторы HTTP GET (RSS, HTML страницы, медиа) при сетевых сбоях и 408/429/5xx.

use std::time::Duration;

use reqwest::{RequestBuilder, Response, StatusCode};

pub fn max_attempts() -> u32 {
    std::env::var("HTTP_RETRY_MAX_ATTEMPTS")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(3)
        .clamp(1, 8)
}

fn base_delay_ms() -> u64 {
    std::env::var("HTTP_RETRY_BASE_MS")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(300)
        .clamp(50, 10_000)
}

fn retriable_status(status: StatusCode) -> bool {
    status == StatusCode::REQUEST_TIMEOUT
        || status == StatusCode::TOO_MANY_REQUESTS
        || status == StatusCode::BAD_GATEWAY
        || status == StatusCode::SERVICE_UNAVAILABLE
        || status == StatusCode::GATEWAY_TIMEOUT
}

fn retriable_reqwest(err: &reqwest::Error) -> bool {
    err.is_connect() || err.is_timeout()
}

/// Выполнить запрос из свежего `RequestBuilder` на каждую попытку (без повторного использования тела).
pub async fn send_with_retries(
    mut build: impl FnMut() -> RequestBuilder,
) -> Result<Response, reqwest::Error> {
    let max = max_attempts();
    let base = base_delay_ms();
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        let resp = match build().send().await {
            Ok(r) => r,
            Err(e) if attempt < max && retriable_reqwest(&e) => {
                let d = base.saturating_mul(1u64 << (attempt - 1).min(6));
                tokio::time::sleep(Duration::from_millis(d)).await;
                continue;
            }
            Err(e) => return Err(e),
        };

        let status = resp.status();
        if attempt < max && retriable_status(status) {
            drop(resp);
            let d = base.saturating_mul(1u64 << (attempt - 1).min(6));
            tokio::time::sleep(Duration::from_millis(d)).await;
            continue;
        }

        return Ok(resp);
    }
}
