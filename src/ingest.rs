use std::collections::HashMap;

use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

use crate::article_expand;
use crate::db::{self, Feed};
use crate::media;
use crate::rss::{article_guid, fetch_and_parse, plain_fingerprint};
use crate::telegram;

type TelegramReactionsMap = HashMap<String, Vec<(String, String)>>;

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
    let (channel, tg_reactions): (rss::Channel, Option<TelegramReactionsMap>) =
        if telegram::is_telegram_preview_url(&feed.url) {
            let max_items = feed
                .telegram_max_items
                .clamp(1, telegram::TELEGRAM_FETCH_MAX_CAP as i32) as usize;
            let fetched = telegram::fetch_telegram_feed(client, &feed.url, max_items)
                .await
                .map_err(|e| e.to_string())?;
            (fetched.channel, Some(fetched.reactions_by_guid))
        } else {
            (
                fetch_and_parse(client, &feed.url)
                    .await
                    .map_err(|e| e.to_string())?,
                None,
            )
        };

    let raw_title = channel.title();
    let channel_title = if raw_title.trim().is_empty() {
        None
    } else {
        Some(raw_title.to_string())
    };
    let now = Utc::now();
    let media_dir = media::media_dir();

    let channel_base = channel.link().trim();
    let channel_base_opt = (!channel_base.is_empty()).then_some(channel_base);
    let rss_expand_from_link =
        feed.expand_article_from_link && tg_reactions.is_none();

    for item in channel.items() {
        let guid = article_guid(item).map_err(|e| e.to_string())?;
        let title = item.title().map(|t| t.to_string()).unwrap_or_default();
        let mut body = item_display_body(item);
        if rss_expand_from_link {
            if let Some(link_raw) = item.link() {
                if article_expand::rss_body_is_stub(&body).map_err(|e| e.to_string())? {
                    if let Some(u) =
                        article_expand::resolve_article_url(link_raw, channel_base_opt)
                    {
                        match article_expand::fetch_article_body_from_url(client, &u).await {
                            Ok(html) if !html.trim().is_empty() => {
                                body = html;
                            }
                            Err(e) => {
                                tracing::warn!(url = %u, error = %e, "expand article from link failed");
                            }
                            Ok(_) => {}
                        }
                    }
                }
            }
        }
        let canon = plain_fingerprint(&body).map_err(|e| e.to_string())?;
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

        let rx_slice: Option<&[(String, String)]> = match &tg_reactions {
            None => None,
            Some(m) => {
                let empty: &[(String, String)] = &[];
                Some(m.get(&guid).map(|v| v.as_slice()).unwrap_or(empty))
            }
        };

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
            rx_slice,
        )
        .await
        .map_err(|e| e.to_string())?;
    }

    db::update_feed_meta(write_lock, pool, feed.id, channel_title.as_deref(), now)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// Rewrite embedded media to local `/api/media/…` URLs and compute `content_hash` (same rules as RSS ingest).
pub async fn finalize_expanded_html_for_storage(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    client: &reqwest::Client,
    raw_html: &str,
) -> Result<(String, Vec<u8>), String> {
    let canon = plain_fingerprint(raw_html).map_err(|e| e.to_string())?;
    let media_urls = media::extract_media_urls(raw_html);
    let media_dir = media::media_dir();
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

    let body = media::rewrite_media_urls(raw_html, &replacements);
    let hash = media::combined_content_hash(&canon, &mut media_hashes);
    Ok((body, hash))
}
