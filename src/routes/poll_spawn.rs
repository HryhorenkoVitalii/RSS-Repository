//! Фоновый опрос одной ленты с уведомлением по `broadcast` (SSE).

use crate::db::Feed;
use crate::ingest::poll_feed;

use super::{AppState, PollEvent};

pub(crate) fn spawn_feed_poll_background(state: AppState, feed: Feed) {
    tokio::spawn(async move {
        let feed_id = feed.id;
        let _permit = match state.poll_semaphore.acquire().await {
            Ok(p) => p,
            Err(_) => return,
        };
        let event = match poll_feed(state.db_write.as_ref(), &state.pool, &state.http, &feed).await
        {
            Ok(()) => PollEvent {
                feed_id,
                ok: true,
                error: None,
            },
            Err(e) => {
                tracing::warn!(feed_id, error = %e, "poll failed");
                PollEvent {
                    feed_id,
                    ok: false,
                    error: Some("poll failed".to_string()),
                }
            }
        };
        let _ = state.poll_events.send(event);
    });
}
