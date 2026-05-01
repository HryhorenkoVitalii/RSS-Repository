use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::{QueryBuilder, SqlitePool};
use tokio::sync::Semaphore;

use crate::error::AppError;

pub const DEFAULT_TAG_COLOR: &str = "#64748b";

#[derive(Debug, Clone, serde::Serialize, sqlx::FromRow)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub created_at: DateTime<Utc>,
}

fn normalize_tag_name(raw: &str) -> Result<&str, AppError> {
    let t = raw.trim();
    if t.is_empty() {
        return Err(AppError::BadRequest("tag name must not be empty".into()));
    }
    if t.len() > 64 {
        return Err(AppError::BadRequest("tag name too long (max 64)".into()));
    }
    Ok(t)
}

/// `#rgb` → `#rrggbb`, lowercase.
pub fn normalize_tag_color(raw: &str) -> Result<String, AppError> {
    let s = raw.trim();
    let hex = s
        .strip_prefix('#')
        .ok_or_else(|| AppError::BadRequest("color: expected #rgb or #rrggbb".into()))?;
    match hex.len() {
        3 => {
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(AppError::BadRequest("color: invalid hex".into()));
            }
            let mut out = String::with_capacity(7);
            out.push('#');
            for ch in hex.chars() {
                let uc = ch.to_ascii_lowercase();
                out.push(uc);
                out.push(uc);
            }
            Ok(out)
        }
        6 => {
            if !hex.chars().all(|c| c.is_ascii_hexdigit()) {
                return Err(AppError::BadRequest("color: invalid hex".into()));
            }
            Ok(format!("#{}", hex.to_ascii_lowercase()))
        }
        _ => Err(AppError::BadRequest(
            "color: use #rgb or #rrggbb (e.g. #3b82f6)".into(),
        )),
    }
}

fn is_sqlite_unique_violation(e: &sqlx::Error) -> bool {
    e.as_database_error()
        .map(|d| d.message().to_uppercase().contains("UNIQUE"))
        .unwrap_or(false)
}

pub async fn list_tags(pool: &SqlitePool) -> Result<Vec<Tag>, AppError> {
    let rows = sqlx::query_as::<_, Tag>(
        r#"SELECT id, name, color, created_at FROM tags ORDER BY LOWER(name)"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn create_tag(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    name: &str,
    color: Option<&str>,
) -> Result<i64, AppError> {
    let name = normalize_tag_name(name)?;
    let color = match color {
        Some(c) => normalize_tag_color(c)?,
        None => DEFAULT_TAG_COLOR.to_string(),
    };
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let r = sqlx::query_scalar::<_, i64>(
        r#"INSERT INTO tags (name, color) VALUES (?, ?) RETURNING id"#,
    )
    .bind(name)
    .bind(&color)
    .fetch_one(pool)
    .await;
    match r {
        Ok(id) => Ok(id),
        Err(e) if is_sqlite_unique_violation(&e) => Err(AppError::BadRequest(
            "a tag with this name already exists".into(),
        )),
        Err(e) => Err(e.into()),
    }
}

pub async fn update_tag(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    id: i64,
    name: Option<&str>,
    color: Option<&str>,
) -> Result<bool, AppError> {
    if name.is_none() && color.is_none() {
        return Err(AppError::BadRequest(
            "provide at least one of: name, color".into(),
        ));
    }
    let name = match name {
        Some(n) => Some(normalize_tag_name(n)?.to_string()),
        None => None,
    };
    let color = match color {
        Some(c) => Some(normalize_tag_color(c)?),
        None => None,
    };

    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");

    let affected = match (&name, &color) {
        (Some(n), Some(c)) => {
            sqlx::query(r#"UPDATE tags SET name = ?, color = ? WHERE id = ?"#)
                .bind(n)
                .bind(c)
                .bind(id)
                .execute(pool)
                .await?
                .rows_affected()
        }
        (Some(n), None) => {
            sqlx::query(r#"UPDATE tags SET name = ? WHERE id = ?"#)
                .bind(n)
                .bind(id)
                .execute(pool)
                .await?
                .rows_affected()
        }
        (None, Some(c)) => {
            sqlx::query(r#"UPDATE tags SET color = ? WHERE id = ?"#)
                .bind(c)
                .bind(id)
                .execute(pool)
                .await?
                .rows_affected()
        }
        (None, None) => unreachable!("validated above"),
    };

    if affected == 0 {
        return Err(AppError::NotFound);
    }
    Ok(true)
}

pub async fn delete_tag(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    id: i64,
) -> Result<bool, AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let r = sqlx::query(r#"DELETE FROM tags WHERE id = ?"#)
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}

/// Replace all tags for a feed (empty clears).
pub async fn set_feed_tags(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    feed_id: i64,
    tag_ids: &[i64],
) -> Result<(), AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    let mut tx = pool.begin().await?;

    let feed_ok: bool = sqlx::query_scalar(r#"SELECT EXISTS(SELECT 1 FROM feeds WHERE id = ?)"#)
        .bind(feed_id)
        .fetch_one(&mut *tx)
        .await?;
    if !feed_ok {
        return Err(AppError::NotFound);
    }

    for tid in tag_ids {
        let exists: bool = sqlx::query_scalar(r#"SELECT EXISTS(SELECT 1 FROM tags WHERE id = ?)"#)
            .bind(tid)
            .fetch_one(&mut *tx)
            .await?;
        if !exists {
            return Err(AppError::BadRequest(format!("unknown tag id {tid}")));
        }
    }

    sqlx::query(r#"DELETE FROM feed_tags WHERE feed_id = ?"#)
        .bind(feed_id)
        .execute(&mut *tx)
        .await?;

    for tid in tag_ids {
        sqlx::query(r#"INSERT INTO feed_tags (feed_id, tag_id) VALUES (?, ?)"#)
            .bind(feed_id)
            .bind(tid)
            .execute(&mut *tx)
            .await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn tags_by_feed_ids(
    pool: &SqlitePool,
    feed_ids: &[i64],
) -> Result<HashMap<i64, Vec<Tag>>, AppError> {
    if feed_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let mut qb = QueryBuilder::new(
        r#"SELECT ft.feed_id, t.id, t.name, t.color, t.created_at
           FROM feed_tags ft
           INNER JOIN tags t ON t.id = ft.tag_id
           WHERE ft.feed_id IN ("#,
    );
    {
        let mut sep = qb.separated(", ");
        for id in feed_ids {
            sep.push_bind(*id);
        }
    }
    qb.push(") ORDER BY ft.feed_id, LOWER(t.name)");
    #[derive(sqlx::FromRow)]
    struct FeedTagRow {
        feed_id: i64,
        id: i64,
        name: String,
        color: String,
        created_at: DateTime<Utc>,
    }
    let rows: Vec<FeedTagRow> = qb.build_query_as::<FeedTagRow>().fetch_all(pool).await?;

    let mut out: HashMap<i64, Vec<Tag>> = HashMap::new();
    for r in rows {
        out.entry(r.feed_id).or_default().push(Tag {
            id: r.id,
            name: r.name,
            color: r.color,
            created_at: r.created_at,
        });
    }
    Ok(out)
}
