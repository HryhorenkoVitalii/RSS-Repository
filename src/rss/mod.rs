mod fetch;
mod normalize;

pub use fetch::fetch_and_parse;
pub use normalize::{article_guid, canonical_body, content_hash};
