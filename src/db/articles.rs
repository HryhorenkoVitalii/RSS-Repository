use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::{QueryBuilder, MySql, MySqlPool};
use tokio::sync::Semaphore;

use crate::error::AppError;

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
    pub latest_content_fetched_at: DateTime<Utc>,
    pub content_version_count: i64,
    pub previous_body: Option<String>,
    pub link: Option<String>,
}

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
    pub fetched_at: DateTime<Utc>,
}

const ARTICLE_SELECT: &str = r#"
SELECT CAST(a.id AS SIGNED) AS id, CAST(a.feed_id AS SIGNED) AS feed_id, a.guid,
  cur.title AS title, cur.body AS body,
  a.published_at, a.first_seen_at, a.last_fetched_at,
  COALESCE(
    (SELECT c.fetched_at FROM article_contents c
     WHERE c.article_id = a.id
     ORDER BY c.id DESC LIMIT 1),
    a.last_fetched_at
  ) AS latest_content_fetched_at,
  CAST((SELECT COUNT(*) FROM article_contents x WHERE x.article_id = a.id) AS SIGNED) AS content_version_count,
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
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    article_id: i64,
    new_rx: &[(String, String)],
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    // Парсер может выдать одну и ту же реакцию дважды → PK (article_id, emoji).
    let mut new_map: HashMap<String, String> = HashMap::new();
    for (emoji, count) in new_rx.iter().cloned() {
        new_map.insert(emoji, count);
    }
    let old: Vec<(String, String)> = sqlx::query_as(
        r#"SELECT emoji, count_display FROM article_reactions WHERE article_id = ?"#,
    )
    .bind(article_id)
    .fetch_all(&mut **tx)
    .await?;
    let old_map: HashMap<String, String> = old.into_iter().collect();
    if old_map == new_map {
        return Ok(());
    }
    for (emoji, new_c) in &new_map {
        if old_map.get(emoji) != Some(new_c) {
            sqlx::query(
                r#"INSERT INTO article_reaction_history (article_id, emoji, count_display, observed_at)
                   VALUES (?, ?, ?, ?)"#,
            )
            .bind(article_id)
            .bind(emoji)
            .bind(new_c)
            .bind(now)
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
            .bind(now)
            .execute(&mut **tx)
            .await?;
        }
    }
    sqlx::query(r#"DELETE FROM article_reactions WHERE article_id = ?"#)
        .bind(article_id)
        .execute(&mut **tx)
        .await?;
    for (emoji, count) in &new_map {
        sqlx::query(
            r#"INSERT INTO article_reactions (article_id, emoji, count_display, updated_at)
               VALUES (?, ?, ?, ?)"#,
        )
        .bind(article_id)
        .bind(emoji)
        .bind(count)
        .bind(now)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn insert_content_tx(
    tx: &mut sqlx::Transaction<'_, sqlx::MySql>,
    article_id: i64,
    row: &UpsertArticle<'_>,
) -> Result<i64, sqlx::Error> {
    sqlx::query(
        r#"INSERT INTO article_contents (article_id, content_hash, title, body, fetched_at)
           VALUES (?, ?, ?, ?, ?)"#,
    )
    .bind(article_id)
    .bind(row.content_hash)
    .bind(row.title)
    .bind(row.body)
    .bind(row.now)
    .execute(&mut **tx)
    .await?;
    let id: u64 = sqlx::query_scalar("SELECT LAST_INSERT_ID()")
        .fetch_one(&mut **tx)
        .await?;
    Ok(id as i64)
}

pub async fn upsert_article(
    write_lock: &Semaphore,
    pool: &MySqlPool,
    row: UpsertArticle<'_>,
    telegram_reactions: Option<&[(String, String)]>,
) -> Result<(), AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let mut tx = pool.begin().await?;

    let existing: Option<(i64, Vec<u8>)> = sqlx::query_as(
        r#"SELECT CAST(a.id AS SIGNED), c.content_hash
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
            sqlx::query(
                r#"INSERT INTO articles (
                    feed_id, guid, published_at, first_seen_at, last_fetched_at
                ) VALUES (?, ?, ?, ?, ?)"#,
            )
            .bind(row.feed_id)
            .bind(row.guid)
            .bind(row.published_at)
            .bind(row.now)
            .bind(row.now)
            .execute(&mut *tx)
            .await
            .map_err(AppError::from)?;
            let last_id: u64 = sqlx::query_scalar("SELECT LAST_INSERT_ID()")
                .fetch_one(&mut *tx)
                .await
                .map_err(AppError::from)?;
            let article_id = last_id as i64;
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

pub async fn list_article_reaction_snapshots_bulk(
    pool: &MySqlPool,
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
    pool: &MySqlPool,
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
    pool: &MySqlPool,
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
    /// Feeds that have any of these tags (OR). Empty = no tag filter.
    pub tag_ids: Vec<i64>,
    pub only_modified: bool,
    pub last_fetched_from: Option<DateTime<Utc>>,
    pub last_fetched_before: Option<DateTime<Utc>>,
}

fn push_article_where(b: &mut QueryBuilder<'_, MySql>, f: &ArticleFilter) {
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
    if !f.tag_ids.is_empty() {
        b.push(" AND a.feed_id IN (SELECT DISTINCT feed_id FROM feed_tags WHERE tag_id IN (");
        let mut sep = b.separated(", ");
        for &tid in &f.tag_ids {
            sep.push_bind(tid);
        }
        sep.push_unseparated("))");
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
    pool: &MySqlPool,
    q: ArticleListQuery,
) -> Result<Vec<Article>, AppError> {
    let limit = q.limit.clamp(1, 200);
    let offset = q.offset.max(0);
    let mut b = QueryBuilder::new("");
    b.push(ARTICLE_SELECT);
    b.push(ARTICLE_JOIN);
    push_article_where(&mut b, &q.filter);
    b.push(" ORDER BY COALESCE(a.published_at, a.first_seen_at) DESC, a.id DESC LIMIT ");
    b.push_bind(limit);
    b.push(" OFFSET ");
    b.push_bind(offset);
    let rows = b.build_query_as::<Article>().fetch_all(pool).await?;
    Ok(rows)
}

pub async fn count_articles(pool: &MySqlPool, f: &ArticleFilter) -> Result<i64, AppError> {
    let mut b = QueryBuilder::new("SELECT COUNT(*) ");
    b.push(ARTICLE_JOIN);
    push_article_where(&mut b, f);
    // MySQL `COUNT(*)` is a signed BIGINT, not UNSIGNED — decode as i64.
    let n: i64 = b.build_query_scalar::<i64>().fetch_one(pool).await?;
    Ok(n)
}

pub async fn get_article(pool: &MySqlPool, id: i64) -> Result<Option<Article>, AppError> {
    let sql = format!("{}{} WHERE a.id = ?", ARTICLE_SELECT, ARTICLE_JOIN);
    let row = sqlx::query_as::<_, Article>(&sql)
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArticleContentAppendResult {
    Unchanged,
    Inserted,
}

pub async fn append_article_content_version(
    write_lock: &Semaphore,
    pool: &MySqlPool,
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

    // Column `articles.id` is signed BIGINT in schema.
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

    sqlx::query(
        r#"INSERT INTO article_contents (article_id, content_hash, title, body, fetched_at)
           VALUES (?, ?, ?, ?, ?)"#,
    )
    .bind(article_id)
    .bind(content_hash)
    .bind(title)
    .bind(body)
    .bind(now)
    .execute(&mut *tx)
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
    pool: &MySqlPool,
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
