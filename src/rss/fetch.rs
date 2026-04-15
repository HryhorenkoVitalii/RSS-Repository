use std::net::{IpAddr, ToSocketAddrs};
use std::time::Duration;

use reqwest::Url;
use rss::Channel;

use crate::browser_http::{headers_for, FetchProfile};

const MAX_FEED_BYTES: usize = 10 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(45);
const MAX_ITEMS_PER_FEED: usize = 500;

#[derive(Debug, thiserror::Error)]
pub enum FeedFetchError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    /// HTML article page fetch (expand-from-link), not RSS XML.
    #[error("{0}")]
    ArticlePage(String),
    #[error("invalid feed xml: {0}")]
    Parse(String),
    #[error("feed exceeds {MAX_FEED_BYTES} bytes")]
    TooLarge,
    #[error("страница больше лимита ({0} МБ)")]
    PageTooLargeMb(usize),
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

pub async fn fetch_and_parse(
    client: &reqwest::Client,
    feed_url: &str,
) -> Result<Channel, FeedFetchError> {
    let url = validate_feed_url(feed_url)?;
    let headers = headers_for(FetchProfile::SyndicationFeed, url.as_str())
        .map_err(|e| FeedFetchError::Parse(format!("заголовки HTTP: {e}")))?;
    let resp = client
        .get(url)
        .headers(headers)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    let bytes = resp.bytes().await?;
    if bytes.len() > MAX_FEED_BYTES {
        return Err(FeedFetchError::TooLarge);
    }
    let mut channel =
        Channel::read_from(&bytes[..]).map_err(|e| FeedFetchError::Parse(e.to_string()))?;
    channel.items.truncate(MAX_ITEMS_PER_FEED);
    Ok(channel)
}
