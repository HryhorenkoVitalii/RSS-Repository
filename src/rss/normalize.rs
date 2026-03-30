use html_escape::decode_html_entities;
use once_cell::sync::OnceCell;
use regex::Regex;
use rss::Item;
use sha2::{Digest, Sha256};

static TAG_RE: OnceCell<Regex> = OnceCell::new();
static WS_RE: OnceCell<Regex> = OnceCell::new();

fn tag_re() -> Result<&'static Regex, regex::Error> {
    TAG_RE.get_or_try_init(|| Regex::new(r"(?s)<[^>]+>"))
}

fn ws_re() -> Result<&'static Regex, regex::Error> {
    WS_RE.get_or_try_init(|| Regex::new(r"\s+"))
}

/// Stable item id: RSS guid value, else SHA-256 of normalized link (hex).
pub fn article_guid(item: &Item) -> Result<String, regex::Error> {
    if let Some(g) = item.guid() {
        let v = g.value().trim();
        if !v.is_empty() {
            return Ok(v.to_string());
        }
    }
    let link = item.link().unwrap_or("").trim();
    if link.is_empty() {
        return Ok("unknown".to_string());
    }
    let norm = normalize_plain(link)?;
    let mut h = Sha256::new();
    h.update(norm.as_bytes());
    Ok(format!("link:{}", hex::encode(h.finalize())))
}

/// Prefer content:encoded-style body, else description; then normalize for hashing.
pub fn canonical_body(item: &Item) -> Result<String, regex::Error> {
    let raw = item.content().or(item.description()).unwrap_or("");
    normalize_plain(raw)
}

fn normalize_plain(s: impl AsRef<str>) -> Result<String, regex::Error> {
    let s = s.as_ref();
    let decoded = decode_html_entities(s);
    let no_tags = tag_re()?.replace_all(decoded.as_ref(), " ");
    let collapsed = ws_re()?.replace_all(no_tags.as_ref(), " ");
    Ok(collapsed.trim().to_lowercase())
}

pub fn content_hash(canonical: &str) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(canonical.as_bytes());
    h.finalize().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;

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
