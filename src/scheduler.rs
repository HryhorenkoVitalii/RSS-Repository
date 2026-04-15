use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::SqlitePool;
use tokio::sync::Semaphore;

use crate::db;
use crate::ingest::poll_feed;

fn tick_base_secs() -> u64 {
    std::env::var("SCHEDULER_TICK_SECS")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(10)
        .clamp(5, 3600)
}

fn max_feeds_per_tick() -> usize {
    std::env::var("SCHEDULER_MAX_FEEDS_PER_TICK")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(25)
        .clamp(1, 500)
}

/// Пауза до следующего тика: базовый интервал + псевдослучайный jitter до 25% (меньше «стада» при старте).
fn sleep_until_next_tick() -> Duration {
    let base = tick_base_secs().saturating_mul(1000);
    let jitter_max = (base / 4).max(1);
    let r = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let jitter = r % jitter_max;
    Duration::from_millis(base.saturating_add(jitter))
}

pub async fn run(
    pool: SqlitePool,
    client: reqwest::Client,
    db_write: Arc<Semaphore>,
    sem: Arc<Semaphore>,
) {
    loop {
        tokio::time::sleep(sleep_until_next_tick()).await;
        let feeds = match db::feeds_due_for_poll(&pool).await {
            Ok(f) => f,
            Err(e) => {
                tracing::error!(error = %e, "feeds_due_for_poll");
                continue;
            }
        };
        if feeds.is_empty() {
            continue;
        }
        let cap = max_feeds_per_tick();
        let feeds: Vec<_> = feeds.into_iter().take(cap).collect();
        if feeds.len() == cap {
            tracing::debug!(count = feeds.len(), cap, "polling due feeds (capped)");
        } else {
            tracing::debug!(count = feeds.len(), "polling due feeds");
        }
        for feed in feeds {
            let permit = match sem.clone().acquire_owned().await {
                Ok(p) => p,
                Err(_) => continue,
            };
            let pool = pool.clone();
            let client = client.clone();
            let db_write = db_write.clone();
            tokio::spawn(async move {
                let _permit = permit;
                match poll_feed(db_write.as_ref(), &pool, &client, &feed).await {
                    Ok(()) => tracing::info!(feed_id = feed.id, "feed polled ok"),
                    Err(e) => {
                        tracing::warn!(feed_id = feed.id, error = %e, "feed poll failed");
                        let _ = db::update_feed_meta(
                            db_write.as_ref(),
                            &pool,
                            feed.id,
                            None,
                            chrono::Utc::now(),
                        )
                        .await;
                    }
                }
            });
        }
    }
}
