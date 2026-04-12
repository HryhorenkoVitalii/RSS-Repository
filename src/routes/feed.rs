use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use axum::http::StatusCode;
use axum::response::Response;
use chrono::{DateTime, NaiveDate, Utc};
use rss::{Channel, Guid, Item};
use serde::Deserialize;

use crate::db::{self, ArticleFilter, ArticleListQuery, Feed};
use crate::error::AppError;
use crate::ingest::poll_feed;

use super::AppState;

const RSS_PAGE_SIZE: i64 = 100;

#[derive(Deserialize, Default)]
pub struct RssQuery {
    pub feed_id: Option<String>,
    /// Case-insensitive match on stored feed title (after first poll). Must be unique among feeds.
    pub title: Option<String>,
    pub modified_only: Option<String>,
    /// Inclusive start day (`YYYY-MM-DD`), UTC midnight. Filters `last_fetched_at`.
    pub date_from: Option<String>,
    /// Inclusive end day (`YYYY-MM-DD`), UTC end of day. Filters `last_fetched_at`.
    pub date_to: Option<String>,
    /// For a single feed (`feed_id` or unique `title`): default **true** — poll source before RSS.
    /// For combined feed (no id/title): default **false**. Set `refresh=false` to skip poll.
    pub refresh: Option<String>,
}

fn parse_feed_ids(raw: &Option<String>) -> Vec<i64> {
    match raw.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => s.split(',').filter_map(|t| t.trim().parse::<i64>().ok()).collect(),
        None => Vec::new(),
    }
}

fn parse_date_from_day(s: &str) -> Option<DateTime<Utc>> {
    let t = s.trim();
    if t.is_empty() { return None; }
    let d = NaiveDate::parse_from_str(t, "%Y-%m-%d").ok()?;
    let naive = d.and_hms_opt(0, 0, 0)?;
    Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

fn parse_date_to_exclusive(s: &str) -> Option<DateTime<Utc>> {
    let t = s.trim();
    if t.is_empty() { return None; }
    let d = NaiveDate::parse_from_str(t, "%Y-%m-%d").ok()?;
    let next = d.succ_opt()?;
    let naive = next.and_hms_opt(0, 0, 0)?;
    Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc))
}

fn wants_refresh(refresh: &Option<String>, single_feed: bool) -> bool {
    match refresh.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some("0" | "false" | "no" | "off") => false,
        Some(_) => true,
        None => single_feed,
    }
}

fn item_link(base: &str, article: &crate::db::Article) -> String {
    article
        .link
        .clone()
        .unwrap_or_else(|| format!("{}/articles/{}", base.trim_end_matches('/'), article.id))
}

fn item_pub_date(article: &crate::db::Article) -> String {
    article
        .published_at
        .unwrap_or(article.last_fetched_at)
        .to_rfc2822()
}

fn rss_description(article: &crate::db::Article) -> String {
    let mut builder = ammonia::Builder::new();
    builder.link_rel(Some("noopener noreferrer"));
    let current = builder.clean(&article.body).to_string();
    if article.content_version_count > 1 {
        if let Some(prev) = article
            .previous_body
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            let old = builder.clean(prev).to_string();
            let mut out = format!(
                "<p><em>Несколько версий текста в источнике (всего {n}).</em></p>\
                 <p><strong>Предпоследняя:</strong></p>{old}\
                 <p><strong>Последняя:</strong></p>{current}",
                n = article.content_version_count,
                old = old,
                current = current
            );
            if article.content_version_count > 2 {
                out.push_str("<p><em>Промежуточные версии — на странице статьи на сайте.</em></p>");
            }
            return out;
        }
    }
    current
}

pub async fn rss_feed(
    State(state): State<AppState>,
    Query(q): Query<RssQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let base = super::base_url_from_headers(&headers);
    let only_modified = matches!(q.modified_only.as_deref(), Some("true" | "on" | "1"));

    let mut feed_ids = parse_feed_ids(&q.feed_id);
    if feed_ids.len() > 50 {
        return Err(AppError::BadRequest("too many feed_id values (max 50)".into()));
    }

    let last_fetched_from = q.date_from.as_deref().and_then(parse_date_from_day);
    let last_fetched_before = q.date_to.as_deref().and_then(parse_date_to_exclusive);

    let selected: Option<(i64, Feed)> = if feed_ids.len() == 1 {
        let fid = feed_ids[0];
        let f = db::get_feed(&state.pool, fid)
            .await?
            .ok_or(AppError::NotFound)?;
        Some((fid, f))
    } else if feed_ids.is_empty() {
        if let Some(ref t) = q.title {
            let mut rows = db::find_feeds_by_title_ci(&state.pool, t).await?;
            match rows.len() {
                0 => return Err(AppError::NotFound),
                1 => {
                    let f = rows.swap_remove(0);
                    feed_ids = vec![f.id];
                    Some((f.id, f))
                }
                _ => {
                    return Err(AppError::BadRequest(
                        "ambiguous title: several feeds share this title; use feed_id=… in the URL"
                            .into(),
                    ));
                }
            }
        } else {
            None
        }
    } else {
        None
    };

    let single_feed = selected.is_some();
    if wants_refresh(&q.refresh, single_feed) {
        if let Some((_, ref feed)) = selected {
            poll_feed(state.db_write.as_ref(), &state.pool, &state.http, feed)
                .await
                .map_err(|e| {
                    tracing::warn!(feed_id = feed.id, error = %e, "rss pre-fetch poll failed");
                    AppError::BadGateway("could not refresh feed from source".into())
                })?;
        }
    }

    let articles = db::list_articles(
        &state.pool,
        ArticleListQuery {
            filter: ArticleFilter {
                feed_ids: feed_ids.clone(),
                only_modified,
                last_fetched_from,
                last_fetched_before,
            },
            limit: RSS_PAGE_SIZE,
            offset: 0,
        },
    )
    .await?;

    let base_trim = base.trim_end_matches('/');
    let (title, description, channel_link) = if let Some((fid, ref feed)) = selected {
        let title = feed
            .title
            .as_deref()
            .filter(|t| !t.trim().is_empty())
            .map(|t| format!("RSS Repository — {t}"))
            .unwrap_or_else(|| format!("RSS Repository — лента #{fid}"));
        let description =
            format!("Собранные статьи из вашей ленты (id {fid}). HTML: {base_trim}/articles",);
        (title, description, format!("{base_trim}/articles"))
    } else if feed_ids.len() > 1 {
        let ids_str: Vec<String> = feed_ids.iter().map(|id| id.to_string()).collect();
        let title = format!("RSS Repository — ленты {}", ids_str.join(", "));
        let description = format!(
            "Собранные статьи из выбранных лент ({}). HTML: {base_trim}/articles",
            ids_str.join(", ")
        );
        (title, description, format!("{base_trim}/articles"))
    } else {
        let title = "RSS Repository — все ленты".to_string();
        let description = "Все собранные статьи. Фильтр: ?feed_id=1,2,3&modified_only=1".to_string();
        let channel_link = format!("{base_trim}/articles");
        (title, description, channel_link)
    };

    let mut items = Vec::with_capacity(articles.len());
    for article in &articles {
        let link = item_link(&base, article);
        let guid_value = format!("{base_trim}/articles/{}", article.id);
        let title = if article.title.trim().is_empty() {
            "(без заголовка)".to_string()
        } else {
            article.title.clone()
        };
        items.push(Item {
            title: Some(title),
            link: Some(link),
            description: Some(rss_description(article)),
            guid: Some(Guid {
                value: guid_value,
                permalink: true,
            }),
            pub_date: Some(item_pub_date(article)),
            ..Default::default()
        });
    }

    let last_build = Utc::now().to_rfc2822();
    let channel = Channel {
        title,
        link: channel_link,
        description,
        items,
        generator: Some("rss-repository".to_string()),
        last_build_date: Some(last_build),
        ..Default::default()
    };

    let body = channel.to_string();

    let mut res = Response::new(Body::from(body));
    *res.status_mut() = StatusCode::OK;
    res.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/rss+xml; charset=utf-8"),
    );
    Ok(res)
}
