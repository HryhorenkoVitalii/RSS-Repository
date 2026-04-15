use axum::extract::{Path, State};
use axum::response::Html;
use axum::Json;
use serde::Serialize;

use crate::article_expand;
use crate::db::{
    self, Article, ArticleContentVersion, ArticleReactionHistoryEntry, ArticleReactionSnapshot,
};
use crate::error::AppError;

use crate::routes::AppState;

#[derive(Serialize)]
pub(crate) struct ArticleDetailResponse {
    pub article: Article,
    pub versions: Vec<ArticleContentVersion>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub telegram_reactions: Vec<ArticleReactionSnapshot>,
}

pub(crate) async fn get_article_detail(
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

pub(crate) async fn get_article_content_raw_html(
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
pub(crate) struct TelegramReactionsDetailResponse {
    pub current: Vec<ArticleReactionSnapshot>,
    pub history: Vec<ArticleReactionHistoryEntry>,
}

pub(crate) async fn get_article_telegram_reactions(
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
