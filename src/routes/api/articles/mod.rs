//! Handlers для `/api/articles`.

mod detail;
mod list;

pub(super) use detail::{
    get_article_content_raw_html, get_article_detail, get_article_telegram_reactions,
};
pub(super) use list::list_articles;
