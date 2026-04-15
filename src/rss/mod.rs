mod fetch;
mod normalize;

pub use fetch::{fetch_and_parse, validate_feed_url, FeedFetchError};
pub use normalize::{article_guid, plain_fingerprint};
