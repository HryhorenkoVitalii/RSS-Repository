use axum::body::Body;
use axum::extract::{Path, State};

use crate::error::AppError;
use crate::media;

use crate::routes::AppState;

pub(super) async fn serve_media(
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
        .body(Body::from(bytes))
        .unwrap())
}
