//! Настраиваемые «браузерные» заголовки для исходящих HTTP-запросов (обход частых 403 от антибота).

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT, ACCEPT_LANGUAGE, REFERER, USER_AGENT};
use reqwest::Url;
use serde_json::{Map, Value};

use crate::env_util::{env_trim, env_truthy};

const DEFAULT_UA: &str = concat!(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ",
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
);

/// По умолчанию ru + en — многие .ru-сайты отдают контент иначе, чем при en-only.
const DEFAULT_ACCEPT_LANGUAGE: &str = "ru-RU,ru;q=0.9,en-US,en;q=0.8";

const DEFAULT_ACCEPT_HTML: &str =
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8";

const DEFAULT_ACCEPT_FEED: &str =
    "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.1";

const DEFAULT_ACCEPT_MEDIA: &str =
    "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8";

const DEFAULT_SEC_CH_UA: &str =
    r#""Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24""#;

const DEFAULT_SEC_CH_UA_PLATFORM: &str = "\"Windows\"";

/// Строка User-Agent для `reqwest::Client::builder().user_agent(...)` и для CDP.
pub fn default_user_agent_string() -> String {
    env_trim("HTTP_BROWSER_USER_AGENT").unwrap_or_else(|| DEFAULT_UA.to_string())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FetchProfile {
    /// HTML: разбор статьи по ссылке, превью Telegram и т.п.
    ArticleHtml,
    /// RSS / Atom / XML.
    SyndicationFeed,
    /// Картинки/медиа по src.
    MediaAsset,
}

/// Заголовки для `reqwest` (и база для CDP `Network.setExtraHTTPHeaders`).
pub fn headers_for(profile: FetchProfile, request_url: &str) -> Result<HeaderMap, String> {
    let mut m = HeaderMap::new();

    let ua = default_user_agent_string();
    m.insert(
        USER_AGENT,
        HeaderValue::from_str(&ua).map_err(|e| format!("HTTP_BROWSER_USER_AGENT: {e}"))?,
    );

    let accept = match profile {
        FetchProfile::ArticleHtml => env_trim("HTTP_BROWSER_ACCEPT_HTML")
            .unwrap_or_else(|| DEFAULT_ACCEPT_HTML.to_string()),
        FetchProfile::SyndicationFeed => env_trim("HTTP_BROWSER_ACCEPT_FEED")
            .unwrap_or_else(|| DEFAULT_ACCEPT_FEED.to_string()),
        FetchProfile::MediaAsset => env_trim("HTTP_BROWSER_ACCEPT_MEDIA")
            .unwrap_or_else(|| DEFAULT_ACCEPT_MEDIA.to_string()),
    };
    m.insert(
        ACCEPT,
        HeaderValue::from_str(&accept).map_err(|e| format!("Accept: {e}"))?,
    );

    let lang = env_trim("HTTP_BROWSER_ACCEPT_LANGUAGE")
        .unwrap_or_else(|| DEFAULT_ACCEPT_LANGUAGE.to_string());
    m.insert(
        ACCEPT_LANGUAGE,
        HeaderValue::from_str(&lang).map_err(|e| format!("Accept-Language: {e}"))?,
    );

    let sec_ch = env_trim("HTTP_BROWSER_SEC_CH_UA")
        .unwrap_or_else(|| DEFAULT_SEC_CH_UA.to_string());
    m.insert(
        HeaderName::from_static("sec-ch-ua"),
        HeaderValue::from_str(&sec_ch).map_err(|e| format!("Sec-CH-UA: {e}"))?,
    );
    m.insert(
        HeaderName::from_static("sec-ch-ua-mobile"),
        HeaderValue::from_static("?0"),
    );
    let plat = env_trim("HTTP_BROWSER_SEC_CH_UA_PLATFORM")
        .unwrap_or_else(|| DEFAULT_SEC_CH_UA_PLATFORM.to_string());
    m.insert(
        HeaderName::from_static("sec-ch-ua-platform"),
        HeaderValue::from_str(&plat).map_err(|e| format!("Sec-CH-UA-Platform: {e}"))?,
    );

    match profile {
        FetchProfile::ArticleHtml => {
            m.insert(
                HeaderName::from_static("sec-fetch-dest"),
                HeaderValue::from_static("document"),
            );
            m.insert(
                HeaderName::from_static("sec-fetch-mode"),
                HeaderValue::from_static("navigate"),
            );
            m.insert(
                HeaderName::from_static("sec-fetch-user"),
                HeaderValue::from_static("?1"),
            );
        }
        FetchProfile::SyndicationFeed => {
            m.insert(
                HeaderName::from_static("sec-fetch-dest"),
                HeaderValue::from_static("empty"),
            );
            m.insert(
                HeaderName::from_static("sec-fetch-mode"),
                HeaderValue::from_static("cors"),
            );
        }
        FetchProfile::MediaAsset => {
            m.insert(
                HeaderName::from_static("sec-fetch-dest"),
                HeaderValue::from_static("image"),
            );
            m.insert(
                HeaderName::from_static("sec-fetch-mode"),
                HeaderValue::from_static("no-cors"),
            );
        }
    }

    let sec_fetch_site = env_trim("HTTP_BROWSER_SEC_FETCH_SITE")
        .unwrap_or_else(|| "cross-site".to_string());
    m.insert(
        HeaderName::from_static("sec-fetch-site"),
        HeaderValue::from_str(&sec_fetch_site)
            .map_err(|e| format!("Sec-Fetch-Site: {e}"))?,
    );

    m.insert(
        HeaderName::from_static("upgrade-insecure-requests"),
        HeaderValue::from_static("1"),
    );

    if !env_truthy("HTTP_BROWSER_NO_REFERER") {
        if let Some(r) = env_trim("HTTP_BROWSER_REFERER") {
            m.insert(
                REFERER,
                HeaderValue::from_str(&r).map_err(|e| format!("HTTP_BROWSER_REFERER: {e}"))?,
            );
        } else if let Ok(u) = Url::parse(request_url) {
            if matches!(u.scheme(), "http" | "https") {
                if let Some(host) = u.host_str() {
                    let origin = format!("{}://{}/", u.scheme(), host);
                    if let Ok(v) = HeaderValue::from_str(&origin) {
                        m.insert(REFERER, v);
                    }
                }
            }
        }
    }

    apply_extra_headers(&mut m)?;
    Ok(m)
}

/// Строки для `Emulation.setUserAgentOverride` (без парсинга HeaderMap).
pub fn cdp_user_agent_parts() -> (String, String, String) {
    let ua = default_user_agent_string();
    let lang = env_trim("HTTP_BROWSER_ACCEPT_LANGUAGE")
        .unwrap_or_else(|| DEFAULT_ACCEPT_LANGUAGE.to_string());
    let platform = env_trim("HTTP_BROWSER_PLATFORM").unwrap_or_else(|| "Windows".to_string());
    (ua, lang, platform)
}

/// Дополнительные заголовки навигации для CDP (`Network.setExtraHTTPHeaders`).
pub fn cdp_network_extra_headers_json(profile: FetchProfile, page_url: &str) -> Result<Value, String> {
    let m = headers_for(profile, page_url)?;
    let mut obj = Map::new();
    for (name, value) in m.iter() {
        // User-Agent задаётся через Emulation.setUserAgentOverride.
        if name == USER_AGENT {
            continue;
        }
        let key = name.as_str();
        let val = value
            .to_str()
            .map_err(|_| format!("заголовок {key}: не UTF-8"))?;
        obj.insert(key.to_string(), Value::String(val.to_string()));
    }
    Ok(Value::Object(obj))
}

fn apply_extra_headers(m: &mut HeaderMap) -> Result<(), String> {
    let Some(raw) = env_trim("HTTP_BROWSER_EXTRA_HEADERS") else {
        return Ok(());
    };
    for (i, line) in raw.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((name, val)) = line.split_once(':') else {
            return Err(format!(
                "HTTP_BROWSER_EXTRA_HEADERS: строка {}: ожидается `Имя: значение`",
                i + 1
            ));
        };
        let name = name.trim();
        let val = val.trim();
        if name.is_empty() {
            return Err(format!(
                "HTTP_BROWSER_EXTRA_HEADERS: строка {}: пустое имя заголовка",
                i + 1
            ));
        }
        let hn = HeaderName::from_bytes(name.as_bytes())
            .map_err(|e| format!("HTTP_BROWSER_EXTRA_HEADERS: имя `{name}`: {e}"))?;
        let hv = HeaderValue::from_str(val)
            .map_err(|e| format!("HTTP_BROWSER_EXTRA_HEADERS: значение для `{name}`: {e}"))?;
        m.insert(hn, hv);
    }
    Ok(())
}
