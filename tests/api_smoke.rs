//! Интеграционные проверки роутера (in-memory SQLite + миграции).

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use reqwest::Client;
use rss_repository::{router, AppState};
use sqlx::sqlite::SqlitePoolOptions;
use tokio::sync::{broadcast, Semaphore};
use tower::ServiceExt;

async fn test_app() -> axum::Router {
    let pool = SqlitePoolOptions::new()
        .max_connections(2)
        .connect("sqlite::memory:")
        .await
        .expect("memory pool");
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");

    let http = Client::new();
    let db_write = Arc::new(Semaphore::new(1));
    let (poll_tx, _) = broadcast::channel(4);
    let state = AppState {
        pool,
        http,
        db_write,
        poll_events: Arc::new(poll_tx),
        poll_semaphore: Arc::new(Semaphore::new(5)),
        api_key: None,
    };
    router(state)
}

#[tokio::test]
async fn health_database_ok_and_openapi() {
    let app = test_app().await;
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("health");
    assert_eq!(res.status(), StatusCode::OK);
    assert!(
        res.headers().get("x-request-id").is_some(),
        "x-request-id header"
    );
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["ok"], true);
    assert_eq!(v["database"], "ok");

    let res2 = app
        .oneshot(
            Request::builder()
                .uri("/api/openapi.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("openapi");
    assert_eq!(res2.status(), StatusCode::OK);
    let body2 = axum::body::to_bytes(res2.into_body(), usize::MAX)
        .await
        .unwrap();
    let spec: serde_json::Value = serde_json::from_slice(&body2).unwrap();
    assert_eq!(spec["openapi"], "3.0.3");
}
