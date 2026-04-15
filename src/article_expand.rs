//! Optional “title-only” RSS: fetch `item.link` HTML and keep main content as article body.
//! Full-page snapshot: raw HTML with `FULL_PAGE_HTML_MARKER` for iframe display.

use std::time::Duration;

use once_cell::sync::Lazy;
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, REFERER, USER_AGENT};
use reqwest::StatusCode;
use reqwest::Url;
use scraper::{Html, Selector};
use sha2::{Digest, Sha256};

use crate::rss::{plain_fingerprint, validate_feed_url, FeedFetchError};

const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024;
/// Full-document archive (stored as-is, shown in a sandboxed iframe).
const FULL_PAGE_MAX_BYTES: usize = 8 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Prepended to `article_contents.body` so the UI serves this version via `raw-html` in an iframe.
pub const FULL_PAGE_HTML_MARKER: &str = "<!--rss-repository:full-page-html-->\n";
/// Plain-text fingerprint shorter than this ⇒ treat RSS body as stub (fetch from link).
const STUB_PLAIN_LEN: usize = 80;

static SEL_ARTICLE: Lazy<Selector> = Lazy::new(|| Selector::parse("article").unwrap());
static SEL_MAIN: Lazy<Selector> = Lazy::new(|| Selector::parse("main").unwrap());
static SEL_ROLE_MAIN: Lazy<Selector> =
    Lazy::new(|| Selector::parse(r#"div[role="main"]"#).unwrap());
static SEL_ARTICLE_BODY: Lazy<Selector> =
    Lazy::new(|| Selector::parse(".article-body").unwrap());
static SEL_POST_CONTENT: Lazy<Selector> =
    Lazy::new(|| Selector::parse(".post-content").unwrap());
static SEL_ENTRY: Lazy<Selector> = Lazy::new(|| Selector::parse(".entry-content").unwrap());
static SEL_CONTENT: Lazy<Selector> = Lazy::new(|| Selector::parse("#content").unwrap());
static SEL_BODY: Lazy<Selector> = Lazy::new(|| Selector::parse("body").unwrap());

pub fn rss_body_is_stub(body: &str) -> Result<bool, regex::Error> {
    let plain = plain_fingerprint(body)?;
    Ok(plain.len() < STUB_PLAIN_LEN)
}

/// Resolve `href` against feed home URL when the item link is relative.
pub fn resolve_article_url(item_link: &str, channel_link: Option<&str>) -> Option<String> {
    let link = item_link.trim();
    if link.is_empty() {
        return None;
    }
    if link.starts_with("http://") || link.starts_with("https://") {
        return Some(link.to_string());
    }
    let base = channel_link?.trim();
    let base_url = Url::parse(base).ok()?;
    base_url.join(link).ok().map(|u| u.to_string())
}

fn pick_main_inner_html(doc: &Html) -> Option<String> {
    let candidates: &[&Selector] = &[
        &SEL_ARTICLE,
        &SEL_MAIN,
        &SEL_ROLE_MAIN,
        &SEL_ARTICLE_BODY,
        &SEL_POST_CONTENT,
        &SEL_ENTRY,
        &SEL_CONTENT,
        &SEL_BODY,
    ];
    for sel in candidates {
        if let Some(el) = doc.select(sel).next() {
            let inner = el.inner_html();
            if inner.trim().len() > 48 {
                return Some(inner);
            }
        }
    }
    None
}

fn sanitize_fragment(html: &str) -> String {
    let mut b = ammonia::Builder::new();
    b.link_rel(Some("noopener noreferrer"));
    b.clean(html).to_string()
}

/// Many news sites return 403 to bare `reqwest` defaults; send a typical browser-like request.
fn expand_page_headers(page_url: &str) -> HeaderMap {
    let mut m = HeaderMap::new();
    let _ = m.insert(
        USER_AGENT,
        HeaderValue::from_static(concat!(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ",
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        )),
    );
    let _ = m.insert(
        ACCEPT,
        HeaderValue::from_static(
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        ),
    );
    let _ = m.insert(ACCEPT_LANGUAGE, HeaderValue::from_static("en-US,en;q=0.9"));
    let _ = m.insert(
        "Sec-CH-UA",
        HeaderValue::from_static(
            r#""Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24""#,
        ),
    );
    let _ = m.insert("Sec-CH-UA-Mobile", HeaderValue::from_static("?0"));
    let _ = m.insert(
        "Sec-CH-UA-Platform",
        HeaderValue::from_static("\"Windows\""),
    );
    let _ = m.insert("Sec-Fetch-Dest", HeaderValue::from_static("document"));
    let _ = m.insert("Sec-Fetch-Mode", HeaderValue::from_static("navigate"));
    let _ = m.insert("Sec-Fetch-User", HeaderValue::from_static("?1"));
    let _ = m.insert("Sec-Fetch-Site", HeaderValue::from_static("cross-site"));
    let _ = m.insert(
        "Upgrade-Insecure-Requests",
        HeaderValue::from_static("1"),
    );

    if let Ok(u) = Url::parse(page_url) {
        if matches!(u.scheme(), "http" | "https") {
            if let Some(host) = u.host_str() {
                let origin = format!("{}://{}/", u.scheme(), host);
                if let Ok(v) = HeaderValue::from_str(&origin) {
                    let _ = m.insert(REFERER, v);
                }
            }
        }
    }
    m
}

async fn fetch_page_bytes_capped(
    client: &reqwest::Client,
    page_url: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, FeedFetchError> {
    validate_feed_url(page_url)?;
    let resp = client
        .get(page_url)
        .headers(expand_page_headers(page_url))
        .timeout(FETCH_TIMEOUT)
        .send()
        .await?;
    let status = resp.status();
    let bytes = resp.bytes().await?;
    if !status.is_success() {
        let base = format!("HTTP {} при загрузке HTML страницы", status.as_u16());
        let hint = if status == StatusCode::FORBIDDEN {
            " — часто так делают крупные медиа (NYTimes и др.): антибот. Тогда остаётся открыть «Open link» в браузере или лента с полным текстом в RSS."
        } else {
            ""
        };
        return Err(FeedFetchError::ArticlePage(format!("{base}{hint}")));
    }
    if bytes.len() > max_bytes {
        let mb = max_bytes / (1024 * 1024);
        if max_bytes > MAX_PAGE_BYTES {
            return Err(FeedFetchError::PageTooLargeMb(mb.max(1)));
        }
        return Err(FeedFetchError::TooLarge);
    }
    Ok(bytes.to_vec())
}

/// Insert `<base href="…">` so relative URLs in a saved document resolve like in the browser.
pub fn inject_base_href_for_archive(html: &str, page_url: &str) -> String {
    let esc = page_url
        .trim()
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;");
    let base_open = format!("<base href=\"{esc}\">");
    let lc = html.to_ascii_lowercase();
    if let Some(start) = lc.find("<head") {
        if let Some(rel_gt) = html[start..].find('>') {
            let p = start + rel_gt + 1;
            return format!("{}{}{}", &html[..p], base_open, &html[p..]);
        }
    }
    if let Some(start) = lc.find("<html") {
        if let Some(rel_gt) = html[start..].find('>') {
            let p = start + rel_gt + 1;
            return format!(
                "{}{}<head><meta charset=\"utf-8\">{}</head>{}",
                &html[..p],
                "",
                base_open,
                &html[p..]
            );
        }
    }
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\">{base_open}</head><body>{html}</body></html>"
    )
}

/// Raw HTML response bytes (UTF-8 lossy). Used for “full page archive” only.
pub async fn fetch_full_page_html(client: &reqwest::Client, page_url: &str) -> Result<String, FeedFetchError> {
    let bytes = fetch_page_bytes_capped(client, page_url, FULL_PAGE_MAX_BYTES).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Content hash for a full-page snapshot (no media inlining — keeps bytes stable).
pub fn full_page_archive_content_hash(body: &str) -> Vec<u8> {
    let mut h = Sha256::new();
    h.update(b"rss-repository:full-page-archive:v1:");
    h.update(body.as_bytes());
    h.finalize().to_vec()
}

pub async fn fetch_article_body_from_url(
    client: &reqwest::Client,
    page_url: &str,
) -> Result<String, FeedFetchError> {
    let bytes = fetch_page_bytes_capped(client, page_url, MAX_PAGE_BYTES).await?;
    let raw = String::from_utf8_lossy(&bytes).into_owned();
    let doc = Html::parse_document(&raw);
    let inner = pick_main_inner_html(&doc).unwrap_or_else(|| {
        doc.select(&SEL_BODY)
            .next()
            .map(|b| b.inner_html())
            .unwrap_or_default()
    });
    if inner.trim().is_empty() {
        return Err(FeedFetchError::Parse(
            "empty extracted article HTML".into(),
        ));
    }
    let wrapped = format!("<div class=\"rss-expanded\">{inner}</div>");
    Ok(sanitize_fragment(&wrapped))
}
