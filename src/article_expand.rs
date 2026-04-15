//! Optional “title-only” RSS: fetch `item.link` HTML and keep main content as article body.
//! `FULL_PAGE_HTML_MARKER` — legacy full-HTML archives (iframe `raw-html`); new archives use Chromium PNG.

use std::time::Duration;

use once_cell::sync::Lazy;
use reqwest::StatusCode;
use reqwest::Url;
use scraper::{Html, Selector};

use crate::rss::{plain_fingerprint, validate_feed_url, FeedFetchError};

const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024;
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

async fn fetch_page_bytes_capped(
    client: &reqwest::Client,
    page_url: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, FeedFetchError> {
    validate_feed_url(page_url)?;
    let headers = crate::browser_http::headers_for(
        crate::browser_http::FetchProfile::ArticleHtml,
        page_url,
    )
    .map_err(|e| FeedFetchError::Parse(format!("заголовки HTTP: {e}")))?;
    let resp = client
        .get(page_url)
        .headers(headers)
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
