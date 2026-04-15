use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::{QueryBuilder, Sqlite, SqlitePool};
use tokio::sync::Semaphore;

use crate::error::AppError;

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct Feed {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
    pub poll_interval_seconds: i32,
    /// Telegram preview only: max posts to parse per poll (1–500). Ignored for RSS URLs.
    pub telegram_max_items: i32,
    /// RSS: when plain-text body from the feed is very short, fetch HTML from `item.link`.
    pub expand_article_from_link: bool,
    pub created_at: DateTime<Utc>,
    pub last_polled_at: Option<DateTime<Utc>>,
}

/// Article: current text is the latest `article_contents` row by `id` for this `articles.id`
/// (`article_contents.article_id`).
/// `content_version_count` — number of stored versions in `article_contents`.
/// `previous_body` — second-to-last version (for RSS “was / now” summary).
/// `link` — original URL when `guid` itself is an http(s) URL.
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct Article {
    pub id: i64,
    pub feed_id: i64,
    pub guid: String,
    pub title: String,
    pub body: String,
    pub published_at: Option<DateTime<Utc>>,
    pub first_seen_at: DateTime<Utc>,
    pub last_fetched_at: DateTime<Utc>,
    /// When the currently shown body snapshot was stored (new/changed version).
    pub latest_content_fetched_at: DateTime<Utc>,
    pub content_version_count: i64,
    pub previous_body: Option<String>,
    pub link: Option<String>,
}

/// One stored text version (order by increasing `id`).
/// Current Telegram reaction counts for one article (snapshot).
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct ArticleReactionSnapshot {
    pub emoji: String,
    pub count_display: String,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct ArticleReactionHistoryEntry {
    pub id: i64,
    pub emoji: String,
    pub count_display: String,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct ArticleContentVersion {
    pub id: i64,
    pub title: String,
    pub body: String,
    /// Stored `fetched_at`, or `articles.last_fetched_at` when the row had no timestamp yet.
    pub fetched_at: DateTime<Utc>,
}

const ARTICLE_SELECT: &str = r#"
SELECT a.id, a.feed_id, a.guid,
  cur.title AS title, cur.body AS body,
  a.published_at, a.first_seen_at, a.last_fetched_at,
  COALESCE(
    (SELECT c.fetched_at FROM article_contents c
     WHERE c.article_id = a.id
     ORDER BY c.id DESC LIMIT 1),
    a.last_fetched_at
  ) AS latest_content_fetched_at,
  (SELECT COUNT(*) FROM article_contents x WHERE x.article_id = a.id) AS content_version_count,
  (SELECT body FROM article_contents x
   WHERE x.article_id = a.id
   ORDER BY x.id DESC LIMIT 1 OFFSET 1) AS previous_body,
  CASE WHEN a.guid LIKE 'http://%' OR a.guid LIKE 'https://%' THEN a.guid ELSE NULL END AS link
"#;

const ARTICLE_JOIN: &str = r#"
FROM articles a
INNER JOIN article_contents cur ON cur.id = (
  SELECT MAX(id) FROM article_contents c2 WHERE c2.article_id = a.id
)
"#;

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

/// All feeds as id/url/title for filter dropdowns (small payload).
#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct FeedOption {
    pub id: i64,
    pub url: String,
    pub title: Option<String>,
}

pub async fn list_feed_options(pool: &SqlitePool) -> Result<Vec<FeedOption>, AppError> {
    let rows = sqlx::query_as::<_, FeedOption>(r#"SELECT id, url, title FROM feeds ORDER BY id"#)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Feeds whose stored title matches `title` (trimmed, case-insensitive). Empty titles are skipped.
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

/// Feeds that need polling: never polled, or interval elapsed.
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

pub struct UpsertArticle<'a> {
    pub feed_id: i64,
    pub guid: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub content_hash: &'a [u8],
    pub published_at: Option<DateTime<Utc>>,
    pub now: DateTime<Utc>,
}

async fn sync_article_telegram_reactions_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    article_id: i64,
    new_rx: &[(String, String)],
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let old: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT emoji, count_display FROM article_reactions WHERE article_id = ?"#,
    )
    .bind(article_id)
    .fetch_all(&mut **tx)
    .await?;
    let old_map: HashMap<String, String> = old.into_iter().collect();
    let new_map: HashMap<String, String> = new_rx.iter().cloned().collect();
    if old_map == new_map {
        return Ok(());
    }
    let t = now.to_rfc3339();
    for (emoji, new_c) in &new_map {
        if old_map.get(emoji) != Some(new_c) {
            sqlx::query(
                r#"INSERT INTO article_reaction_history (article_id, emoji, count_display, observed_at)
                   VALUES (?, ?, ?, ?)"#,
            )
            .bind(article_id)
            .bind(emoji)
            .bind(new_c)
            .bind(&t)
            .execute(&mut **tx)
            .await?;
        }
    }
    for emoji in old_map.keys() {
        if !new_map.contains_key(emoji) {
            sqlx::query(
                r#"INSERT INTO article_reaction_history (article_id, emoji, count_display, observed_at)
                   VALUES (?, ?, ?, ?)"#,
            )
            .bind(article_id)
            .bind(emoji)
            .bind("—")
            .bind(&t)
            .execute(&mut **tx)
            .await?;
        }
    }
    sqlx::query(r#"DELETE FROM article_reactions WHERE article_id = ?"#)
        .bind(article_id)
        .execute(&mut **tx)
        .await?;
    for (emoji, count) in new_rx {
        sqlx::query(
            r#"INSERT INTO article_reactions (article_id, emoji, count_display, updated_at)
               VALUES (?, ?, ?, ?)"#,
        )
        .bind(article_id)
        .bind(emoji)
        .bind(count)
        .bind(&t)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn insert_content_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    article_id: i64,
    row: &UpsertArticle<'_>,
) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO article_contents (article_id, content_hash, title, body, fetched_at)
           VALUES (?, ?, ?, ?, ?) RETURNING id"#,
    )
    .bind(article_id)
    .bind(row.content_hash)
    .bind(row.title)
    .bind(row.body)
    .bind(row.now)
    .fetch_one(&mut **tx)
    .await
}

pub async fn upsert_article(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    row: UpsertArticle<'_>,
    telegram_reactions: Option<&[(String, String)]>,
) -> Result<(), AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let mut tx = pool.begin().await?;

    let existing: Option<(i64, Vec<u8>)> = sqlx::query_as(
        r#"SELECT a.id, c.content_hash
           FROM articles a
           INNER JOIN article_contents c ON c.id = (
             SELECT MAX(id) FROM article_contents c2 WHERE c2.article_id = a.id
           )
           WHERE a.feed_id = ? AND a.guid = ?"#,
    )
    .bind(row.feed_id)
    .bind(row.guid)
    .fetch_optional(&mut *tx)
    .await?;

    let article_id = match existing {
        None => {
            let article_id: i64 = sqlx::query_scalar(
                r#"INSERT INTO articles (
                    feed_id, guid, published_at, first_seen_at, last_fetched_at
                ) VALUES (?, ?, ?, ?, ?)
                RETURNING id"#,
            )
            .bind(row.feed_id)
            .bind(row.guid)
            .bind(row.published_at)
            .bind(row.now)
            .bind(row.now)
            .fetch_one(&mut *tx)
            .await
            .map_err(AppError::from)?;
            insert_content_tx(&mut tx, article_id, &row)
                .await
                .map_err(AppError::from)?;
            article_id
        }
        Some((id, ref old_hash)) if old_hash.as_slice() == row.content_hash => {
            sqlx::query(
                r#"UPDATE articles SET
                    last_fetched_at = ?,
                    published_at = COALESCE(?, published_at)
                   WHERE id = ?"#,
            )
            .bind(row.now)
            .bind(row.published_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            id
        }
        Some((id, _)) => {
            insert_content_tx(&mut tx, id, &row)
                .await
                .map_err(AppError::from)?;
            sqlx::query(
                r#"UPDATE articles SET
                    last_fetched_at = ?,
                    published_at = COALESCE(?, published_at)
                   WHERE id = ?"#,
            )
            .bind(row.now)
            .bind(row.published_at)
            .bind(id)
            .execute(&mut *tx)
            .await?;
            id
        }
    };

    if let Some(rx) = telegram_reactions {
        sync_article_telegram_reactions_tx(&mut tx, article_id, rx, row.now)
            .await
            .map_err(AppError::from)?;
    }

    tx.commit().await?;
    Ok(())
}

/// Current reaction rows for many articles (for list API).
pub async fn list_article_reaction_snapshots_bulk(
    pool: &SqlitePool,
    article_ids: &[i64],
) -> Result<HashMap<i64, Vec<ArticleReactionSnapshot>>, AppError> {
    if article_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut qb = QueryBuilder::new(
        "SELECT article_id, emoji, count_display FROM article_reactions WHERE article_id IN (",
    );
    {
        let mut sep = qb.separated(", ");
        for id in article_ids {
            sep.push_bind(*id);
        }
    }
    qb.push(") ORDER BY article_id, emoji");
    let rows: Vec<(i64, String, String)> = qb.build_query_as().fetch_all(pool).await?;
    let mut out: HashMap<i64, Vec<ArticleReactionSnapshot>> = HashMap::new();
    for (article_id, emoji, count_display) in rows {
        out.entry(article_id).or_default().push(ArticleReactionSnapshot {
            emoji,
            count_display,
        });
    }
    Ok(out)
}

pub async fn list_article_reaction_snapshots(
    pool: &SqlitePool,
    article_id: i64,
) -> Result<Vec<ArticleReactionSnapshot>, AppError> {
    let rows = sqlx::query_as::<_, ArticleReactionSnapshot>(
        r#"SELECT emoji, count_display FROM article_reactions
           WHERE article_id = ? ORDER BY emoji"#,
    )
    .bind(article_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_article_reaction_history(
    pool: &SqlitePool,
    article_id: i64,
    limit: i64,
) -> Result<Vec<ArticleReactionHistoryEntry>, AppError> {
    let limit = limit.clamp(1, 500);
    let rows = sqlx::query_as::<_, ArticleReactionHistoryEntry>(
        r#"SELECT id, emoji, count_display, observed_at
           FROM article_reaction_history
           WHERE article_id = ?
           ORDER BY observed_at DESC, id DESC
           LIMIT ?"#,
    )
    .bind(article_id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

#[derive(Debug, Clone, Default)]
pub struct ArticleFilter {
    pub feed_ids: Vec<i64>,
    pub only_modified: bool,
    pub last_fetched_from: Option<DateTime<Utc>>,
    /// Exclusive upper bound (start of day after `date_to`).
    pub last_fetched_before: Option<DateTime<Utc>>,
}

fn push_article_where(b: &mut QueryBuilder<'_, Sqlite>, f: &ArticleFilter) {
    b.push(" WHERE 1=1");
    if !f.feed_ids.is_empty() {
        if f.feed_ids.len() == 1 {
            b.push(" AND a.feed_id = ");
            b.push_bind(f.feed_ids[0]);
        } else {
            b.push(" AND a.feed_id IN (");
            let mut sep = b.separated(", ");
            for &fid in &f.feed_ids {
                sep.push_bind(fid);
            }
            sep.push_unseparated(")");
        }
    }
    if f.only_modified {
        b.push(" AND (SELECT COUNT(*) FROM article_contents c WHERE c.article_id = a.id) > 1");
    }
    if let Some(dt) = f.last_fetched_from {
        b.push(" AND a.last_fetched_at >= ");
        b.push_bind(dt);
    }
    if let Some(dt) = f.last_fetched_before {
        b.push(" AND a.last_fetched_at < ");
        b.push_bind(dt);
    }
}

#[derive(Debug, Clone)]
pub struct ArticleListQuery {
    pub filter: ArticleFilter,
    pub limit: i64,
    pub offset: i64,
}

pub async fn list_articles(
    pool: &SqlitePool,
    q: ArticleListQuery,
) -> Result<Vec<Article>, AppError> {
    let limit = q.limit.clamp(1, 200);
    let offset = q.offset.max(0);
    let mut b = QueryBuilder::new("");
    b.push(ARTICLE_SELECT);
    b.push(ARTICLE_JOIN);
    push_article_where(&mut b, &q.filter);
    // Newest *news* first (publication date), not last poll time. Missing pub date → first_seen_at.
    b.push(" ORDER BY COALESCE(a.published_at, a.first_seen_at) DESC, a.id DESC LIMIT ");
    b.push_bind(limit);
    b.push(" OFFSET ");
    b.push_bind(offset);
    let rows = b.build_query_as::<Article>().fetch_all(pool).await?;
    Ok(rows)
}

pub async fn count_articles(pool: &SqlitePool, f: &ArticleFilter) -> Result<i64, AppError> {
    let mut b = QueryBuilder::new("SELECT COUNT(*) ");
    b.push(ARTICLE_JOIN);
    push_article_where(&mut b, f);
    let n = b.build_query_scalar::<i64>().fetch_one(pool).await?;
    Ok(n)
}

pub async fn get_article(pool: &SqlitePool, id: i64) -> Result<Option<Article>, AppError> {
    let sql = format!("{}{} WHERE a.id = ?", ARTICLE_SELECT, ARTICLE_JOIN);
    let row = sqlx::query_as::<_, Article>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArticleContentAppendResult {
    /// Same `content_hash` as the latest stored version; only `last_fetched_at` was bumped.
    Unchanged,
    /// New row in `article_contents`.
    Inserted,
}

/// Append a new content version when the hash differs from the latest snapshot (manual “pull from link”).
pub async fn append_article_content_version(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    article_id: i64,
    title: &str,
    body: &str,
    content_hash: &[u8],
    now: DateTime<Utc>,
) -> Result<ArticleContentAppendResult, AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let mut tx = pool.begin().await?;

    let exists: Option<i64> = sqlx::query_scalar(r#"SELECT id FROM articles WHERE id = ?"#)
        .bind(article_id)
        .fetch_optional(&mut *tx)
        .await?;
    if exists.is_none() {
        return Err(AppError::NotFound);
    }

    let latest: Option<Vec<u8>> = sqlx::query_scalar(
        r#"SELECT content_hash FROM article_contents
           WHERE article_id = ? ORDER BY id DESC LIMIT 1"#,
    )
    .bind(article_id)
    .fetch_optional(&mut *tx)
    .await?;

    let Some(latest) = latest else {
        return Err(AppError::BadRequest(
            "у статьи нет сохранённых версий текста".into(),
        ));
    };

    if latest.as_slice() == content_hash {
        sqlx::query(r#"UPDATE articles SET last_fetched_at = ? WHERE id = ?"#)
            .bind(now)
            .bind(article_id)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(ArticleContentAppendResult::Unchanged);
    }

    sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO article_contents (article_id, content_hash, title, body, fetched_at)
           VALUES (?, ?, ?, ?, ?) RETURNING id"#,
    )
    .bind(article_id)
    .bind(content_hash)
    .bind(title)
    .bind(body)
    .bind(now)
    .fetch_one(&mut *tx)
    .await?;

    sqlx::query(r#"UPDATE articles SET last_fetched_at = ? WHERE id = ?"#)
        .bind(now)
        .bind(article_id)
        .execute(&mut *tx)
        .await?;

    tx.commit().await?;
    Ok(ArticleContentAppendResult::Inserted)
}

pub async fn list_article_contents(
    pool: &SqlitePool,
    id: i64,
) -> Result<Vec<ArticleContentVersion>, AppError> {
    let rows = sqlx::query_as::<_, ArticleContentVersion>(
        r#"SELECT c.id, c.title, c.body,
                  COALESCE(c.fetched_at, a.last_fetched_at) AS fetched_at
           FROM article_contents c
           INNER JOIN articles a ON a.id = c.article_id
           WHERE c.article_id = ?
           ORDER BY c.id ASC"#,
    )
    .bind(id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Incoming HTTP request log (timestamp via DB `DEFAULT`).
pub async fn insert_request_log(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    method: &str,
    path: &str,
    status_code: i64,
    duration_ms: i64,
) -> Result<(), sqlx::Error> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    sqlx::query(
        r#"INSERT INTO request_log (method, path, status_code, duration_ms) VALUES (?, ?, ?, ?)"#,
    )
    .bind(method)
    .bind(path)
    .bind(status_code)
    .bind(duration_ms)
    .execute(pool)
    .await?;
    Ok(())
}
