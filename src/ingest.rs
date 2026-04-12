use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

use crate::db::{self, Feed};
use crate::media;
use crate::rss::{article_guid, canonical_body, fetch_and_parse};

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
    let media_dir = media::media_dir();

    for item in channel.items() {
        let guid = article_guid(item).map_err(|e| e.to_string())?;
        let title = item.title().map(|t| t.to_string()).unwrap_or_default();
        let body = item_display_body(item);
        let canon = canonical_body(item).map_err(|e| e.to_string())?;
        let published_at = item.pub_date().and_then(parse_pub_date);

        let media_urls = media::extract_media_urls(&body);
        let mut replacements: Vec<(String, String)> = Vec::new();
        let mut media_hashes: Vec<String> = Vec::new();

        for url in &media_urls {
            match media::download_and_store(client, url, &media_dir).await {
                Ok(dl) => {
                    let local_url = format!("/api/media/{}", dl.sha256);
                    replacements.push((url.clone(), local_url));
                    media_hashes.push(dl.sha256.clone());

                    if let Err(e) = media::save_media_record(
                        write_lock,
                        pool,
                        &dl.sha256,
                        url,
                        &dl.mime_type,
                        dl.file_size as i64,
                    )
                    .await
                    {
                        tracing::warn!(url = %url, error = %e, "media db insert failed");
                    }
                }
                Err(e) => {
                    tracing::warn!(url = %url, error = %e, "media download failed, keeping original URL");
                }
            }
        }

        let body = media::rewrite_media_urls(&body, &replacements);
        let hash = media::combined_content_hash(&canon, &mut media_hashes);

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
