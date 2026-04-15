//! RSS Repository — библиотека для тестов и тонкого бинарного `main`.

mod env_util;
mod http_retry;
mod browser_http;
mod chromium_binary;
mod screenshot_env;
mod screenshot_trim;
mod article_expand;
pub mod db;
mod error;
mod ingest;
mod media;
mod chromium_cdp;
mod page_screenshot;
pub mod routes;
mod rss;
mod scheduler;
mod telegram;

pub use routes::{router, AppState};

use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use tokio::sync::Semaphore;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

fn sqlite_journal_mode() -> SqliteJournalMode {
    match std::env::var("SQLITE_JOURNAL_MODE") {
        Ok(s) => match s.trim().parse() {
            Ok(m) => {
                if m != SqliteJournalMode::Wal {
                    tracing::info!(?m, "SQLite journal mode (non-WAL)");
                }
                m
            }
            Err(_) => {
                tracing::warn!(
                    value = s.trim(),
                    "invalid SQLITE_JOURNAL_MODE; using WAL"
                );
                SqliteJournalMode::Wal
            }
        },
        Err(_) => SqliteJournalMode::Wal,
    }
}

pub async fn run() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    let log_filter = match tracing_subscriber::EnvFilter::try_from_default_env() {
        Ok(f) => f,
        Err(err) => {
            eprintln!("RUST_LOG is invalid ({err}); using default info");
            tracing_subscriber::EnvFilter::new("info,rss_repository=info")
        }
    };
    tracing_subscriber::registry()
        .with(log_filter)
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be set")?;

    let journal_mode = sqlite_journal_mode();
    let connect_options = SqliteConnectOptions::from_str(&database_url)
        .map_err(|e| format!("invalid DATABASE_URL: {e}"))?
        .create_if_missing(true)
        .foreign_keys(true)
        .busy_timeout(Duration::from_secs(15))
        .journal_mode(journal_mode)
        .synchronous(SqliteSynchronous::Normal);

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(connect_options)
        .await?;

    if let Err(e) = sqlx::migrate!("./migrations").run(&pool).await {
        let mut msg = format!("database migration failed: {e}");
        if error::error_chain_implies_readonly(&e) {
            msg.push_str(
                "\n\nSQLite READONLY (код 8): нет права записи в файл БД или в каталог (нужны файлы .db-wal / .db-shm рядом с базой). \
Длинное число в тексте ошибки — это версия миграции (префикс имени `migrations/*.sql`), а не отдельный «код ошибки».\n\
• Podman: том `-v …/data:/data:U` (см. scripts/podman-run.sh) или `sudo chown -R 33:33` на каталог с БД на хосте.\n\
• Попробуй переменную окружения SQLITE_JOURNAL_MODE=delete.\n",
            );
        }
        return Err(msg.into());
    }

    let http = reqwest::Client::builder()
        .user_agent(browser_http::default_user_agent_string())
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let db_write = Arc::new(Semaphore::new(1));
    let (poll_tx, _) = tokio::sync::broadcast::channel::<routes::PollEvent>(64);
    let poll_semaphore = Arc::new(Semaphore::new(5));

    let api_key = std::env::var("API_KEY")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| Arc::from(s.as_str()));
    if api_key.is_none() {
        tracing::warn!("API_KEY is not set — all endpoints are unauthenticated");
    }

    let state = routes::AppState {
        pool: pool.clone(),
        http: http.clone(),
        db_write: db_write.clone(),
        poll_events: Arc::new(poll_tx),
        poll_semaphore: poll_semaphore.clone(),
        api_key,
    };

    let app = routes::router(state);

    let bind = match std::env::var("BIND_ADDR") {
        Ok(addr) if !addr.trim().is_empty() => addr,
        _ => "127.0.0.1:8080".to_string(),
    };
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "listening: GET /feed.xml, JSON under /api/*");

    tokio::spawn(scheduler::run(pool, http, db_write, poll_semaphore));

    axum::serve(listener, app).await?;

    Ok(())
}
