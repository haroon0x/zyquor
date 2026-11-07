//! Reddit listing adapter, ported from `packages/adapters/src/reddit.ts`.

use std::sync::Arc;

use chrono::{SecondsFormat, TimeZone, Utc};
use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, CrawlService, SourceAdapter, SourceItem};

const REDDIT_API_BASE: &str = "https://www.reddit.com";

#[derive(Clone, Default)]
pub struct RedditAdapterOptions {
    pub crawl_service: Option<Arc<dyn CrawlService>>,
    pub max_items: Option<usize>,
    pub min_comments: Option<i64>,
    pub min_score: Option<i64>,
    pub subreddit: Option<String>,
    pub sort_by: Option<String>,
}

pub struct RedditAdapter<F: Fetch> {
    fetch: F,
    crawl_service: Option<Arc<dyn CrawlService>>,
    max_items: usize,
    min_comments: i64,
    min_score: i64,
    subreddit: String,
    sort_by: String,
}

impl<F: Fetch> RedditAdapter<F> {
    pub fn new(fetch: F, options: RedditAdapterOptions) -> Self {
        Self {
            fetch,
            crawl_service: options.crawl_service,
            max_items: options.max_items.unwrap_or(10),
            min_comments: options.min_comments.unwrap_or(0),
            min_score: options.min_score.unwrap_or(0),
            subreddit: options
                .subreddit
                .filter(|sub| !sub.is_empty())
                .unwrap_or_default(),
            sort_by: options
                .sort_by
                .filter(|sort| !sort.is_empty())
                .unwrap_or_else(|| "hot".to_string()),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for RedditAdapter<F> {
    fn name(&self) -> &str {
        "reddit"
    }

    fn source_type(&self) -> &str {
        "feed"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let crawl_service = &self.crawl_service;
        let max_items = self.max_items;
        let min_comments = self.min_comments;
        let min_score = self.min_score;
        let subreddit = &self.subreddit;
        let sort_by = &self.sort_by;

        Box::pin(async move {
            let base = if subreddit.is_empty() {
                format!("{REDDIT_API_BASE}/{sort_by}.json")
            } else {
                format!("{REDDIT_API_BASE}/r/{subreddit}/{sort_by}.json")
            };

            let Ok(response) = fetch.fetch(&base, FetchInit::get()).await else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            let Ok(body) = serde_json::from_str::<Value>(&response.body) else {
                return Ok(Vec::new());
            };

            let posts: Vec<Value> = body
                .get("data")
                .and_then(|data| data.get("children"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            let mut items = Vec::new();
            for child in posts.into_iter().take(max_items) {
                let Some(post) = child.get("data") else {
                    continue;
                };
                let truthy = |key: &str| post.get(key).and_then(Value::as_bool).unwrap_or(false);
                if truthy("pinned") || truthy("stickied") {
                    continue;
                }
                let score = post.get("score").and_then(Value::as_i64).unwrap_or(0);
                let num_comments = post
                    .get("num_comments")
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                if score < min_score || num_comments < min_comments {
                    continue;
                }
                let over_18 = truthy("over_18");
                let is_self = truthy("is_self");
                let is_video = truthy("is_video");
                if over_18 || (!is_self && is_video) {
                    continue;
                }

                let mut content = post
                    .get("selftext")
                    .and_then(Value::as_str)
                    .filter(|text| !text.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| {
                        post.get("title")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    });

                let post_url = post.get("url").and_then(Value::as_str).unwrap_or("");
                let domain = post.get("domain").and_then(Value::as_str).unwrap_or("");
                let self_domain = if subreddit.is_empty() {
                    "self.reddit".to_string()
                } else {
                    format!("self.{subreddit}")
                };
                if !post_url.is_empty() && !is_self && !is_video && domain != self_domain {
                    if let Some(crawl_service) = crawl_service.as_ref() {
                        if let Ok(crawled) = crawl_service.crawl(post_url).await {
                            // `(markdown || "").trim().slice(0, 3000) || content`
                            let slice = crawled
                                .markdown
                                .trim()
                                .chars()
                                .take(3000)
                                .collect::<String>();
                            if !slice.is_empty() {
                                content = slice;
                            }
                        }
                    }
                }

                let published = post
                    .get("created_utc")
                    .and_then(Value::as_f64)
                    .map(|created| {
                        let millis = (created * 1000.0) as i64;
                        Utc.timestamp_millis_opt(millis)
                            .single()
                            .map(|instant| instant.to_rfc3339_opts(SecondsFormat::Millis, true))
                            .unwrap_or_default()
                    })
                    .unwrap_or_default();

                let mut metadata = Map::new();
                metadata.insert("published".to_string(), Value::String(published));
                metadata.insert(
                    "subreddit".to_string(),
                    post.get("subreddit").cloned().unwrap_or(Value::Null),
                );
                metadata.insert(
                    "score".to_string(),
                    post.get("score").cloned().unwrap_or(Value::Null),
                );
                metadata.insert(
                    "numComments".to_string(),
                    post.get("num_comments").cloned().unwrap_or(Value::Null),
                );
                metadata.insert(
                    "upvoteRatio".to_string(),
                    post.get("upvote_ratio").cloned().unwrap_or(Value::Null),
                );

                items.push(SourceItem {
                    title: post
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    url: format!(
                        "https://reddit.com{}",
                        post.get("permalink").and_then(Value::as_str).unwrap_or("")
                    ),
                    content,
                    image_url: None,
                    metadata,
                });
            }
            Ok(items)
        })
    }
}
