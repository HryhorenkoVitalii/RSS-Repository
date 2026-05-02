//! Сценарии как у фронтенда: HTTP к `/api/*` с реальной MariaDB (типы sqlx, миграции, записи).
//!
//! **Режим 1 (по умолчанию):** поднимает контейнер `mariadb:11` через Testcontainers — нужен Docker/Podman socket.
//!
//! **Режим 2:** задайте `RSS_TEST_DATABASE_URL=mysql://user:pass@host:3306/db` — контейнер не стартует,
//! используется ваш сервер (как в проде).
//!
//! Запуск:
//! ```text
//! cargo test --test ui_api_database -- --nocapture
//! ```

use std::path::Path;
use std::sync::{Arc, Once};

use axum::body::Body;
use axum::http::{header, Request, StatusCode};
use reqwest::Client;
use rss_repository::{router, AppState};
use sqlx::mysql::{MySqlConnectOptions, MySqlPoolOptions, MySqlSslMode};
use std::str::FromStr;
use testcontainers::core::{IntoContainerPort, WaitFor};
use testcontainers::runners::AsyncRunner;
use testcontainers::{ContainerAsync, GenericImage, ImageExt, TestcontainersError};
use tokio::sync::{broadcast, Semaphore};
use tokio::time::Duration;
use tower::ServiceExt;
use url::Host;

const MARIADB_USER: &str = "rss_ui_test";
const MARIADB_PASSWORD: &str = "rss_ui_test_pwd";
const MARIADB_DATABASE: &str = "rss_ui_test";
const MARIADB_ROOT_PASSWORD: &str = "root_ui_test_pwd";

static INIT_DOCKER_HOST: Once = Once::new();

/// Podman часто не создаёт `/var/run/docker.sock`; без `DOCKER_HOST` Testcontainers не находит API.
fn ensure_docker_host_for_testcontainers() {
    INIT_DOCKER_HOST.call_once(|| {
        if std::env::var("DOCKER_HOST").map(|s| !s.trim().is_empty()).unwrap_or(false) {
            return;
        }
        let mut candidates: Vec<String> = Vec::new();
        if let Ok(rt) = std::env::var("XDG_RUNTIME_DIR") {
            candidates.push(format!("{rt}/podman/podman.sock"));
        }
        candidates.push("/var/run/podman/podman.sock".into());
        candidates.push("/var/run/docker.sock".into());
        for path in candidates {
            if Path::new(&path).exists() {
                let uri = format!("unix://{path}");
                // SAFETY: вызывается один раз на процесс через `Once`; до остальных потоков тестов.
                unsafe {
                    std::env::set_var("DOCKER_HOST", &uri);
                }
                eprintln!("ui_api_database: подставлен DOCKER_HOST={uri} для Testcontainers");
                return;
            }
        }
    });
}

async fn database_url_from_testcontainers(
) -> Result<(String, ContainerAsync<GenericImage>), TestcontainersError>
{
    let container = GenericImage::new("mariadb", "11")
        .with_exposed_port(3306.tcp())
        .with_wait_for(WaitFor::message_on_stderr("ready for connections"))
        .with_env_var("MARIADB_DATABASE", MARIADB_DATABASE)
        .with_env_var("MARIADB_USER", MARIADB_USER)
        .with_env_var("MARIADB_PASSWORD", MARIADB_PASSWORD)
        .with_env_var("MARIADB_ROOT_PASSWORD", MARIADB_ROOT_PASSWORD)
        .start()
        .await?;
    let host = container.get_host().await.expect("container host");
    let port = container
        .get_host_port_ipv4(3306.tcp())
        .await
        .expect("mapped 3306");
    let host_str = match host {
        Host::Ipv4(ip) => ip.to_string(),
        Host::Ipv6(ip) => format!("[{ip}]"),
        Host::Domain(d) => d.to_string(),
    };
    let url = format!(
        "mysql://{}:{}@{}:{}/{}",
        MARIADB_USER, MARIADB_PASSWORD, host_str, port, MARIADB_DATABASE
    );
    Ok((url, container))
}

async fn build_app(database_url: &str) -> axum::Router {
    // Локальный MariaDB/Testcontainers обычно без TLS; иначе sqlx даёт UnexpectedEof при рукопожатии.
    let opts = MySqlConnectOptions::from_str(database_url)
        .expect("parse DATABASE_URL")
        .ssl_mode(MySqlSslMode::Disabled);
    let mut last_err: Option<sqlx::Error> = None;
    let mut pool_opt = None;
    for _ in 0..45u32 {
        match MySqlPoolOptions::new()
            .max_connections(5)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(opts.clone())
            .await
        {
            Ok(p) => {
                pool_opt = Some(p);
                break;
            }
            Err(e) => {
                last_err = Some(e);
                tokio::time::sleep(Duration::from_millis(400)).await;
            }
        }
    }
    let pool = pool_opt.unwrap_or_else(|| {
        panic!(
            "MySqlPool::connect после ~45 попыток: {}\n\
             Проверьте Testcontainers/Podman и URL к БД (хост из `get_host()`, порт с mapping).",
            last_err
                .map(|e| e.to_string())
                .unwrap_or_else(|| "нет ошибки".into())
        )
    });
    sqlx::migrate!("./migrations")
        .run(&pool)
        .await
        .expect("migrations");
    let http = Client::new();
    let db_write = Arc::new(Semaphore::new(1));
    let (poll_tx, _) = broadcast::channel(8);
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
async fn ui_style_requests_match_database_and_http_layer() {
    let _container_guard: Option<ContainerAsync<GenericImage>>;
    let database_url: String = if let Ok(url) = std::env::var("RSS_TEST_DATABASE_URL") {
        assert!(
            url.starts_with("mysql://"),
            "RSS_TEST_DATABASE_URL must start with mysql://"
        );
        _container_guard = None;
        url
    } else {
        ensure_docker_host_for_testcontainers();
        match database_url_from_testcontainers().await {
            Ok((url, c)) => {
                _container_guard = Some(c);
                url
            }
            Err(e) => {
                eprintln!(
                    "SKIP ui_api_database: не удалось поднять MariaDB через Testcontainers: {e}\n\
                     Укажите RSS_TEST_DATABASE_URL=mysql://user:pass@host:3306/db (например БД из compose с пробросом порта)\n\
                     или установите Docker/Podman socket (часто /var/run/docker.sock)."
                );
                return;
            }
        }
    };

    let app = build_app(&database_url).await;

    // —— как страница списка статей / dashboard: health ——
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("health request");
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or_else(|e| {
        panic!(
            "health JSON parse: {e}, body={}",
            String::from_utf8_lossy(&body)
        )
    });
    assert_eq!(v["ok"], true, "health.ok — пул БД отвечает на SELECT 1");
    assert_eq!(v["database"], "ok", "health.database — декодирование sqlx без ошибок");

    // —— Feeds: список (пустой или нет) ——
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/feeds?page=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("list feeds");
    assert_eq!(res.status(), StatusCode::OK);
    let feeds_body = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let feeds_json: serde_json::Value = serde_json::from_slice(&feeds_body).unwrap();

    // —— Feeds: создать источник (форма «Add feed») ——
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let feed_url = format!("https://example.com/ui-db-test-{unique}.xml");
    let create_payload = serde_json::json!({
        "url": feed_url,
        "poll_interval_seconds": 600,
    })
    .to_string();
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/feeds")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(create_payload))
                .unwrap(),
        )
        .await
        .expect("create feed");
    assert_eq!(
        res.status(),
        StatusCode::CREATED,
        "POST /api/feeds должно вернуть 201 при валидном URL"
    );
    let created = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let created_json: serde_json::Value = serde_json::from_slice(&created).unwrap();
    let feed_id = created_json["id"].as_i64().expect("feed id");
    assert!(feed_id > 0);

    // —— снова список: COUNT и строки (проверка count_articles / list путей sqlx) ——
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/feeds?page=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("list feeds 2");
    assert_eq!(res.status(), StatusCode::OK);
    let feeds_body2 = axum::body::to_bytes(res.into_body(), usize::MAX)
        .await
        .unwrap();
    let feeds_json2: serde_json::Value = serde_json::from_slice(&feeds_body2).unwrap();
    let total = feeds_json2["total"].as_i64().unwrap();
    assert!(
        total >= 1,
        "total feeds после создания >= 1, было до создания: {:?}",
        feeds_json["total"]
    );

    // —— статьи: пустой список или с данными (SELECT с CAST полей) ——
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/articles?page=0")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("list articles");
    assert_eq!(
        res.status(),
        StatusCode::OK,
        "GET /api/articles не должно отдавать 500 из-за типов BIGINT/COUNT"
    );

    // —— опции фидов (лёгкий SELECT) ——
    let res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/feeds/options")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("feed options");
    assert_eq!(res.status(), StatusCode::OK);

    // —— теги ——
    let res = app
        .oneshot(
            Request::builder()
                .uri("/api/tags")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .expect("list tags");
    assert_eq!(res.status(), StatusCode::OK);
}
