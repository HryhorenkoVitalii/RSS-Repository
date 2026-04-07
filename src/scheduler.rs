use std::sync::Arc;
use std::time::Duration;

use sqlx::SqlitePool;
use tokio::sync::Semaphore as PollSemaphore;

use crate::db;
use crate::ingest::poll_feed;

const TICK_SECS: u64 = 10;
const MAX_CONCURRENT_POLLS: usize = 5;

pub async fn run(
    pool: SqlitePool,
    client: reqwest::Client,
    db_write: Arc<tokio::sync::Semaphore>,
) {
    let sem = Arc::new(PollSemaphore::new(MAX_CONCURRENT_POLLS));
    loop {
        tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
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
        tracing::debug!(count = feeds.len(), "polling due feeds");
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
