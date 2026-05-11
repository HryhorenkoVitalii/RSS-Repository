use html_escape::decode_html_entities;
use once_cell::sync::OnceCell;
use regex::Regex;
use rss::Item;
use sha2::{Digest, Sha256};
use url::Url;

static TAG_RE: OnceCell<Regex> = OnceCell::new();
static WS_RE: OnceCell<Regex> = OnceCell::new();

fn tag_re() -> Result<&'static Regex, regex::Error> {
    TAG_RE.get_or_try_init(|| Regex::new(r"(?s)<[^>]+>"))
}

fn ws_re() -> Result<&'static Regex, regex::Error> {
    WS_RE.get_or_try_init(|| Regex::new(r"\s+"))
}

/// If `s` is a YouTube video URL or `yt:video:…` id, returns canonical `yt:video:<id>` (lowercase id).
/// Otherwise returns `None` so callers can keep the original guid/link.
pub fn canonical_youtube_item_guid(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(id) = s.strip_prefix("yt:video:") {
        let id = id.trim();
        if youtube_video_id_ok(id) {
            return Some(format!("yt:video:{}", id.to_ascii_lowercase()));
        }
        return None;
    }
    if let Some(id) = parse_youtube_video_id_from_url(s) {
        return Some(format!("yt:video:{id}"));
    }
    None
}

pub fn youtube_video_id_ok(id: &str) -> bool {
    let len = id.len();
    if !(6..=64).contains(&len) {
        return false;
    }
    id.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn parse_youtube_video_id_from_url(s: &str) -> Option<String> {
    let u = Url::parse(s).ok()?;
    let host = u.host_str()?.to_ascii_lowercase();
    let is_yt = host == "youtu.be"
        || host.ends_with(".youtube.com")
        || host == "youtube.com"
        || host == "music.youtube.com";
    if !is_yt {
        return None;
    }

    if host == "youtu.be" {
        let id = u.path_segments()?.next()?;
        return youtube_video_id_ok(id).then(|| id.to_ascii_lowercase());
    }

    let path = u.path().trim_end_matches('/');
    if path == "/watch" || path.is_empty() {
        for (k, v) in u.query_pairs() {
            if k == "v" && youtube_video_id_ok(&v) {
                return Some(v.into_owned().to_ascii_lowercase());
            }
        }
    }
    for prefix in ["/shorts/", "/live/", "/embed/", "/v/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            let id = rest.split('/').next()?.split('?').next()?;
            if youtube_video_id_ok(id) {
                return Some(id.to_ascii_lowercase());
            }
        }
    }
    None
}

/// Stable item id: RSS guid / link, with YouTube URLs collapsed to `yt:video:<id>`.
/// If missing, SHA-256 of normalized link (hex).
pub fn article_guid(item: &Item) -> Result<String, regex::Error> {
    let raw = item
        .guid()
        .map(|g| g.value().trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            item.link()
                .map(|l| l.trim().to_string())
                .filter(|s| !s.is_empty())
        });

    if let Some(ref s) = raw {
        if let Some(yt) = canonical_youtube_item_guid(s) {
            return Ok(yt);
        }
        return Ok(s.clone());
    }

    let link = item.link().unwrap_or("").trim();
    if link.is_empty() {
        return Ok("unknown".to_string());
    }
    if let Some(yt) = canonical_youtube_item_guid(link) {
        return Ok(yt);
    }
    let norm = normalize_plain(link)?;
    let mut h = Sha256::new();
    h.update(norm.as_bytes());
    Ok(format!("link:{}", hex::encode(h.finalize())))
}

/// Strip tags and collapse whitespace (used for hashing any HTML body).
pub fn plain_fingerprint(html: impl AsRef<str>) -> Result<String, regex::Error> {
    normalize_plain(html)
}

fn normalize_plain(s: impl AsRef<str>) -> Result<String, regex::Error> {
    let s = s.as_ref();
    let decoded = decode_html_entities(s);
    let no_tags = tag_re()?.replace_all(decoded.as_ref(), " ");
    let collapsed = ws_re()?.replace_all(no_tags.as_ref(), " ");
    Ok(collapsed.trim().to_lowercase())
}


#[cfg(test)]
mod tests {
    use super::*;
    use rss::{Guid, Item};

    #[test]
    fn youtube_watch_urls_differ_only_by_query_same_guid() {
        let a = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&feature=youtu.be";
        let b = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12";
        assert_eq!(
            canonical_youtube_item_guid(a).as_deref(),
            Some("yt:video:dqw4w9wgxcq")
        );
        assert_eq!(canonical_youtube_item_guid(a), canonical_youtube_item_guid(b));
    }

    #[test]
    fn youtube_youtu_be_and_watch_same_guid() {
        let a = "https://youtu.be/dQw4w9WgXcQ?si=abc";
        let b = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
        assert_eq!(canonical_youtube_item_guid(a), canonical_youtube_item_guid(b));
    }

    #[test]
    fn article_guid_prefers_canonical_youtube_from_guid_field() -> Result<(), regex::Error> {
        let mut it = Item::default();
        let mut g = Guid::default();
        g.set_value("https://www.youtube.com/watch?v=abcabcabcab&list=PLx");
        g.set_permalink(true);
        it.set_guid(Some(g));
        assert_eq!(article_guid(&it)?, "yt:video:abcabcabcab");
        Ok(())
    }

    #[test]
    fn normalize_collapses_whitespace_and_strips_tags() -> Result<(), regex::Error> {
        let s = "  <p>Hello</p>  \n World  ";
        assert_eq!(normalize_plain(s)?, "hello world");
        Ok(())
    }

    #[test]
    fn same_text_different_html_same_canonical() -> Result<(), regex::Error> {
        let a = "<b>Test</b>";
        let b = "Test";
        assert_eq!(normalize_plain(a)?, normalize_plain(b)?);
        Ok(())
    }
}
