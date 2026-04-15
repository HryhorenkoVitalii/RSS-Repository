mod api;
mod feed;
pub(crate) mod poll_spawn;

use std::env;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::header;
use axum::http::{HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use sqlx::SqlitePool;
use tokio::sync::{broadcast, Semaphore};
use tower_http::cors::{AllowOrigin, Any, CorsLayer};

use crate::db;

#[derive(Debug, Clone, serde::Serialize)]
pub struct PollEvent {
    pub feed_id: i64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub(super) fn base_url_from_headers(headers: &axum::http::HeaderMap) -> String {
    if let Ok(v) = env::var("PUBLIC_BASE_URL") {
        let s = v.trim().trim_end_matches('/');
        if !s.is_empty() {
            return s.to_string();
        }
    }
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost:8080");
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("http");
    format!("{scheme}://{host}")
}

#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub http: reqwest::Client,
    /// One writer at a time for SQLite (avoids SQLITE_BUSY / SQLITE_BUSY_SNAPSHOT under concurrent polls).
    pub db_write: Arc<Semaphore>,
    pub poll_events: Arc<broadcast::Sender<PollEvent>>,
    /// Global concurrency limiter for poll operations (API + scheduler).
    pub poll_semaphore: Arc<Semaphore>,
    /// Optional API key; if set, every request must provide it via `Authorization: Bearer <key>`.
    pub api_key: Option<Arc<str>>,
}

fn cors_layer() -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any);
    if let Ok(s) = env::var("FRONTEND_ORIGIN") {
        let s = s.trim();
        if !s.is_empty() {
            if let Ok(v) = s.parse::<HeaderValue>() {
                return layer.allow_origin(AllowOrigin::exact(v));
            }
        }
    }
    layer.allow_origin(AllowOrigin::any())
}

async fn require_api_key(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let key = match &state.api_key {
        Some(k) => k,
        None => return next.run(req).await,
    };
    let path = req.uri().path();
    if path == "/api/health"
        || path == "/api/openapi.json"
        || path.starts_with("/api/media/")
    {
        return next.run(req).await;
    }

    let auth = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok());
    let provided = auth
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(|s| s.trim())
        .or_else(|| {
            req.uri()
                .query()
                .and_then(|q| {
                    q.split('&')
                        .find_map(|pair| pair.strip_prefix("token="))
                })
        });

    match provided {
        Some(tok) if tok == key.as_ref() => next.run(req).await,
        _ => (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer")],
            "unauthorized",
        )
            .into_response(),
    }
}

async fn security_headers(req: Request<Body>, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert("X-Content-Type-Options", HeaderValue::from_static("nosniff"));
    h.insert("X-Frame-Options", HeaderValue::from_static("DENY"));
    h.insert("Referrer-Policy", HeaderValue::from_static("strict-origin-when-cross-origin"));
    h.insert(
        "Permissions-Policy",
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    res
}

async fn request_id_middleware(req: Request<Body>, next: Next) -> Response {
    let mut res = next.run(req).await;
    let id = format!(
        "{:x}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let short = if id.len() > 24 {
        id[id.len() - 24..].to_string()
    } else {
        id
    };
    if let Ok(hv) = HeaderValue::from_str(&short) {
        res.headers_mut().insert(header::HeaderName::from_static("x-request-id"), hv);
    }
    res
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .nest("/api", api::routes())
        .route("/feed.xml", get(feed::rss_feed))
        .layer(middleware::from_fn(security_headers))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            require_api_key,
        ))
        .layer(cors_layer())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            log_http_request,
        ))
        .layer(middleware::from_fn(request_id_middleware))
        .with_state(state)
}

async fn log_http_request(
    State(state): State<AppState>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let method = req.method().clone();
    let uri = req.uri().clone();
    let path = uri
        .path_and_query()
        .map(|pq| pq.as_str().to_string())
        .unwrap_or_else(|| uri.path().to_string());

    let pool = state.pool.clone();
    let db_write = state.db_write.clone();
    let start = std::time::Instant::now();
    let response = next.run(req).await;
    let duration_ms = start.elapsed().as_millis() as i64;
    let status = i64::from(response.status().as_u16());

    tokio::spawn(async move {
        if let Err(e) = db::insert_request_log(
            db_write.as_ref(),
            &pool,
            method.as_str(),
            &path,
            status,
            duration_ms,
        )
        .await
        {
            tracing::warn!(error = %e, "request_log insert failed");
        }
    });

    response
}
