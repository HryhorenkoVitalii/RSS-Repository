use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{self, IF_NONE_MATCH};
use axum::http::{HeaderMap, HeaderValue, StatusCode};

use crate::error::AppError;
use crate::media;

use crate::routes::AppState;

pub(super) async fn serve_media(
    State(state): State<AppState>,
    Path(hash): Path<String>,
    headers: HeaderMap,
) -> Result<axum::response::Response, AppError> {
    if hash.len() != 64 || !hash.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(AppError::BadRequest("invalid hash".into()));
    }

    let row = media::get_media_by_hash(&state.pool, &hash)
        .await?
        .ok_or(AppError::NotFound)?;

    let dir = media::media_dir();
    let file_path = media::find_media_file(&dir, &hash).ok_or(AppError::NotFound)?;

    let etag = format!("\"{hash}\"");
    if let Some(inm) = headers.get(IF_NONE_MATCH) {
        let matches = inm.to_str().ok().is_some_and(|s| {
            let s = s.trim();
            s == etag
                || s == hash
                || s.trim_matches('"') == hash
                || s.split(',').any(|p| {
                    let p = p.trim();
                    p == etag || p == hash || p.trim_matches('"') == hash
                })
        });
        if matches {
            return Ok(axum::response::Response::builder()
                .status(StatusCode::NOT_MODIFIED)
                .header(header::ETAG, HeaderValue::from_str(&etag).unwrap())
                .header(
                    header::CACHE_CONTROL,
                    "public, max-age=31536000, immutable",
                )
                .body(Body::empty())
                .unwrap());
        }
    }

    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|_| AppError::NotFound)?;

    let cache_forever = "public, max-age=31536000, immutable";
    Ok(axum::response::Response::builder()
        .status(200)
        .header(header::CONTENT_TYPE, row.mime_type.as_str())
        .header(header::CACHE_CONTROL, cache_forever)
        .header(header::ETAG, HeaderValue::from_str(&etag).unwrap())
        .body(Body::from(bytes))
        .unwrap())
}
