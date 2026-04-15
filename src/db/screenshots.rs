use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct ArticleScreenshotRow {
    pub id: i64,
    pub article_id: i64,
    pub media_sha256: String,
    pub page_url: String,
    pub captured_at: DateTime<Utc>,
}

pub async fn latest_screenshot_sha256(
    pool: &SqlitePool,
    article_id: i64,
) -> Result<Option<String>, sqlx::Error> {
    sqlx::query_scalar::<_, String>(
        "SELECT media_sha256 FROM article_screenshots WHERE article_id = ? ORDER BY id DESC LIMIT 1",
    )
    .bind(article_id)
    .fetch_optional(pool)
    .await
}

pub async fn get_latest_screenshot_row(
    pool: &SqlitePool,
    article_id: i64,
) -> Result<Option<ArticleScreenshotRow>, sqlx::Error> {
    sqlx::query_as::<_, ArticleScreenshotRow>(
        r#"SELECT id, article_id, media_sha256, page_url, captured_at
           FROM article_screenshots WHERE article_id = ? ORDER BY id DESC LIMIT 1"#,
    )
    .bind(article_id)
    .fetch_optional(pool)
    .await
}

pub async fn list_article_screenshots(
    pool: &SqlitePool,
    article_id: i64,
) -> Result<Vec<ArticleScreenshotRow>, sqlx::Error> {
    sqlx::query_as::<_, ArticleScreenshotRow>(
        r#"SELECT id, article_id, media_sha256, page_url, captured_at
           FROM article_screenshots WHERE article_id = ?
           ORDER BY captured_at DESC, id DESC"#,
    )
    .bind(article_id)
    .fetch_all(pool)
    .await
}

pub async fn insert_article_screenshot(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    article_id: i64,
    media_sha256: &str,
    page_url: &str,
    captured_at: DateTime<Utc>,
) -> Result<i64, sqlx::Error> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    sqlx::query(
        r#"INSERT INTO article_screenshots (article_id, media_sha256, page_url, captured_at)
           VALUES (?, ?, ?, ?)"#,
    )
    .bind(article_id)
    .bind(media_sha256)
    .bind(page_url)
    .bind(captured_at.to_rfc3339())
    .execute(pool)
    .await?;
    sqlx::query_scalar::<_, i64>("SELECT last_insert_rowid()")
        .fetch_one(pool)
        .await
}
