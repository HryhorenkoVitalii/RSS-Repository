//! Public Telegram channel preview pages (`https://t.me/s/<username>`) → RSS `Channel`
//! for the same ingest path as normal RSS feeds (ported from RSS-Telegram-Bridge/scraper.py).

use std::cmp::Ordering;
use std::collections::HashMap;
use std::time::Duration;

use chrono::{DateTime, Utc};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::Url;
use rss::{Channel, Guid, Item};
use scraper::{ElementRef, Html, Selector};

use crate::browser_http::{headers_for, FetchProfile};
use crate::http_retry;
use crate::rss::{validate_feed_url, FeedFetchError};

const MAX_HTML_BYTES: usize = 10 * 1024 * 1024;
/// Upper bound for how many Telegram preview posts we fetch per poll.
pub const TELEGRAM_FETCH_MAX_CAP: usize = 500;
const FETCH_TIMEOUT: Duration = Duration::from_secs(45);

static SEL_MESSAGE: Lazy<Selector> =
    Lazy::new(|| Selector::parse("div.tgme_widget_message").expect("selector"));
static SEL_DATE_LINK: Lazy<Selector> =
    Lazy::new(|| Selector::parse("a.tgme_widget_message_date").expect("selector"));
static SEL_TIME: Lazy<Selector> =
    Lazy::new(|| Selector::parse("time[datetime]").expect("selector"));
static SEL_TEXT: Lazy<Selector> =
    Lazy::new(|| Selector::parse("div.tgme_widget_message_text").expect("selector"));
static SEL_REACTIONS: Lazy<Selector> =
    Lazy::new(|| Selector::parse(".tgme_widget_message_reactions").expect("selector"));
static SEL_REACTION_SPAN: Lazy<Selector> =
    Lazy::new(|| Selector::parse("span.tgme_reaction").expect("selector"));
static SEL_TG_EMOJI: Lazy<Selector> = Lazy::new(|| Selector::parse("tg-emoji").expect("selector"));
static SEL_PHOTO_WRAP: Lazy<Selector> =
    Lazy::new(|| Selector::parse(".tgme_widget_message_photo_wrap").expect("selector"));
static SEL_VIDEO: Lazy<Selector> =
    Lazy::new(|| Selector::parse("video.tgme_widget_message_video").expect("selector"));
static SEL_VIDEO_THUMB: Lazy<Selector> =
    Lazy::new(|| Selector::parse(".tgme_widget_message_video_thumb").expect("selector"));
static SEL_LINK_PREVIEW: Lazy<Selector> =
    Lazy::new(|| Selector::parse(".link_preview_image").expect("selector"));
static SEL_VIDEO_DURATION: Lazy<Selector> =
    Lazy::new(|| Selector::parse(".message_video_duration").expect("selector"));
static URL_IN_STYLE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"url\(['"]?([^'"()]+)['"]?\)"#).expect("regex"));
static REACTION_TEXT: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^(.*\D)([\d.,]+[KkMm]?)$").expect("regex"));

/// Known Telegram custom emoji IDs → Unicode (same map as RSS-Telegram-Bridge).
static CUSTOM_EMOJI: Lazy<std::collections::HashMap<&'static str, &'static str>> = Lazy::new(|| {
    [
        ("5265077361648368841", "👍"),
        ("5456669990092545624", "❤️"),
        ("5384108682290152083", "🔥"),
        ("5472404692975753822", "🎉"),
        ("5215512756152704759", "😁"),
        ("5210734545203213934", "🤩"),
        ("5312536423851630001", "🥱"),
        ("5373123633982030957", "😱"),
        ("5350337537759070427", "🤬"),
        ("5253182607069203996", "😢"),
        ("5373141891321699124", "💯"),
        ("5373141891321699127", "💔"),
        ("5440539497383087970", "🤡"),
        ("5373058637092196878", "🤮"),
        ("5422651856220357502", "💩"),
        ("5413859451353495041", "👎"),
        ("5431815452437257407", "😐"),
        ("5395263977352473453", "🙏"),
        ("5395263977352473460", "😴"),
        ("5373091498328494017", "🎅"),
        ("5309880522557946738", "🏆"),
        ("5471952986970267163", "🤣"),
        ("5420315771991497307", "👏"),
    ]
    .into_iter()
    .collect()
});

fn valid_channel_username(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 4 || b.len() > 32 {
        return false;
    }
    b.iter()
        .all(|&c| c.is_ascii_alphanumeric() || c == b'_')
}

/// Telegram-юзернеймы нечувствительны к регистру; БД (uk_feeds_url) — тоже (unicode_ci) → дубликат «по PK».
fn canonical_channel_username(s: &str) -> String {
    s.to_ascii_lowercase()
}

/// Стабильный id поста для RSS guid и `reactions_by_guid`: `user/msg…` с user в lower case.
fn canonical_telegram_item_id(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return String::new();
    }
    if let Some((user, rest)) = s.split_once('/') {
        if valid_channel_username(user) && !rest.is_empty() {
            return format!("{}/{}", user.to_ascii_lowercase(), rest);
        }
    }
    s.to_string()
}

/// Из ссылки t.me — тот же канон, что и у `data-post`, чтобы не плодить «два guid» на один пост.
fn guid_from_t_me_link(link: &str) -> Option<String> {
    let u = Url::parse(link.trim()).ok()?;
    let h = u.host_str()?.to_ascii_lowercase();
    if !matches!(
        h.as_str(),
        "t.me" | "www.t.me" | "telegram.me" | "www.telegram.me"
    ) {
        return None;
    }
    let segs: Vec<&str> = u.path_segments()?.filter(|s| !s.is_empty()).collect();
    match segs.as_slice() {
        ["s", user, rest @ ..] if !rest.is_empty() && valid_channel_username(user) => Some(format!(
            "{}/{}",
            user.to_ascii_lowercase(),
            rest.join("/")
        )),
        [user, rest @ ..] if !rest.is_empty() && valid_channel_username(user) => Some(format!(
            "{}/{}",
            user.to_ascii_lowercase(),
            rest.join("/")
        )),
        _ => None,
    }
}

fn telegram_rss_item_guid(data_post: &str, link: &str) -> String {
    let dp = data_post.trim();
    if !dp.is_empty() {
        return canonical_telegram_item_id(dp);
    }
    guid_from_t_me_link(link).unwrap_or_else(|| link.to_string())
}

fn reserved_path_segment(seg: &str) -> bool {
    matches!(
        seg,
        "s"
            | "c"
            | "joinchat"
            | "addstickers"
            | "iv"
            | "login"
            | "download"
            | "addemoji"
            | "proxy"
            | "setlanguage"
    )
}

/// If the user input is a public Telegram channel handle or `t.me` / `telegram.me` URL,
/// returns canonical preview URL `https://t.me/s/<username>`. Otherwise `None` (RSS URL).
pub fn try_telegram_preview_url(raw: &str) -> Option<String> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if let Some(u) = t.strip_prefix('@').map(str::trim) {
        if valid_channel_username(u) {
            return Some(format!(
                "https://t.me/s/{}",
                canonical_channel_username(u)
            ));
        }
        return None;
    }

    let with_scheme = if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        format!("https://{t}")
    };

    let url = Url::parse(&with_scheme).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    if !matches!(
        host.as_str(),
        "t.me" | "www.t.me" | "telegram.me" | "www.telegram.me"
    ) {
        return None;
    }

    let segments: Vec<&str> = url.path_segments()?.filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return None;
    }

    if segments[0] == "s" {
        let user = *segments.get(1)?;
        if !valid_channel_username(user) {
            return None;
        }
        return Some(format!(
            "https://t.me/s/{}",
            canonical_channel_username(user)
        ));
    }

    if segments.len() == 1 {
        let seg = segments[0];
        if reserved_path_segment(seg) {
            return None;
        }
        if valid_channel_username(seg) {
            return Some(format!(
                "https://t.me/s/{}",
                canonical_channel_username(seg)
            ));
        }
    }

    None
}

pub fn is_telegram_preview_url(url: &str) -> bool {
    let Ok(u) = Url::parse(url) else {
        return false;
    };
    let Some(host) = u.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    matches!(
        host.as_str(),
        "t.me" | "www.t.me" | "telegram.me" | "www.telegram.me"
    ) && u.path().starts_with("/s/")
}

fn preview_username(preview_url: &str) -> Option<String> {
    let u = Url::parse(preview_url).ok()?;
    let mut segs = u.path_segments()?.filter(|s| !s.is_empty());
    if segs.next()? != "s" {
        return None;
    }
    segs.next().map(str::to_string)
}

fn escape_xml_text(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn sanitize_url(url: &str) -> String {
    let url = url
        .trim()
        .replace('"', "%22")
        .replace('\'', "%27")
        .replace(' ', "%20");
    if url.starts_with("http://") || url.starts_with("https://") {
        url
    } else {
        String::new()
    }
}

fn url_from_style(style: &str) -> Option<String> {
    let m = URL_IN_STYLE.captures(style)?;
    let u = sanitize_url(m.get(1)?.as_str().trim());
    if u.is_empty() {
        None
    } else {
        Some(u)
    }
}

fn parse_reactions(msg: ElementRef<'_>) -> Vec<(String, String)> {
    let Some(block) = msg.select(&SEL_REACTIONS).next() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for span in block.select(&SEL_REACTION_SPAN) {
        let classes: Vec<&str> = span.value().classes().collect();
        if classes.contains(&"tgme_reaction_paid") {
            let count = span.text().collect::<String>();
            let count = count.trim().to_string();
            if !count.is_empty() {
                out.push(("⭐".to_string(), count));
            }
            continue;
        }
        if let Some(tg) = span.select(&SEL_TG_EMOJI).next() {
            let emoji_id = tg.value().attr("emoji-id").unwrap_or_default();
            let emoji = CUSTOM_EMOJI
                .get(emoji_id)
                .copied()
                .unwrap_or("👾")
                .to_string();
            let count = span.text().collect::<String>();
            let count = count.trim().to_string();
            if !emoji.is_empty() && !count.is_empty() {
                out.push((emoji, count));
            }
            continue;
        }
        let text = span.text().collect::<String>();
        let text = text.trim();
        let Some(caps) = REACTION_TEXT.captures(text) else {
            continue;
        };
        let emoji = caps.get(1).map(|m| m.as_str().trim().to_string()).unwrap_or_default();
        let count = caps.get(2).map(|m| m.as_str().to_string()).unwrap_or_default();
        if !emoji.is_empty() && !count.is_empty() {
            out.push((emoji, count));
        }
    }
    out
}

fn extract_media_html(msg: ElementRef<'_>) -> String {
    let mut parts = Vec::new();
    let mut seen = std::collections::HashSet::<String>::new();

    for photo in msg.select(&SEL_PHOTO_WRAP) {
        let style = photo.value().attr("style").unwrap_or("");
        if let Some(url) = url_from_style(style) {
            if seen.insert(url.clone()) {
                parts.push(format!(
                    r#"<p><img src="{url}" alt="" style="max-width:100%"/></p>"#
                ));
            }
        }
    }

    for video_el in msg.select(&SEL_VIDEO) {
        let src = video_el
            .value()
            .attr("src")
            .map(|s| sanitize_url(s.trim()))
            .unwrap_or_default();
        if src.is_empty() || !seen.insert(src.clone()) {
            continue;
        }
        let duration = video_el
            .parent()
            .and_then(ElementRef::wrap)
            .and_then(|p| p.select(&SEL_VIDEO_DURATION).next())
            .map(|e: ElementRef<'_>| escape_xml_text(e.text().collect::<String>().trim()))
            .unwrap_or_default();
        let label = format!("▶ Video {duration}").trim().to_string();
        let label_esc = escape_xml_text(&label);
        parts.push(format!(
            r#"<p><video src="{src}" controls preload="none" style="max-width:100%"><a href="{src}">{label_esc}</a></video></p>"#
        ));
    }

    if !parts.iter().any(|p| p.contains("<video")) {
        for thumb in msg.select(&SEL_VIDEO_THUMB) {
            let style = thumb.value().attr("style").unwrap_or("");
            if let Some(url) = url_from_style(style) {
                if seen.insert(url.clone()) {
                    parts.push(format!(
                        r#"<p><img src="{url}" alt="video preview" style="max-width:100%"/></p>"#
                    ));
                }
            }
        }
    }

    if parts.is_empty() {
        for preview in msg.select(&SEL_LINK_PREVIEW) {
            let style = preview.value().attr("style").unwrap_or("");
            if let Some(url) = url_from_style(style) {
                if seen.insert(url.clone()) {
                    parts.push(format!(
                        r#"<p><img src="{url}" alt="preview" style="max-width:100%"/></p>"#
                    ));
                }
            }
        }
    }

    parts.concat()
}

struct ParsedPost {
    id: String,
    title: String,
    link: String,
    published_rfc2822: Option<String>,
    published_unix: i64,
    description_html: String,
    reactions: Vec<(String, String)>,
}

/// Telegram HTML parsed into an RSS channel plus reaction counts keyed by item GUID (`data-post`).
pub struct TelegramFetched {
    pub channel: Channel,
    pub reactions_by_guid: HashMap<String, Vec<(String, String)>>,
}

fn parse_page(html: &str, base_url: &str) -> Result<(Vec<ParsedPost>, Option<String>), FeedFetchError> {
    let document = Html::parse_document(html);
    let mut posts = Vec::new();
    let mut oldest_id: Option<String> = None;

    for msg in document.select(&SEL_MESSAGE) {
        let data_post = msg.value().attr("data-post").unwrap_or("").to_string();

        let link = msg
            .select(&SEL_DATE_LINK)
            .next()
            .and_then(|a| a.value().attr("href"))
            .map(str::to_string)
            .unwrap_or_else(|| {
                if !data_post.is_empty() {
                    format!("https://t.me/{data_post}")
                } else {
                    base_url.to_string()
                }
            });

        let (published_rfc2822, published_unix) = msg
            .select(&SEL_TIME)
            .next()
            .and_then(|t| t.value().attr("datetime"))
            .and_then(|dt_str| {
                DateTime::parse_from_rfc3339(dt_str)
                    .ok()
                    .map(|dt| {
                        let utc = dt.with_timezone(&Utc);
                        (Some(utc.to_rfc2822()), utc.timestamp())
                    })
            })
            .unwrap_or((None, 0));

        let text_el = msg.select(&SEL_TEXT).next();
        let text_html = text_el
            .as_ref()
            .map(|e| e.inner_html())
            .unwrap_or_default();
        let text_plain: String = text_el
            .as_ref()
            .map(|e| e.text().collect::<Vec<_>>().join(" "))
            .map(|s| s.split_whitespace().collect::<Vec<_>>().join(" "))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "Post without text".into());

        let mut title: String = text_plain.chars().take(96).collect();
        if text_plain.chars().count() > 96 {
            title.push('…');
        }

        let safe_plain = escape_xml_text(&text_plain);
        let has_text = !text_html.trim().is_empty();
        let media_html = extract_media_html(msg);
        let description_html = if has_text {
            text_html + &media_html
        } else {
            format!("<p>{safe_plain}</p>") + &media_html
        };

        let reactions = parse_reactions(msg);

        let post_id = telegram_rss_item_guid(&data_post, &link);

        if let Some(numeric_id) = data_post.rsplit('/').next() {
            if numeric_id.chars().all(|c| c.is_ascii_digit()) {
                let update = oldest_id.as_ref().is_none_or(|o| {
                    numeric_id.parse::<u64>().ok() < o.parse::<u64>().ok()
                });
                if update {
                    oldest_id = Some(numeric_id.to_string());
                }
            }
        }

        posts.push(ParsedPost {
            id: post_id,
            title,
            link,
            published_rfc2822,
            published_unix,
            description_html,
            reactions,
        });
    }

    Ok((posts, oldest_id))
}

/// Fetch Telegram preview HTML (with `?before=` pagination), RSS `Channel`, and reactions per GUID.
pub async fn fetch_telegram_feed(
    client: &reqwest::Client,
    preview_url: &str,
    max_items: usize,
) -> Result<TelegramFetched, FeedFetchError> {
    let max_items = max_items.clamp(1, TELEGRAM_FETCH_MAX_CAP);
    let base = validate_feed_url(preview_url)?;
    if !is_telegram_preview_url(base.as_str()) {
        return Err(FeedFetchError::Parse(
            "not a telegram preview URL (expected https://t.me/s/...)".into(),
        ));
    }
    let base_str = base.as_str().to_string();

    let mut all: Vec<ParsedPost> = Vec::new();
    let mut page_url = base_str.clone();

    while all.len() < max_items {
        let page_owned = page_url.clone();
        let headers = headers_for(FetchProfile::ArticleHtml, page_owned.as_str())
            .map_err(|e| FeedFetchError::Parse(format!("заголовки HTTP: {e}")))?;
        let resp = http_retry::send_with_retries(|| {
            client
                .get(page_owned.as_str())
                .headers(headers.clone())
                .timeout(FETCH_TIMEOUT)
        })
        .await?
        .error_for_status()?;
        let bytes = resp.bytes().await?;
        if bytes.len() > MAX_HTML_BYTES {
            return Err(FeedFetchError::TooLarge);
        }
        let text = String::from_utf8_lossy(&bytes);
        let (page_posts, oldest_id) = parse_page(&text, &base_str)?;
        if page_posts.is_empty() {
            break;
        }
        let page_len = page_posts.len();
        all.extend(page_posts);

        if all.len() >= max_items || page_len < 5 || oldest_id.is_none() {
            break;
        }

        let mut next = Url::parse(&base_str).map_err(|_| FeedFetchError::BadUrl)?;
        next.query_pairs_mut().append_pair("before", oldest_id.as_ref().unwrap());
        page_url = next.to_string();
    }

    all.sort_by(|a, b| match b.published_unix.cmp(&a.published_unix) {
        Ordering::Equal => b.id.cmp(&a.id),
        o => o,
    });
    all.truncate(max_items);

    let username = preview_username(&base_str).unwrap_or_else(|| "channel".into());
    let channel_title = format!("Telegram | {username}");

    let mut reactions_by_guid: HashMap<String, Vec<(String, String)>> = HashMap::new();
    let mut items = Vec::with_capacity(all.len());
    for p in all {
        reactions_by_guid.insert(p.id.clone(), p.reactions.clone());
        let mut item = Item::default();
        item.set_title(p.title);
        item.set_link(Some(p.link));
        item.set_description(Some(p.description_html));
        let mut g = Guid::default();
        g.set_value(p.id);
        g.set_permalink(false);
        item.set_guid(Some(g));
        if let Some(ref d) = p.published_rfc2822 {
            item.set_pub_date(Some(d.clone()));
        }
        items.push(item);
    }

    let mut channel = Channel::default();
    channel.set_title(channel_title);
    channel.set_link(base_str.clone());
    channel.set_description(format!("Telegram preview source {base_str}"));
    channel.set_items(items);
    Ok(TelegramFetched {
        channel,
        reactions_by_guid,
    })
}

/// Normalize user input for a new feed: Telegram preview URL or RSS URL (adds `https://` if missing).
pub fn normalize_new_feed_url(raw: &str) -> Result<String, FeedFetchError> {
    let t = raw.trim();
    if t.is_empty() {
        return Err(FeedFetchError::BadUrl);
    }
    if let Some(u) = try_telegram_preview_url(t) {
        validate_feed_url(&u)?;
        return Ok(u);
    }
    let s = if t.starts_with("http://") || t.starts_with("https://") {
        t.to_string()
    } else {
        format!("https://{t}")
    };
    validate_feed_url(&s)?;
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telegram_item_guid_normalizes_user_case() {
        assert_eq!(
            telegram_rss_item_guid("MyChannel/99", "https://t.me/s/MyChannel/99"),
            "mychannel/99"
        );
        assert_eq!(
            guid_from_t_me_link("https://t.me/s/DuRoV/12345").as_deref(),
            Some("durov/12345")
        );
    }

    #[test]
    fn try_url_handles_at_and_tme() {
        assert_eq!(
            try_telegram_preview_url("https://t.me/s/DuRoV").as_deref(),
            Some("https://t.me/s/durov")
        );
        assert_eq!(
            try_telegram_preview_url("@durov").as_deref(),
            Some("https://t.me/s/durov")
        );
        assert_eq!(
            try_telegram_preview_url("t.me/durov").as_deref(),
            Some("https://t.me/s/durov")
        );
        assert_eq!(
            try_telegram_preview_url("https://t.me/s/durov").as_deref(),
            Some("https://t.me/s/durov")
        );
        assert_eq!(
            try_telegram_preview_url("https://telegram.me/s/vklochok").as_deref(),
            Some("https://t.me/s/vklochok")
        );
        assert!(try_telegram_preview_url("https://example.com/feed.xml").is_none());
    }

    #[test]
    fn is_preview_detects_s_path() {
        assert!(is_telegram_preview_url("https://t.me/s/durov"));
        assert!(!is_telegram_preview_url("https://t.me/durov"));
    }
}
