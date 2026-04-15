//! Handlers для `/api/articles`.

mod detail;
mod list;
mod pull;
mod screenshots;

pub(super) use detail::{
    get_article_content_raw_html, get_article_detail, get_article_telegram_reactions,
};
pub(super) use list::list_articles;
pub(super) use pull::{archive_article_full_page_now, expand_article_from_link_now};
pub(super) use screenshots::list_article_screenshots;
