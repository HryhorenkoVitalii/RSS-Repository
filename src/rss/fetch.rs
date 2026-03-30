use std::time::Duration;

use reqwest::Url;
use rss::Channel;

const MAX_FEED_BYTES: usize = 10 * 1024 * 1024;
const FETCH_TIMEOUT: Duration = Duration::from_secs(45);

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
}

pub async fn fetch_and_parse(
    client: &reqwest::Client,
    feed_url: &str,
) -> Result<Channel, FeedFetchError> {
    let _ = Url::parse(feed_url).map_err(|_| FeedFetchError::BadUrl)?;
    let resp = client
        .get(feed_url)
        .timeout(FETCH_TIMEOUT)
        .send()
        .await?
        .error_for_status()?;
    let bytes = resp.bytes().await?;
    if bytes.len() > MAX_FEED_BYTES {
        return Err(FeedFetchError::TooLarge);
    }
    let channel =
        Channel::read_from(&bytes[..]).map_err(|e| FeedFetchError::Parse(e.to_string()))?;
    Ok(channel)
}
