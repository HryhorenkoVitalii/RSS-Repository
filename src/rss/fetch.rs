use std::io::Cursor;
use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use atom_syndication::Feed as AtomFeed;
use chrono::Utc;
use reqwest::Url;
use rss::{Channel, Guid, Item};

use crate::browser_http::{headers_for, FetchProfile};
use crate::http_retry;

const MAX_FEED_BYTES: usize = 10 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_ITEMS_PER_FEED: usize = 500;

#[derive(Debug, thiserror::Error)]
pub enum FeedFetchError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("invalid feed xml: {0}")]
    Parse(String),
    #[error("feed exceeds {MAX_FEED_BYTES} bytes")]
    TooLarge,
    #[error("invalid url")]
    BadUrl,
    #[error("url scheme must be http or https")]
    ForbiddenScheme,
    #[error("url resolves to a private/reserved IP address")]
    PrivateIp,
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64 // 100.64.0.0/10 (CGNAT)
                || v4.octets()[0] == 169 && v4.octets()[1] == 254       // 169.254.0.0/16
        }
        IpAddr::V6(v6) => {
            v6.is_loopback() || v6.is_unspecified() || {
                let seg = v6.segments();
                (seg[0] & 0xfe00) == 0xfc00 // ULA fc00::/7
                    || (seg[0] == 0xfe80)    // link-local
                    || (seg[0] == 0 && seg[1] == 0 && seg[2] == 0 && seg[3] == 0
                        && seg[4] == 0 && seg[5] == 0xffff) // ::ffff:0:0/96 mapped v4 — check inner
                        && is_private_ip(IpAddr::V4(std::net::Ipv4Addr::new(
                            (seg[6] >> 8) as u8, seg[6] as u8,
                            (seg[7] >> 8) as u8, seg[7] as u8,
                        )))
            }
        }
    }
}

fn allow_private_feeds() -> bool {
    std::env::var("ALLOW_PRIVATE_FEEDS")
        .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
        .unwrap_or(false)
}

/// Validate URL: only http(s), resolve DNS, reject private IPs (unless ALLOW_PRIVATE_FEEDS=true).
pub fn validate_feed_url(feed_url: &str) -> Result<Url, FeedFetchError> {
    let url = Url::parse(feed_url).map_err(|_| FeedFetchError::BadUrl)?;
    match url.scheme() {
        "http" | "https" => {}
        _ => return Err(FeedFetchError::ForbiddenScheme),
    }
    if !allow_private_feeds() {
        let host = url.host_str().ok_or(FeedFetchError::BadUrl)?;
        let port = url.port_or_known_default().unwrap_or(80);
        let addr_str = format!("{host}:{port}");
        if let Ok(addrs) = addr_str.to_socket_addrs() {
            for addr in addrs {
                if is_private_ip(addr.ip()) {
                    return Err(FeedFetchError::PrivateIp);
                }
            }
        }
    }
    Ok(url)
}

fn atom_entry_link(entry: &atom_syndication::Entry) -> Option<String> {
    entry
        .links
        .iter()
        .find(|l| l.rel == "alternate" || l.rel.is_empty())
        .or_else(|| entry.links.first())
        .map(|l| l.href.clone())
        .filter(|s| !s.trim().is_empty())
}

/// Прямые потоки YouTube (`googlevideo.com` и т.п.) не воспроизводятся через обычный `<video>`
/// в браузере (адаптивное качество, подписи URL, ограничения по Referrer).
/// Превью и ссылка «Открыть источник» уже добавлены выше.
fn mrss_video_src_unusable_in_native_video_tag(url: &str) -> bool {
    let u = url.to_ascii_lowercase();
    u.contains("googlevideo.com")
}

/// MRSS `media:content` — прямой URL видео/аудио (часто рядом с `media:thumbnail`).
fn atom_mrss_media_content_urls(entry: &atom_syndication::Entry) -> Vec<String> {
    let mut out = Vec::new();
    let push_from_contents =
        |contents: &[atom_syndication::extension::Extension], out: &mut Vec<String>| {
            for c in contents {
                if let Some(u) = c.attrs.get("url") {
                    let u = u.trim();
                    if u.starts_with("http://") || u.starts_with("https://") {
                        out.push(u.to_string());
                    }
                }
            }
        };

    for ns_map in entry.extensions.values() {
        if let Some(groups) = ns_map.get("group") {
            for group in groups {
                if let Some(contents) = group.children.get("content") {
                    push_from_contents(contents, &mut out);
                }
            }
        }
        if let Some(contents) = ns_map.get("content") {
            push_from_contents(contents, &mut out);
        }
    }
    out.sort();
    out.dedup();
    out
}

/// MRSS (`media:group` / `media:thumbnail`) — так YouTube и часть других Atom-фидов отдают превью без `<img>` в теле.
fn atom_media_thumbnail_url(entry: &atom_syndication::Entry) -> Option<String> {
    for ns_map in entry.extensions.values() {
        if let Some(groups) = ns_map.get("group") {
            for group in groups {
                if let Some(thumbs) = group.children.get("thumbnail") {
                    for thumb in thumbs {
                        if let Some(u) = thumb.attrs.get("url") {
                            let u = u.trim();
                            if !u.is_empty() {
                                return Some(u.to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

fn atom_entry_html(entry: &atom_syndication::Entry) -> String {
    let mut html = String::new();
    if let Some(c) = &entry.content {
        if let Some(v) = &c.value {
            if !v.trim().is_empty() {
                html = v.clone();
            }
        }
    }
    if html.is_empty() {
        if let Some(s) = &entry.summary {
            let t = s.as_str().trim();
            if !t.is_empty() {
                html = match s.r#type {
                    atom_syndication::TextType::Html => s.value.clone(),
                    _ => format!("<p>{}</p>", html_escape::encode_text(s.as_str())),
                };
            }
        }
    }
    if let Some(u) = atom_media_thumbnail_url(entry) {
        let src = html_escape::encode_double_quoted_attribute(&u);
        let img = format!(
            r#"<p><img src="{src}" alt="" loading="lazy" style="max-width:100%;height:auto"/></p>"#
        );
        html = if html.is_empty() {
            img
        } else {
            format!("{img}{html}")
        };
    }
    // Ссылка на страницу записи: после появления превью `html` уже не пустой — добавляем явно,
    // если эта же ссылка ещё не встречается в теле (описание без URL и т.п.).
    if let Some(url) = atom_entry_link(entry) {
        if !html.contains(url.as_str()) {
            let href = html_escape::encode_double_quoted_attribute(&url);
            let link_line = format!(
                r#"<p><a href="{href}" rel="noopener noreferrer">Открыть источник</a></p>"#
            );
            html = if html.is_empty() {
                link_line
            } else {
                format!("{html}{link_line}")
            };
        }
    }

    for u in atom_mrss_media_content_urls(entry) {
        if html.contains(u.as_str()) {
            continue;
        }
        if mrss_video_src_unusable_in_native_video_tag(&u) {
            continue;
        }
        let src = html_escape::encode_double_quoted_attribute(&u);
        let vid = format!(
            r#"<p><video controls preload="metadata" playsinline src="{src}" style="max-width:100%;height:auto"></video></p>"#
        );
        html = if html.is_empty() {
            vid
        } else {
            format!("{html}{vid}")
        };
    }

    html
}

/// YouTube и многие сервисы отдают Atom (`<feed xmlns="http://www.w3.org/2005/Atom">`), а не RSS 2.0.
fn channel_from_atom(bytes: &[u8]) -> Result<Channel, FeedFetchError> {
    let atom = AtomFeed::read_from(Cursor::new(bytes))
        .map_err(|e| FeedFetchError::Parse(format!("atom: {e}")))?;

    let feed_link = atom
        .links
        .iter()
        .find(|l| l.rel == "alternate" || l.rel == "self" || l.rel.is_empty())
        .or_else(|| atom.links.first())
        .map(|l| l.href.clone())
        .unwrap_or_default();

    let mut channel = Channel::default();
    channel.set_title(atom.title.to_string());
    channel.set_link(feed_link);
    channel.set_description(format!("Atom: {}", atom.title.as_str()));

    let mut items: Vec<Item> = Vec::with_capacity(atom.entries.len());
    for e in atom.entries.into_iter() {
        let html = atom_entry_html(&e);
        let when = e
            .published
            .unwrap_or(e.updated)
            .with_timezone(&Utc)
            .to_rfc2822();
        let link = atom_entry_link(&e);
        let title = e.title.to_string();
        let id = e.id;
        let mut it = Item::default();
        it.set_title(Some(title));
        if let Some(l) = link {
            it.set_link(Some(l));
        }
        let mut g = Guid::default();
        g.set_value(id);
        g.set_permalink(false);
        it.set_guid(Some(g));
        if !html.is_empty() {
            it.set_content(Some(html));
        }
        it.set_pub_date(Some(when));
        items.push(it);
    }
    channel.set_items(items);
    Ok(channel)
}

fn parse_feed_xml(bytes: &[u8]) -> Result<Channel, FeedFetchError> {
    if let Ok(ch) = Channel::read_from(bytes) {
        return Ok(ch);
    }
    channel_from_atom(bytes)
}

pub async fn fetch_and_parse(
    client: &reqwest::Client,
    feed_url: &str,
) -> Result<Channel, FeedFetchError> {
    let url = validate_feed_url(feed_url)?;
    let url_owned = url.to_string();
    let headers = headers_for(FetchProfile::SyndicationFeed, url_owned.as_str())
        .map_err(|e| FeedFetchError::Parse(format!("заголовки HTTP: {e}")))?;
    let resp = http_retry::send_with_retries(|| {
        client
            .get(url_owned.as_str())
            .headers(headers.clone())
            .timeout(FETCH_TIMEOUT)
    })
    .await?
    .error_for_status()?;
    let bytes = resp.bytes().await?;
    if bytes.len() > MAX_FEED_BYTES {
        return Err(FeedFetchError::TooLarge);
    }
    let mut channel = parse_feed_xml(&bytes[..])?;
    channel.items.truncate(MAX_ITEMS_PER_FEED);
    Ok(channel)
}

#[cfg(test)]
mod tests {
    use super::channel_from_atom;

    #[test]
    fn atom_youtube_mrss_thumbnail_becomes_img_in_content() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <id>feed</id>
  <title>T</title>
  <updated>2020-01-01T00:00:00Z</updated>
  <entry>
    <id>e1</id>
    <title>E</title>
    <updated>2020-01-01T00:00:00Z</updated>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc"/>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/abc/hqdefault.jpg" width="480" height="360"/>
    </media:group>
  </entry>
</feed>"#;
        let ch = channel_from_atom(xml).expect("parse atom");
        let html = ch.items()[0].content().expect("content set");
        assert!(html.contains("hqdefault.jpg"), "{html}");
        assert!(html.contains("<img"), "{html}");
        assert!(
            html.contains("watch?v=abc") && html.contains("Открыть источник"),
            "alternate link preserved with thumbnail: {html}"
        );
    }

    #[test]
    fn atom_youtube_googlevideo_mrss_skips_native_video_tag() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <id>feed</id>
  <title>T</title>
  <updated>2020-01-01T00:00:00Z</updated>
  <entry>
    <id>e-yt</id>
    <title>YT</title>
    <updated>2020-01-01T00:00:00Z</updated>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc"/>
    <media:group>
      <media:thumbnail url="https://i.ytimg.com/vi/abc/hqdefault.jpg"/>
      <media:content url="https://r1.test.googlevideo.com/videoplayback?id=1" type="video/mp4"/>
    </media:group>
  </entry>
</feed>"#;
        let ch = channel_from_atom(xml).expect("parse atom");
        let html = ch.items()[0].content().expect("content set");
        assert!(
            !html.contains("<video"),
            "googlevideo MRSS must not inject broken <video>: {html}"
        );
        assert!(html.contains("hqdefault.jpg"), "{html}");
        assert!(html.contains("Открыть источник"), "{html}");
    }

    #[test]
    fn atom_mrss_media_content_becomes_video_tag() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <id>feed</id>
  <title>T</title>
  <updated>2020-01-01T00:00:00Z</updated>
  <entry>
    <id>e2</id>
    <title>V</title>
    <updated>2020-01-01T00:00:00Z</updated>
    <media:group>
      <media:content url="https://cdn.example/video.mp4" type="video/mp4"/>
    </media:group>
  </entry>
</feed>"#;
        let ch = channel_from_atom(xml).expect("parse atom");
        let html = ch.items()[0].content().expect("content set");
        assert!(html.contains("video.mp4"), "{html}");
        assert!(html.contains("<video"), "{html}");
    }
}
