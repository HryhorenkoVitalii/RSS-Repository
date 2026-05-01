use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::db::{self, Feed, FeedOption, Tag};
use crate::error::AppError;
use crate::telegram::{is_telegram_preview_url, normalize_new_feed_url};

use crate::routes::AppState;

pub(super) const FEEDS_PAGE_SIZE: i64 = 20;

#[derive(Deserialize, Default)]
pub(super) struct FeedsListQuery {
    pub page: Option<i64>,
}

#[derive(Serialize)]
pub(super) struct FeedWithTags {
    #[serde(flatten)]
    pub feed: Feed,
    #[serde(default)]
    pub tags: Vec<Tag>,
}

#[derive(Serialize)]
pub(super) struct FeedsResponse {
    pub feeds: Vec<FeedWithTags>,
    pub total: i64,
    pub page: i64,
    pub limit: i64,
}

pub(super) async fn list_feeds(
    State(state): State<AppState>,
    Query(q): Query<FeedsListQuery>,
) -> Result<Json<FeedsResponse>, AppError> {
    let limit = FEEDS_PAGE_SIZE;
    let page = q.page.unwrap_or(0).max(0);
    let offset = page * limit;
    let total = db::count_feeds(&state.pool).await?;
    let page_rows = db::list_feeds_page(&state.pool, limit, offset).await?;
    let ids: Vec<i64> = page_rows.iter().map(|f| f.id).collect();
    let by_feed = db::tags_by_feed_ids(&state.pool, &ids).await?;
    let feeds = page_rows
        .into_iter()
        .map(|f| FeedWithTags {
            tags: by_feed.get(&f.id).cloned().unwrap_or_default(),
            feed: f,
        })
        .collect();
    Ok(Json(FeedsResponse {
        feeds,
        total,
        page,
        limit,
    }))
}

pub(super) async fn list_feed_options(
    State(state): State<AppState>,
) -> Result<Json<Vec<FeedOption>>, AppError> {
    let rows = db::list_feed_options(&state.pool).await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub(super) struct CreateFeedBody {
    pub url: String,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_seconds: i32,
    #[serde(default)]
    pub telegram_max_items: Option<i32>,
}

fn default_poll_interval() -> i32 {
    600
}

pub(super) fn clamp_telegram_max_items(n: i32) -> i32 {
    n.clamp(1, crate::telegram::TELEGRAM_FETCH_MAX_CAP as i32)
}

#[derive(Serialize)]
pub(super) struct CreateFeedResponse {
    pub id: i64,
}

pub(super) async fn create_feed(
    State(state): State<AppState>,
    Json(body): Json<CreateFeedBody>,
) -> Result<(StatusCode, Json<CreateFeedResponse>), AppError> {
    let url = normalize_new_feed_url(&body.url)
        .map_err(|e| AppError::BadRequest(format!("invalid feed url: {e}")))?;
    let interval = body.poll_interval_seconds.clamp(60, 86_400);
    let tg_max = if is_telegram_preview_url(&url) {
        clamp_telegram_max_items(body.telegram_max_items.unwrap_or(500))
    } else {
        500
    };
    let id = db::create_feed(
        state.db_write.as_ref(),
        &state.pool,
        &url,
        interval,
        tg_max,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(CreateFeedResponse { id })))
}

#[derive(Deserialize)]
pub(super) struct IntervalBody {
    pub poll_interval_seconds: i32,
}

pub(super) async fn update_feed_interval(
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

#[derive(Deserialize)]
pub(super) struct TelegramMaxItemsBody {
    pub telegram_max_items: i32,
}

pub(super) async fn update_feed_telegram_max_items(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<TelegramMaxItemsBody>,
) -> Result<StatusCode, AppError> {
    if db::get_feed(&state.pool, id).await?.is_none() {
        return Err(AppError::NotFound);
    }
    let n = clamp_telegram_max_items(body.telegram_max_items);
    db::update_feed_telegram_max_items(state.db_write.as_ref(), &state.pool, id, n).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn delete_feed(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    if !db::delete_feed(state.db_write.as_ref(), &state.pool, id).await? {
        return Err(AppError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub(super) struct PutFeedTagsBody {
    pub tag_ids: Vec<i64>,
}

pub(super) async fn put_feed_tags(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(mut body): Json<PutFeedTagsBody>,
) -> Result<StatusCode, AppError> {
    body.tag_ids.sort_unstable();
    body.tag_ids.dedup();
    if body.tag_ids.len() > 50 {
        return Err(AppError::BadRequest("too many tag_ids (max 50)".into()));
    }
    db::set_feed_tags(state.db_write.as_ref(), &state.pool, id, &body.tag_ids).await?;
    Ok(StatusCode::NO_CONTENT)
}
