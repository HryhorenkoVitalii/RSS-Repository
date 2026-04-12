mod fetch;
mod normalize;

pub use fetch::{fetch_and_parse, validate_feed_url};
pub use normalize::{article_guid, canonical_body};
