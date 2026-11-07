//! X home feed adapter, ported from `packages/adapters/src/x-feed.ts`.
//!
//! The browser callbacks (`fetchHomeFeed`, `resolveProfileDir`) are injected,
//! exactly as the TypeScript options does; `zyquor-adapters` does not depend
//! on `zyquor-browser` beyond that. `XFeedTweet` mirrors the type in
//! `packages/browser/src/index.ts`.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use chrono::Local;
use serde_json::{Map, Value};

use crate::types::{
    AdapterError, AdapterFuture, AdapterResult, ConfigMetadata, SourceAdapter, SourceItem,
};

/// One tweet in the X home feed, mirroring `XFeedTweet` from the browser package.
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

pub type FetchHomeFeedFn = Arc<
    dyn Fn(
            String,
            Option<usize>,
        )
            -> Pin<Box<dyn Future<Output = AdapterResult<(Vec<XFeedTweet>, String)>> + Send>>
        + Send
        + Sync,
>;
pub type ResolveProfileDirFn = Arc<
    dyn Fn(String) -> Pin<Box<dyn Future<Output = AdapterResult<Option<String>>> + Send>>
        + Send
        + Sync,
>;

#[derive(Clone)]
pub struct XFeedAdapterOptions {
    pub fetch_home_feed: FetchHomeFeedFn,
    pub resolve_profile_dir: ResolveProfileDirFn,
}

pub struct XFeedAdapter {
    fetch_home_feed: FetchHomeFeedFn,
    resolve_profile_dir: ResolveProfileDirFn,
}

impl XFeedAdapter {
    pub fn new(options: XFeedAdapterOptions) -> Self {
        Self {
            fetch_home_feed: options.fetch_home_feed,
            resolve_profile_dir: options.resolve_profile_dir,
        }
    }
}

fn digest_date() -> String {
    Local::now().format("%Y-%m-%d").to_string()
}

impl SourceAdapter for XFeedAdapter {
    fn name(&self) -> &str {
        "x-feed"
    }

    fn source_type(&self) -> &str {
        "x-feed"
    }

    fn fetch<'a>(
        &'a self,
        config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch_home_feed = &self.fetch_home_feed;
        let resolve_profile_dir = &self.resolve_profile_dir;

        Box::pin(async move {
            let Some(account_id) = config_metadata
                .get("accountId")
                .and_then(Value::as_str)
                .filter(|account| !account.is_empty())
            else {
                return Err(AdapterError::new(
                    "x-feed adapter requires accountId in config metadata".to_string(),
                ));
            };

            let profile_dir = resolve_profile_dir(account_id.to_string()).await?;
            let Some(profile_dir) = profile_dir else {
                return Err(AdapterError::new(format!(
                    "No profile dir found for account {account_id}"
                )));
            };

            let (tweets, _url) = fetch_home_feed(profile_dir, Some(20)).await?;
            let date = digest_date();
            let lines: Vec<String> = tweets
                .iter()
                .filter(|tweet| !tweet.text.trim().is_empty())
                .map(|tweet| format!("@{}: {}", tweet.author_handle, tweet.text))
                .collect();

            let mut metadata = Map::new();
            metadata.insert("source".to_string(), Value::String("x-feed".to_string()));
            metadata.insert(
                "published".to_string(),
                Value::String(
                    chrono::Utc::now()
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
                        .to_string(),
                ),
            );
            metadata.insert(
                "type".to_string(),
                Value::String("feed_observation".to_string()),
            );
            metadata.insert(
                "tweets".to_string(),
                Value::Array(
                    tweets
                        .iter()
                        .map(|tweet| {
                            serde_json::json!({
                                "id": tweet.id,
                                "authorHandle": tweet.author_handle,
                                "authorName": tweet.author_name,
                                "text": tweet.text,
                                "url": tweet.url,
                                "publishedAt": tweet.published_at,
                                "isRetweet": tweet.is_retweet,
                            })
                        })
                        .collect(),
                ),
            );

            Ok(vec![SourceItem {
                title: format!("X home feed observations {date}"),
                url: format!("https://x.com/home#zyquor-digest-{date}"),
                content: lines.join("\n"),
                image_url: None,
                metadata,
            }])
        })
    }
}
