mod db;
mod error;
mod ingest;
mod routes;
mod rss;
mod scheduler;

use std::str::FromStr;
use std::time::Duration;

use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    let log_filter = match tracing_subscriber::EnvFilter::try_from_default_env() {
        Ok(f) => f,
        Err(err) => {
            eprintln!("RUST_LOG is invalid ({err}); using default info,rss_repository=debug");
            tracing_subscriber::EnvFilter::new("info,rss_repository=debug")
        }
    };
    tracing_subscriber::registry()
        .with(log_filter)
        .with(tracing_subscriber::fmt::layer())
        .init();

    let database_url = std::env::var("DATABASE_URL").map_err(|_| "DATABASE_URL must be set")?;

    let connect_options = SqliteConnectOptions::from_str(&database_url)
        .map_err(|e| format!("invalid DATABASE_URL: {e}"))?
        .create_if_missing(true)
        .foreign_keys(true)
        // Параллель: HTTP + планировщик + несколько poll. WAL + busy_timeout снимают «database is locked».
        .busy_timeout(Duration::from_secs(15))
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Normal);

    let pool = SqlitePoolOptions::new()
        .max_connections(10)
        .connect_with(connect_options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    let http = reqwest::Client::builder()
        .user_agent(concat!("rss-repository/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(60))
        .build()?;

    let state = routes::AppState {
        pool: pool.clone(),
        http: http.clone(),
    };

    let app = routes::router(state);

    let bind = match std::env::var("BIND_ADDR") {
        Ok(addr) if !addr.trim().is_empty() => addr,
        _ => "0.0.0.0:8080".to_string(),
    };
    let listener = tokio::net::TcpListener::bind(&bind).await?;
    tracing::info!(%bind, "listening: GET /feed.xml, JSON under /api/*");

    tokio::spawn(scheduler::run(pool, http));

    axum::serve(listener, app).await?;

    Ok(())
}
