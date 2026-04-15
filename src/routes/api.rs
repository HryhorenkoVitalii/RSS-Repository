use std::convert::Infallible;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::Html;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use chrono::{DateTime, NaiveDate, Utc};
use futures_util::stream::Stream;
use serde::{Deserialize, Serialize};
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::article_expand;
use crate::db::{
    self, Article, ArticleContentAppendResult, ArticleContentVersion, ArticleFilter, ArticleListQuery,
    ArticleReactionHistoryEntry, ArticleReactionSnapshot, Feed, FeedOption,
};
use crate::error::AppError;
use crate::ingest::{self, poll_feed};
use crate::media;
use crate::telegram::{is_telegram_preview_url, normalize_new_feed_url};

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
        .route(
            "/feeds/{id}/telegram-max-items",
            post(update_feed_telegram_max_items),
        )
        .route(
            "/feeds/{id}/expand-from-link",
            post(update_feed_expand_from_link),
        )
        .route("/feeds/{id}/poll", post(poll_feed_now))
        .route("/articles", get(list_articles))
        .route(
            "/articles/{article_id}/contents/{content_id}/raw-html",
            get(get_article_content_raw_html),
        )
        .route("/articles/{id}", get(get_article_detail))
        .route(
            "/articles/{id}/expand-from-link",
            post(expand_article_from_link_now),
        )
        .route(
            "/articles/{id}/archive-full-page",
            post(archive_article_full_page_now),
        )
        .route(
            "/articles/{id}/telegram-reactions",
            get(get_article_telegram_reactions),
        )
        .route("/media/{hash}", get(serve_media))
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
    /// Telegram feeds only (1–500). Ignored for RSS.
    #[serde(default)]
    telegram_max_items: Option<i32>,
    /// RSS only: fetch full HTML from item link when the feed body is a stub. Ignored for Telegram.
    #[serde(default)]
    expand_article_from_link: Option<bool>,
}

fn default_poll_interval() -> i32 {
    600
}

fn clamp_telegram_max_items(n: i32) -> i32 {
    n.clamp(1, crate::telegram::TELEGRAM_FETCH_MAX_CAP as i32)
}

#[derive(Serialize)]
struct CreateFeedResponse {
    id: i64,
}

async fn create_feed(
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
    let expand_from_link = if is_telegram_preview_url(&url) {
        false
    } else {
        body.expand_article_from_link.unwrap_or(false)
    };
    let id = db::create_feed(
        state.db_write.as_ref(),
        &state.pool,
        &url,
        interval,
        tg_max,
        expand_from_link,
    )
    .await?;
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

#[derive(Deserialize)]
struct TelegramMaxItemsBody {
    telegram_max_items: i32,
}

async fn update_feed_telegram_max_items(
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

#[derive(Deserialize)]
struct ExpandFromLinkBody {
    expand_article_from_link: bool,
}

async fn update_feed_expand_from_link(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    Json(body): Json<ExpandFromLinkBody>,
) -> Result<StatusCode, AppError> {
    if db::get_feed(&state.pool, id).await?.is_none() {
        return Err(AppError::NotFound);
    }
    db::update_feed_expand_article_from_link(
        state.db_write.as_ref(),
        &state.pool,
        id,
        body.expand_article_from_link,
    )
    .await?;
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
struct ArticlePublic {
    #[serde(flatten)]
    article: Article,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    telegram_reactions: Vec<ArticleReactionSnapshot>,
}

#[derive(Serialize)]
struct ArticlesResponse {
    articles: Vec<ArticlePublic>,
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
    let ids: Vec<i64> = articles.iter().map(|a| a.id).collect();
    let rx_map = db::list_article_reaction_snapshots_bulk(&state.pool, &ids).await?;
    let articles = articles
        .into_iter()
        .map(|article| ArticlePublic {
            telegram_reactions: rx_map.get(&article.id).cloned().unwrap_or_default(),
            article,
        })
        .collect();
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    telegram_reactions: Vec<ArticleReactionSnapshot>,
}

async fn get_article_detail(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ArticleDetailResponse>, AppError> {
    let article = db::get_article(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let versions = db::list_article_contents(&state.pool, id).await?;
    let telegram_reactions = db::list_article_reaction_snapshots(&state.pool, id).await?;
    Ok(Json(ArticleDetailResponse {
        article,
        versions,
        telegram_reactions,
    }))
}

fn absolute_article_source_url(article: &Article) -> Result<String, AppError> {
    if let Some(u) = article.link.as_deref().map(str::trim) {
        if u.starts_with("http://") || u.starts_with("https://") {
            return Ok(u.to_string());
        }
    }
    let g = article.guid.trim();
    if g.starts_with("http://") || g.starts_with("https://") {
        return Ok(g.to_string());
    }
    Err(AppError::BadRequest(
        "нет абсолютной ссылки (http/https): откройте ленту с полным URL в элементе или guid"
            .into(),
    ))
}

#[derive(Serialize)]
struct ExpandArticleFromLinkResponse {
    unchanged: bool,
    article: Article,
    versions: Vec<ArticleContentVersion>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    telegram_reactions: Vec<ArticleReactionSnapshot>,
}

async fn expand_article_from_link_now(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ExpandArticleFromLinkResponse>, AppError> {
    let article = db::get_article(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let url = absolute_article_source_url(&article)?;

    let raw_html = article_expand::fetch_article_body_from_url(&state.http, &url)
        .await
        .map_err(|e| AppError::BadGateway(e.to_string()))?;

    let (body, hash) = ingest::finalize_expanded_html_for_storage(
        &state.db_write,
        &state.pool,
        &state.http,
        &raw_html,
    )
    .await
    .map_err(AppError::BadGateway)?;

    let now = Utc::now();
    let title = article.title.clone();
    let outcome = db::append_article_content_version(
        &state.db_write,
        &state.pool,
        id,
        &title,
        &body,
        &hash,
        now,
    )
    .await?;

    let article = db::get_article(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let versions = db::list_article_contents(&state.pool, id).await?;
    let telegram_reactions = db::list_article_reaction_snapshots(&state.pool, id).await?;
    Ok(Json(ExpandArticleFromLinkResponse {
        unchanged: outcome == ArticleContentAppendResult::Unchanged,
        article,
        versions,
        telegram_reactions,
    }))
}

async fn archive_article_full_page_now(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ExpandArticleFromLinkResponse>, AppError> {
    let article = db::get_article(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let url = absolute_article_source_url(&article)?;

    let raw = article_expand::fetch_full_page_html(&state.http, &url)
        .await
        .map_err(|e| AppError::BadGateway(e.to_string()))?;
    let with_base = article_expand::inject_base_href_for_archive(&raw, &url);
    let body = format!("{}{}", article_expand::FULL_PAGE_HTML_MARKER, with_base);
    let hash = article_expand::full_page_archive_content_hash(&body);

    let now = Utc::now();
    let title = article.title.clone();
    let outcome = db::append_article_content_version(
        &state.db_write,
        &state.pool,
        id,
        &title,
        &body,
        &hash,
        now,
    )
    .await?;

    let article = db::get_article(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let versions = db::list_article_contents(&state.pool, id).await?;
    let telegram_reactions = db::list_article_reaction_snapshots(&state.pool, id).await?;
    Ok(Json(ExpandArticleFromLinkResponse {
        unchanged: outcome == ArticleContentAppendResult::Unchanged,
        article,
        versions,
        telegram_reactions,
    }))
}

async fn get_article_content_raw_html(
    State(state): State<AppState>,
    Path((article_id, content_id)): Path<(i64, i64)>,
) -> Result<Html<String>, AppError> {
    let row: Option<String> = sqlx::query_scalar(
        r#"SELECT body FROM article_contents WHERE article_id = ? AND id = ?"#,
    )
    .bind(article_id)
    .bind(content_id)
    .fetch_optional(&state.pool)
    .await?;
    let Some(body) = row else {
        return Err(AppError::NotFound);
    };
    let marker = article_expand::FULL_PAGE_HTML_MARKER;
    if !body.starts_with(marker) {
        return Err(AppError::BadRequest(
            "эта версия не полноэкранный HTML-архив".into(),
        ));
    }
    Ok(Html(body[marker.len()..].to_string()))
}

#[derive(Serialize)]
struct TelegramReactionsDetailResponse {
    current: Vec<ArticleReactionSnapshot>,
    history: Vec<ArticleReactionHistoryEntry>,
}

async fn get_article_telegram_reactions(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<TelegramReactionsDetailResponse>, AppError> {
    if db::get_article(&state.pool, id).await?.is_none() {
        return Err(AppError::NotFound);
    }
    let current = db::list_article_reaction_snapshots(&state.pool, id).await?;
    let history = db::list_article_reaction_history(&state.pool, id, 250).await?;
    Ok(Json(TelegramReactionsDetailResponse { current, history }))
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

async fn serve_media(
    State(state): State<AppState>,
    Path(hash): Path<String>,
) -> Result<axum::response::Response, AppError> {
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("invalid hash".into()));
    }

    let row = media::get_media_by_hash(&state.pool, &hash)
        .await?
        .ok_or(AppError::NotFound)?;

    let dir = media::media_dir();
    let file_path = media::find_media_file(&dir, &hash).ok_or(AppError::NotFound)?;

    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|_| AppError::NotFound)?;

    let cache_forever = "public, max-age=31536000, immutable";
    Ok(axum::response::Response::builder()
        .status(200)
        .header("Content-Type", row.mime_type.as_str())
        .header("Cache-Control", cache_forever)
        .body(axum::body::Body::from(bytes))
        .unwrap())
}
