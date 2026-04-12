mod api;
mod feed;

use std::env;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::State;
use axum::http::header;
use axum::http::{HeaderValue, Method, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
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
}

fn cors_layer() -> CorsLayer {
    let layer = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
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

pub fn router(state: AppState) -> Router {
    Router::new()
        .nest("/api", api::routes())
        .route("/feed.xml", get(feed::rss_feed))
        .layer(cors_layer())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            log_http_request,
        ))
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
