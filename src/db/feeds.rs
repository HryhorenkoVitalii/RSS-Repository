use chrono::{DateTime, Utc};
use sqlx::MySqlPool;
use tokio::sync::Semaphore;

use crate::error::AppError;

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct Feed {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
    pub poll_interval_seconds: i32,
    pub telegram_max_items: i32,
    pub created_at: DateTime<Utc>,
    pub last_polled_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct FeedOption {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
}

pub async fn list_feeds(pool: &MySqlPool) -> Result<Vec<Feed>, AppError> {
    let rows = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, created_at, last_polled_at
           FROM feeds ORDER BY id"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn count_feeds(pool: &MySqlPool) -> Result<i64, AppError> {
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM feeds")
        .fetch_one(pool)
        .await?;
    Ok(n)
}

pub async fn list_feeds_page(
    pool: &MySqlPool,
    limit: i64,
    offset: i64,
) -> Result<Vec<Feed>, AppError> {
    let limit = limit.clamp(1, 200);
    let offset = offset.max(0);
    let rows = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, created_at, last_polled_at
           FROM feeds ORDER BY id LIMIT ? OFFSET ?"#,
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_feed_options(pool: &MySqlPool) -> Result<Vec<FeedOption>, AppError> {
    let rows = sqlx::query_as::<_, FeedOption>(r#"SELECT id, url, title FROM feeds ORDER BY id"#)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

pub async fn find_feeds_by_title_ci(pool: &MySqlPool, title: &str) -> Result<Vec<Feed>, AppError> {
    let needle = title.trim();
    if needle.is_empty() {
        return Ok(vec![]);
    }
    let rows = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, created_at, last_polled_at
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

/// Коллизии с `uk_feeds_url` при разном регистре (unicode_ci) и повторном добавлении того же фида.
pub async fn get_feed_id_by_url_ci(pool: &MySqlPool, url: &str) -> Result<Option<i64>, AppError> {
    let row = sqlx::query_scalar::<_, i64>(
        r#"SELECT id FROM feeds WHERE LOWER(url) = LOWER(?) LIMIT 1"#,
    )
    .bind(url)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn get_feed(pool: &MySqlPool, id: i64) -> Result<Option<Feed>, AppError> {
    let row = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, created_at, last_polled_at
           FROM feeds WHERE id = ?"#,
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn create_feed(
    write_lock: &Semaphore,
    pool: &MySqlPool,
    url: &str,
    poll_interval_seconds: i32,
    telegram_max_items: i32,
) -> Result<i64, AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let r = sqlx::query(
        r#"INSERT INTO feeds (url, poll_interval_seconds, telegram_max_items)
           VALUES (?, ?, ?)"#,
    )
    .bind(url)
    .bind(poll_interval_seconds)
    .bind(telegram_max_items)
    .execute(pool)
    .await?;
    Ok(r.last_insert_id() as i64)
}

pub async fn delete_feed(
    write_lock: &Semaphore,
    pool: &MySqlPool,
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
    pool: &MySqlPool,
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
    pool: &MySqlPool,
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

pub async fn update_feed_meta(
    write_lock: &Semaphore,
    pool: &MySqlPool,
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

pub async fn feeds_due_for_poll(pool: &MySqlPool) -> Result<Vec<Feed>, AppError> {
    let rows = sqlx::query_as::<_, Feed>(
        r#"SELECT id, url, title, poll_interval_seconds, telegram_max_items, created_at, last_polled_at
           FROM feeds
           WHERE last_polled_at IS NULL
              OR TIMESTAMPDIFF(SECOND, last_polled_at, UTC_TIMESTAMP()) >= poll_interval_seconds"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}
