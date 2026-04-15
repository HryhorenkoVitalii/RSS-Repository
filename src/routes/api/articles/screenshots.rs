use axum::extract::{Path, State};
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::db::{self, ArticleScreenshotRow};
use crate::error::AppError;
use crate::routes::AppState;

#[derive(Serialize)]
pub(crate) struct ScreenshotEntry {
    pub id: i64,
    pub captured_at: DateTime<Utc>,
    pub media_sha256: String,
    pub media_url: String,
}

pub(crate) fn screenshot_entry_from_row(row: &ArticleScreenshotRow) -> ScreenshotEntry {
    ScreenshotEntry {
        id: row.id,
        captured_at: row.captured_at,
        media_sha256: row.media_sha256.clone(),
        media_url: format!("/api/media/{}", row.media_sha256),
    }
}

pub(crate) async fn list_article_screenshots(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<Json<Vec<ScreenshotEntry>>, AppError> {
    db::get_article(&state.pool, id)
        .await?
        .ok_or(AppError::NotFound)?;
    let rows = db::list_article_screenshots(&state.pool, id).await?;
    let out: Vec<ScreenshotEntry> = rows.iter().map(screenshot_entry_from_row).collect();
    Ok(Json(out))
}
