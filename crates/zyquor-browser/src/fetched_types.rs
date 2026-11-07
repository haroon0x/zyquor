//! Shared result/input types for the browser flows, ported from the TS
//! result types in `packages/browser/src/index.ts`.

/// One tweet read from X, mirroring `XFeedTweet` from the browser package.
#[derive(Debug, Clone, PartialEq)]
pub struct XFeedTweet {
    pub id: String,
    pub author_handle: String,
    pub author_name: String,
    pub text: String,
    pub url: String,
    pub published_at: Option<String>,
    pub is_retweet: bool,
    pub is_promoted: Option<bool>,
    pub has_link: Option<bool>,
}

/// Ingestion numbers off a single tweet, mirroring
/// `TweetPerformanceMetrics`.
#[derive(Debug, Clone, PartialEq)]
pub struct TweetPerformanceMetrics {
    pub id: String,
    pub url: String,
    pub views: Option<i64>,
    pub likes: Option<i64>,
    pub replies: Option<i64>,
    pub reposts: Option<i64>,
    pub bookmarks: Option<i64>,
    pub measured_at: String,
}

pub fn tweet_id_from_status_url(status_url: &str) -> Option<String> {
    let path = status_url
        .strip_prefix("https://x.com")
        .or_else(|| status_url.strip_prefix("https://twitter.com"))?;
    let path = path.strip_prefix('/')?;
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() == 3 && parts[1] == "status" && !parts[2].is_empty() {
        return Some(parts[2].to_string());
    }
    None
}
