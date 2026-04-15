use axum::extract::{Path, State};
use axum::Json;
use chrono::Utc;
use serde::Serialize;

use crate::article_expand;
use crate::db::{
    self, Article, ArticleContentAppendResult, ArticleContentVersion, ArticleReactionSnapshot,
};
use crate::error::AppError;
use crate::ingest;
use crate::media;
use crate::page_screenshot;

use crate::routes::AppState;

#[derive(Serialize)]
pub(crate) struct ExpandArticleFromLinkResponse {
    pub unchanged: bool,
    pub article: Article,
    pub versions: Vec<ArticleContentVersion>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub telegram_reactions: Vec<ArticleReactionSnapshot>,
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

pub(crate) async fn expand_article_from_link_now(
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

pub(crate) async fn archive_article_full_page_now(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<ExpandArticleFromLinkResponse>, AppError> {
    let article = db::get_article(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let url = absolute_article_source_url(&article)?;

    let tmp = page_screenshot::temp_screenshot_path();
    let png = async {
        page_screenshot::capture_url_to_png(&url, &tmp)
            .await
            .map_err(AppError::BadGateway)?;
        tokio::fs::read(&tmp)
            .await
            .map_err(|e| AppError::BadGateway(format!("чтение PNG: {e}")))
    }
    .await;
    let _ = tokio::fs::remove_file(&tmp).await;
    let png = png?;

    let media_dir = media::media_dir();
    let pseudo_url = format!("chromium-screenshot:{url}");
    let dl = media::store_media_bytes(
        &state.db_write,
        &state.pool,
        &png,
        &pseudo_url,
        "image/png",
        &media_dir,
    )
    .await?;

    let img_src = format!("/api/media/{}", dl.sha256);
    let body = page_screenshot::chromium_screenshot_body_html(&img_src);
    let hash = page_screenshot::chromium_screenshot_content_hash(&body);

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
