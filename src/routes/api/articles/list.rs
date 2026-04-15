use axum::extract::{Query, State};
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

use crate::db::{
    self, Article, ArticleFilter, ArticleListQuery, ArticleReactionSnapshot,
};
use crate::error::AppError;

use crate::routes::AppState;

const MAX_FEED_IDS: usize = 50;

#[derive(Deserialize, Default)]
pub(crate) struct ArticlesQuery {
    pub feed_id: Option<String>,
    pub modified_only: Option<String>,
    pub page: Option<i64>,
    pub date_from: Option<String>,
    pub date_to: Option<String>,
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
pub(crate) struct ArticlePublic {
    #[serde(flatten)]
    pub article: Article,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub telegram_reactions: Vec<ArticleReactionSnapshot>,
}

#[derive(Serialize)]
pub(crate) struct ArticlesResponse {
    pub articles: Vec<ArticlePublic>,
    pub total: i64,
    pub page: i64,
    pub limit: i64,
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
        return Err(AppError::BadRequest(format!(
            "too many feed_id values (max {MAX_FEED_IDS})"
        )));
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

pub(crate) async fn list_articles(
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
