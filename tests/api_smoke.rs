//! Интеграционные проверки роутера (MariaDB/MySQL + миграции).
//!
//! По умолчанию тест помечен `#[ignore]`: нужен работающий сервер БД.
//! Пример (MariaDB с пробросом порта на хост при **первом** `podman run` БД):
//!   EXPOSE_MARIADB_PORT=3306 ./scripts/podman-run.sh   # затем в другом терминале:
//!   RSS_TEST_DATABASE_URL='mysql://rss:rss_dev_change_me@127.0.0.1:3306/rss_repository' \
//!     cargo test health_database_ok_and_openapi -- --ignored

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use reqwest::Client;
use rss_repository::{router, AppState};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use std::str::FromStr;
use tokio::sync::{broadcast, Semaphore};
use tower::ServiceExt;

async fn test_app() -> axum::Router {
    let url = std::env::var("RSS_TEST_DATABASE_URL")
        .or_else(|_| std::env::var("DATABASE_URL"))
        .expect("RSS_TEST_DATABASE_URL or DATABASE_URL for integration test");
    assert!(
        url.starts_with("mysql://"),
        "expected mysql:// URL, got {}",
        url
    );
    let opts = MySqlConnectOptions::from_str(&url)
        .expect("parse DATABASE_URL")
        .ssl_mode(MySqlSslMode::Disabled);
    let pool = MySqlPoolOptions::new()
        .max_connections(2)
        .connect_with(opts)
        .await
        .expect("mysql pool");
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
#[ignore = "needs RSS_TEST_DATABASE_URL or DATABASE_URL=mysql://... (running MariaDB)"]
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
