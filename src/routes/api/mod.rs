//! HTTP handlers mounted under `/api`.

mod articles;
mod feeds;
mod health;
mod media_serve;
mod openapi;
mod polling;

use axum::routing::{delete, get, post};
use axum::Router;

use super::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/health", get(health::health))
        .route("/openapi.json", get(openapi::openapi_json))
        .route("/feeds/events", get(polling::poll_events_sse))
        .route("/feeds/poll-all", post(polling::poll_all_feeds))
        .route("/feeds/options", get(feeds::list_feed_options))
        .route("/feeds", get(feeds::list_feeds).post(feeds::create_feed))
        .route("/feeds/{id}", delete(feeds::delete_feed))
        .route("/feeds/{id}/interval", post(feeds::update_feed_interval))
        .route(
            "/feeds/{id}/telegram-max-items",
            post(feeds::update_feed_telegram_max_items),
        )
        .route(
            "/feeds/{id}/expand-from-link",
            post(feeds::update_feed_expand_from_link),
        )
        .route("/feeds/{id}/poll", post(polling::poll_feed_now))
        .route("/articles", get(articles::list_articles))
        .route(
            "/articles/{article_id}/contents/{content_id}/raw-html",
            get(articles::get_article_content_raw_html),
        )
        .route("/articles/{id}", get(articles::get_article_detail))
        .route(
            "/articles/{id}/expand-from-link",
            post(articles::expand_article_from_link_now),
        )
        .route(
            "/articles/{id}/archive-full-page",
            post(articles::archive_article_full_page_now),
        )
        .route(
            "/articles/{id}/screenshots",
            get(articles::list_article_screenshots),
        )
        .route(
            "/articles/{id}/telegram-reactions",
            get(articles::get_article_telegram_reactions),
        )
        .route("/media/{hash}", get(media_serve::serve_media))
}
