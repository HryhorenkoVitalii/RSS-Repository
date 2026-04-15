use std::path::{Path, PathBuf};

use once_cell::sync::OnceCell;
use regex::Regex;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use tokio::sync::Semaphore;

use crate::browser_http::{headers_for, FetchProfile};
use crate::error::AppError;
use crate::http_retry;

static MEDIA_RE: OnceCell<Regex> = OnceCell::new();

fn media_re() -> &'static Regex {
    MEDIA_RE.get_or_init(|| {
        Regex::new(
            r#"(?i)<(?:img|video|audio|source)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']"#,
        )
        .expect("media regex must compile")
    })
}

pub fn media_dir() -> PathBuf {
    std::env::var("MEDIA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("media_store"))
}

fn hash_bytes(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    hex::encode(h.finalize())
}

fn extension_from_mime(mime: &str) -> &str {
    match mime {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/ogg" => "ogg",
        _ => "bin",
    }
}

fn extension_from_url(url: &str) -> Option<&str> {
    let path = url.split('?').next()?;
    let dot = path.rfind('.')?;
    let ext = &path[dot + 1..];
    if ext.len() <= 5 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        Some(ext)
    } else {
        None
    }
}

fn file_path(dir: &Path, sha: &str, ext: &str) -> PathBuf {
    let sub = &sha[..2];
    dir.join(sub).join(format!("{sha}.{ext}"))
}

const MAX_MEDIA_BYTES: usize = 50 * 1024 * 1024;
const MEDIA_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

pub struct DownloadedMedia {
    pub sha256: String,
    pub mime_type: String,
    pub file_size: usize,
}

pub async fn download_and_store(
    client: &reqwest::Client,
    url: &str,
    dir: &Path,
) -> Result<DownloadedMedia, String> {
    let url_owned = url.to_string();
    let headers = headers_for(FetchProfile::MediaAsset, url_owned.as_str())
        .map_err(|e| format!("заголовки HTTP: {e}"))?;
    let resp = http_retry::send_with_retries(|| {
        client
            .get(url_owned.as_str())
            .headers(headers.clone())
            .timeout(MEDIA_TIMEOUT)
    })
    .await
    .map_err(|e| format!("media fetch: {e}"))?
    .error_for_status()
    .map_err(|e| format!("media fetch status: {e}"))?;

    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_string();

    let bytes = resp.bytes().await.map_err(|e| format!("media read: {e}"))?;
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(format!("media too large: {} bytes", bytes.len()));
    }

    let sha = hash_bytes(&bytes);
    let ext = extension_from_url(url).unwrap_or_else(|| extension_from_mime(&content_type));
    let path = file_path(dir, &sha, ext);

    if !path.exists() {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| format!("mkdir: {e}"))?;
        }
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| format!("write media: {e}"))?;
    }

    Ok(DownloadedMedia {
        sha256: sha,
        mime_type: content_type,
        file_size: bytes.len(),
    })
}

/// Write `bytes` into `MEDIA_DIR` (if missing) and insert a `media` row (same layout as after HTTP download).
pub async fn store_media_bytes(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    bytes: &[u8],
    original_url: &str,
    mime_type: &str,
    dir: &std::path::Path,
) -> Result<DownloadedMedia, AppError> {
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty media payload".into()));
    }
    if bytes.len() > MAX_MEDIA_BYTES {
        return Err(AppError::BadRequest(format!(
            "media exceeds {} bytes",
            MAX_MEDIA_BYTES
        )));
    }
    let sha = hash_bytes(bytes);
    let ext = extension_from_mime(mime_type);
    let path = file_path(dir, &sha, ext);
    if !path.exists() {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                AppError::BadGateway(format!("media mkdir: {e}"))
            })?;
        }
        tokio::fs::write(&path, bytes)
            .await
            .map_err(|e| AppError::BadGateway(format!("media write: {e}")))?;
    }
    save_media_record(
        write_lock,
        pool,
        &sha,
        original_url,
        mime_type,
        bytes.len() as i64,
    )
    .await?;
    Ok(DownloadedMedia {
        sha256: sha,
        mime_type: mime_type.to_string(),
        file_size: bytes.len(),
    })
}

pub async fn save_media_record(
    write_lock: &Semaphore,
    pool: &SqlitePool,
    sha256: &str,
    original_url: &str,
    mime_type: &str,
    file_size: i64,
) -> Result<(), AppError> {
    let _w = write_lock
        .acquire()
        .await
        .expect("db_write semaphore must stay open");
    sqlx::query(
        r#"INSERT OR IGNORE INTO media (sha256, original_url, mime_type, file_size) VALUES (?, ?, ?, ?)"#,
    )
    .bind(sha256)
    .bind(original_url)
    .bind(mime_type)
    .bind(file_size)
    .execute(pool)
    .await
    .map_err(AppError::from)?;
    Ok(())
}

#[derive(Debug, Clone, sqlx::FromRow)]
#[allow(dead_code)]
pub struct MediaRow {
    pub sha256: String,
    pub mime_type: String,
}

pub async fn get_media_by_hash(pool: &SqlitePool, sha256: &str) -> Result<Option<MediaRow>, AppError> {
    let row = sqlx::query_as::<_, MediaRow>(
        "SELECT sha256, mime_type FROM media WHERE sha256 = ?",
    )
    .bind(sha256)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Extract media URLs from HTML body.
pub fn extract_media_urls(html: &str) -> Vec<String> {
    media_re()
        .captures_iter(html)
        .filter_map(|cap| {
            let url = cap.get(1)?.as_str().trim();
            if url.starts_with("http://") || url.starts_with("https://") {
                Some(url.to_string())
            } else {
                None
            }
        })
        .collect()
}

/// Replace media URLs in HTML with local proxy URLs.
pub fn rewrite_media_urls(html: &str, replacements: &[(String, String)]) -> String {
    let mut result = html.to_string();
    for (original, local) in replacements {
        result = result.replace(original, local);
    }
    result
}

/// Compute a combined hash of text content + media hashes (sorted for stability).
pub fn combined_content_hash(text_canonical: &str, media_hashes: &mut [String]) -> Vec<u8> {
    media_hashes.sort();
    let mut h = Sha256::new();
    h.update(text_canonical.as_bytes());
    for mh in media_hashes.iter() {
        h.update(b"|media:");
        h.update(mh.as_bytes());
    }
    h.finalize().to_vec()
}

/// Find all files for a given sha256 prefix (2-char subdir + hash).
pub fn find_media_file(dir: &Path, sha256: &str) -> Option<PathBuf> {
    if sha256.len() < 3 {
        return None;
    }
    let sub = &sha256[..2];
    let sub_dir = dir.join(sub);
    if !sub_dir.exists() {
        return None;
    }
    if let Ok(entries) = std::fs::read_dir(&sub_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(sha256) {
                return Some(entry.path());
            }
        }
    }
    None
}
