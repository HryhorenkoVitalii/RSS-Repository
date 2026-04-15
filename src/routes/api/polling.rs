use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::stream::Stream;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::db;
use crate::error::AppError;

use crate::routes::poll_spawn;
use crate::routes::AppState;

pub(super) async fn poll_events_sse(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.poll_events.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|msg| match msg {
        Ok(evt) => {
            let data = serde_json::to_string(&evt).unwrap_or_default();
            Some(Ok(Event::default().event("poll_result").data(data)))
        }
        Err(_) => None,
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("ping"),
    )
}

pub(super) async fn poll_feed_now(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let feed = db::get_feed(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    poll_spawn::spawn_feed_poll_background(state, feed);
    Ok(StatusCode::ACCEPTED)
}

pub(super) async fn poll_all_feeds(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    let feeds = db::list_feeds(&state.pool).await?;
    for feed in feeds {
        poll_spawn::spawn_feed_poll_background(state.clone(), feed);
    }
    Ok(StatusCode::ACCEPTED)
}
