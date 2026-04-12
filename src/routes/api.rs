use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::db::{
    self, Article, ArticleContentVersion, ArticleFilter, ArticleListQuery, Feed, FeedOption,
};
use crate::error::AppError;
use crate::ingest::poll_feed;
use crate::rss::validate_feed_url;

use super::{AppState, PollEvent};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/feeds/events", get(poll_events_sse))
        .route("/feeds/poll-all", post(poll_all_feeds))
        .route("/feeds/options", get(list_feed_options))
        .route("/feeds", get(list_feeds).post(create_feed))
        .route("/feeds/{id}", delete(delete_feed))
        .route("/feeds/{id}/interval", post(update_feed_interval))
        .route("/feeds/{id}/poll", post(poll_feed_now))
        .route("/articles", get(list_articles))
        .route("/articles/{id}", get(get_article_detail))
}

#[derive(Serialize)]
struct HealthOk {
    ok: bool,
}

async fn health() -> Json<HealthOk> {
    Json(HealthOk { ok: true })
}

const FEEDS_PAGE_SIZE: i64 = 20;

#[derive(Deserialize, Default)]
struct FeedsListQuery {
    page: Option<i64>,
}

#[derive(Serialize)]
struct FeedsResponse {
    feeds: Vec<Feed>,
    total: i64,
    page: i64,
    limit: i64,
}

async fn list_feeds(
    State(state): State<AppState>,
    Query(q): Query<FeedsListQuery>,
) -> Result<Json<FeedsResponse>, AppError> {
    let limit = FEEDS_PAGE_SIZE;
    let page = q.page.unwrap_or(0).max(0);
    let offset = page * limit;
    let total = db::count_feeds(&state.pool).await?;
    let feeds = db::list_feeds_page(&state.pool, limit, offset).await?;
    Ok(Json(FeedsResponse {
        feeds,
        total,
        page,
        limit,
    }))
}

async fn list_feed_options(
    State(state): State<AppState>,
) -> Result<Json<Vec<FeedOption>>, AppError> {
    let rows = db::list_feed_options(&state.pool).await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct CreateFeedBody {
    url: String,
    #[serde(default = "default_poll_interval")]
    poll_interval_seconds: i32,
}

fn default_poll_interval() -> i32 {
    600
}

#[derive(Serialize)]
struct CreateFeedResponse {
    id: i64,
}

async fn create_feed(
    State(state): State<AppState>,
    Json(body): Json<CreateFeedBody>,
) -> Result<(StatusCode, Json<CreateFeedResponse>), AppError> {
    let url = body.url.trim().to_string();
    if url.is_empty() {
        return Err(AppError::BadRequest("url required".into()));
    }
    validate_feed_url(&url).map_err(|e| AppError::BadRequest(format!("invalid feed url: {e}")))?;
    let interval = body.poll_interval_seconds.clamp(60, 86_400);
    let id = db::create_feed(state.db_write.as_ref(), &state.pool, &url, interval).await?;
    Ok((StatusCode::CREATED, Json(CreateFeedResponse { id })))
}

#[derive(Deserialize)]
struct IntervalBody {
    poll_interval_seconds: i32,
}

async fn update_feed_interval(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<IntervalBody>,
) -> Result<StatusCode, AppError> {
    if db::get_feed(&state.pool, id).await?.is_none() {
        return Err(AppError::NotFound);
    }
    let interval = body.poll_interval_seconds.clamp(60, 86_400);
    db::update_feed_interval(state.db_write.as_ref(), &state.pool, id, interval).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_feed(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    if !db::delete_feed(state.db_write.as_ref(), &state.pool, id).await? {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize, Default)]
struct ArticlesQuery {
    feed_id: Option<String>,
    modified_only: Option<String>,
    page: Option<i64>,
    /// Inclusive start day (`YYYY-MM-DD`), UTC midnight. Filters `last_fetched_at`.
    date_from: Option<String>,
    /// Inclusive end day (`YYYY-MM-DD`), UTC end of day. Filters `last_fetched_at`.
    date_to: Option<String>,
}

fn parse_date_from_day(s: &str) -> Result<Option<DateTime<Utc>>, AppError> {
    let t = s.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let d = NaiveDate::parse_from_str(t, "%Y-%m-%d")
        .map_err(|_| AppError::BadRequest("date_from: expected YYYY-MM-DD".into()))?;
    let naive = d
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| AppError::BadRequest("date_from invalid".into()))?;
    Ok(Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc)))
}

fn parse_date_to_day_exclusive(s: &str) -> Result<Option<DateTime<Utc>>, AppError> {
    let t = s.trim();
    if t.is_empty() {
        return Ok(None);
    }
    let d = NaiveDate::parse_from_str(t, "%Y-%m-%d")
        .map_err(|_| AppError::BadRequest("date_to: expected YYYY-MM-DD".into()))?;
    let next = d
        .succ_opt()
        .ok_or_else(|| AppError::BadRequest("date_to out of range".into()))?;
    let naive = next
        .and_hms_opt(0, 0, 0)
        .ok_or_else(|| AppError::BadRequest("date_to invalid".into()))?;
    Ok(Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc)))
}

#[derive(Serialize)]
struct ArticlesResponse {
    articles: Vec<Article>,
    total: i64,
    page: i64,
    limit: i64,
}

fn parse_feed_ids(raw: &Option<String>) -> Vec<i64> {
    match raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.split(',').filter_map(|t| t.trim().parse::<i64>().ok()).collect(),
        None => Vec::new(),
    }
}

fn article_filter_from_query(q: &ArticlesQuery) -> Result<ArticleFilter, AppError> {
    let feed_ids = parse_feed_ids(&q.feed_id);
    if feed_ids.len() > MAX_FEED_IDS {
        return Err(AppError::BadRequest(format!("too many feed_id values (max {MAX_FEED_IDS})")));
    }
    let only_modified = matches!(q.modified_only.as_deref(), Some("true" | "on" | "1"));
    let last_fetched_from = match q.date_from.as_deref() {
        Some(s) => parse_date_from_day(s)?,
        None => None,
    };
    let last_fetched_before = match q.date_to.as_deref() {
        Some(s) => parse_date_to_day_exclusive(s)?,
        None => None,
    };
    if let (Some(f), Some(t)) = (last_fetched_from, last_fetched_before) {
        if f >= t {
            return Err(AppError::BadRequest(
                "date_from must be on or before date_to".into(),
            ));
        }
    }
    Ok(ArticleFilter {
        feed_ids,
        only_modified,
        last_fetched_from,
        last_fetched_before,
    })
}

async fn list_articles(
    State(state): State<AppState>,
    Query(q): Query<ArticlesQuery>,
) -> Result<Json<ArticlesResponse>, AppError> {
    let limit = 50;
    let page = q.page.unwrap_or(0).max(0);
    let offset = page * limit;
    let filter = article_filter_from_query(&q)?;
    let total = db::count_articles(&state.pool, &filter).await?;
    let articles = db::list_articles(
        &state.pool,
        ArticleListQuery {
            filter,
            limit,
            offset,
        },
    )
    .await?;
    Ok(Json(ArticlesResponse {
        articles,
        total,
        page,
        limit,
    }))
}

#[derive(Serialize)]
struct ArticleDetailResponse {
    article: Article,
    versions: Vec<ArticleContentVersion>,
}

async fn get_article_detail(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ArticleDetailResponse>, AppError> {
    let article = db::get_article(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let versions = db::list_article_contents(&state.pool, id).await?;
    Ok(Json(ArticleDetailResponse { article, versions }))
}

async fn poll_events_sse(
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

const MAX_FEED_IDS: usize = 50;

fn spawn_poll_and_notify(state: AppState, feed: Feed) {
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

async fn poll_feed_now(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let feed = db::get_feed(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    spawn_poll_and_notify(state, feed);
    Ok(StatusCode::ACCEPTED)
}

async fn poll_all_feeds(State(state): State<AppState>) -> Result<StatusCode, AppError> {
    let feeds = db::list_feeds(&state.pool).await?;
    for feed in feeds {
        spawn_poll_and_notify(state.clone(), feed);
    }
    Ok(StatusCode::ACCEPTED)
}
