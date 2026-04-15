use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

use crate::error::AppError;

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct Feed {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
    pub poll_interval_seconds: i32,
    pub telegram_max_items: i32,
    pub expand_article_from_link: bool,
    pub created_at: DateTime<Utc>,
    pub last_polled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct FeedOption {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
}

pub async fn list_feeds(pool: &SqlitePool) -> Result<Vec<Feed>, AppError> {
    let rows = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, expand_article_from_link, created_at, last_polled_at
           FROM feeds ORDER BY id"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn count_feeds(pool: &SqlitePool) -> Result<i64, AppError> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM feeds")
        .fetch_one(pool)
        .await?;
    Ok(n)
}

pub async fn list_feeds_page(
    pool: &SqlitePool,
    limit: i64,
    offset: i64,
) -> Result<Vec<Feed>, AppError> {
    let limit = limit.clamp(1, 200);
    let offset = offset.max(0);
    let rows = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, expand_article_from_link, created_at, last_polled_at
           FROM feeds ORDER BY id LIMIT ? OFFSET ?"#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_feed_options(pool: &SqlitePool) -> Result<Vec<FeedOption>, AppError> {
    let rows = sqlx::query_as::<_, FeedOption>(r#"SELECT id, url, title FROM feeds ORDER BY id"#)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn find_feeds_by_title_ci(pool: &SqlitePool, title: &str) -> Result<Vec<Feed>, AppError> {
    let needle = title.trim();
    if needle.is_empty() {
        return Ok(vec![]);
    }
    let rows = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, expand_article_from_link, created_at, last_polled_at
           FROM feeds
           WHERE title IS NOT NULL
             AND TRIM(title) != ''
             AND LOWER(TRIM(title)) = LOWER(?)"#,
    )
    .bind(needle)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn get_feed(pool: &SqlitePool, id: i64) -> Result<Option<Feed>, AppError> {
    let row = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, expand_article_from_link, created_at, last_polled_at
           FROM feeds WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn create_feed(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    url: &str,
    poll_interval_seconds: i32,
    telegram_max_items: i32,
    expand_article_from_link: bool,
) -> Result<i64, AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let id = sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO feeds (url, poll_interval_seconds, telegram_max_items, expand_article_from_link)
           VALUES (?, ?, ?, ?)
           RETURNING id"#,
    )
    .bind(url)
    .bind(poll_interval_seconds)
    .bind(telegram_max_items)
    .bind(expand_article_from_link)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn delete_feed(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    id: i64,
) -> Result<bool, AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let r = sqlx::query("DELETE FROM feeds WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn update_feed_interval(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    id: i64,
    poll_interval_seconds: i32,
) -> Result<bool, AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let r = sqlx::query(r#"UPDATE feeds SET poll_interval_seconds = ? WHERE id = ?"#)
        .bind(poll_interval_seconds)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn update_feed_telegram_max_items(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    id: i64,
    telegram_max_items: i32,
) -> Result<bool, AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let r = sqlx::query(r#"UPDATE feeds SET telegram_max_items = ? WHERE id = ?"#)
        .bind(telegram_max_items)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn update_feed_expand_article_from_link(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    id: i64,
    expand_article_from_link: bool,
) -> Result<bool, AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let r = sqlx::query(r#"UPDATE feeds SET expand_article_from_link = ? WHERE id = ?"#)
        .bind(expand_article_from_link)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

pub async fn update_feed_meta(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    id: i64,
    title: Option<&str>,
    last_polled_at: DateTime<Utc>,
) -> Result<(), AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    sqlx::query(r#"UPDATE feeds SET title = COALESCE(?, title), last_polled_at = ? WHERE id = ?"#)
        .bind(title)
        .bind(last_polled_at)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(())
}

pub async fn feeds_due_for_poll(pool: &SqlitePool) -> Result<Vec<Feed>, AppError> {
    let rows = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, expand_article_from_link, created_at, last_polled_at
           FROM feeds
           WHERE last_polled_at IS NULL
              OR (CAST(strftime('%s', 'now') AS INTEGER) - CAST(strftime('%s', last_polled_at) AS INTEGER))
                 >= poll_interval_seconds"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
