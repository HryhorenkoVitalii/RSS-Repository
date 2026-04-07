use std::sync::Arc;

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

use crate::db::{self, Feed};
use crate::rss::{article_guid, canonical_body, content_hash, fetch_and_parse};

fn parse_pub_date(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc2822(s.trim())
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

fn item_display_body(item: &rss::Item) -> String {
    item.content()
        .or(item.description())
        .map(|s| s.to_string())
        .unwrap_or_default()
}

/// Fetch feed URL, upsert all items, update feed title and poll metadata.
pub async fn poll_feed(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    client: &reqwest::Client,
    feed: &Feed,
) -> Result<(), String> {
    let channel = fetch_and_parse(client, &feed.url)
        .await
        .map_err(|e| e.to_string())?;

    let raw_title = channel.title();
    let channel_title = if raw_title.trim().is_empty() {
        None
    } else {
        Some(raw_title.to_string())
    };
    let now = Utc::now();

    for item in channel.items() {
        let guid = article_guid(item).map_err(|e| e.to_string())?;
        let title = item.title().map(|t| t.to_string()).unwrap_or_default();
        let body = item_display_body(item);
        let canon = canonical_body(item).map_err(|e| e.to_string())?;
        let hash = content_hash(&canon);
        let published_at = item.pub_date().and_then(parse_pub_date);

        db::upsert_article(
            write_lock,
            pool,
            db::UpsertArticle {
                feed_id: feed.id,
                guid: &guid,
                title: &title,
                body: &body,
                content_hash: &hash,
                published_at,
                now,
            },
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    db::update_feed_meta(write_lock, pool, feed.id, channel_title.as_deref(), now)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Fire-and-forget poll; on failure updates `last_polled_at` so the scheduler can retry.
pub fn spawn_poll_feed(
    pool: SqlitePool,
    client: reqwest::Client,
    db_write: Arc<Semaphore>,
    feed: Feed,
) {
    tokio::spawn(async move {
        let fid = feed.id;
        match poll_feed(db_write.as_ref(), &pool, &client, &feed).await {
            Ok(()) => tracing::info!(feed_id = fid, "feed poll ok"),
            Err(e) => {
                tracing::warn!(feed_id = fid, error = %e, "feed poll failed");
                let _ = db::update_feed_meta(
                    db_write.as_ref(),
                    &pool,
                    fid,
                    None,
                    chrono::Utc::now(),
                )
                .await;
            }
        }
    });
}
