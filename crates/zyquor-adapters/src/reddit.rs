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
    /// When set, use Reddit's search endpoint instead of the listing. The
    /// aggregator leaves this empty; the outreach finder sets it.
    pub query: Option<String>,
    /// Reddit `t=` window for search: hour, day, week, month, year, all.
    pub time_window: Option<String>,
}

pub struct RedditAdapter<F: Fetch> {
    fetch: F,
    crawl_service: Option<Arc<dyn CrawlService>>,
    max_items: usize,
    min_comments: i64,
    min_score: i64,
    subreddit: String,
    sort_by: String,
    query: String,
    time_window: String,
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
            query: options
                .query
                .filter(|query| !query.trim().is_empty())
                .unwrap_or_default(),
            time_window: options
                .time_window
                .filter(|window| !window.is_empty())
                .unwrap_or_else(|| "month".to_string()),
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
        let query = &self.query;
        let time_window = &self.time_window;
        let limit = max_items.clamp(1, 100);

        Box::pin(async move {
            let base = if !query.is_empty() {
                let path = if subreddit.is_empty() {
                    format!("{REDDIT_API_BASE}/search.json")
                } else {
                    format!("{REDDIT_API_BASE}/r/{subreddit}/search.json")
                };
                let Ok(mut url) = url::Url::parse(&path) else {
                    return Ok(Vec::new());
                };
                {
                    let mut pairs = url.query_pairs_mut();
                    pairs.append_pair("q", query);
                    pairs.append_pair("sort", "new");
                    pairs.append_pair("t", time_window);
                    pairs.append_pair("limit", &limit.to_string());
                    pairs.append_pair("raw_json", "1");
                    if !subreddit.is_empty() {
                        pairs.append_pair("restrict_sr", "1");
                    }
                }
                url.to_string()
            } else if subreddit.is_empty() {
                format!("{REDDIT_API_BASE}/{sort_by}.json?limit={limit}&raw_json=1")
            } else {
                format!("{REDDIT_API_BASE}/r/{subreddit}/{sort_by}.json?limit={limit}&raw_json=1")
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
                metadata.insert(
                    "author".to_string(),
                    post.get("author").cloned().unwrap_or(Value::Null),
                );
                metadata.insert(
                    "createdUtc".to_string(),
                    post.get("created_utc").cloned().unwrap_or(Value::Null),
                );
                metadata.insert("isSelf".to_string(), Value::Bool(is_self));
                metadata.insert(
                    "removedByCategory".to_string(),
                    post.get("removed_by_category")
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                metadata.insert("locked".to_string(), Value::Bool(truthy("locked")));
                metadata.insert("kind".to_string(), Value::String("post".to_string()));

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

/// New-comment listing for one subreddit. This is the adapter the outreach
/// finder uses to find people describing a problem in their own words; the
/// post listing above is for source ingestion, where the post body is enough.
#[derive(Clone, Default)]
pub struct RedditCommentsAdapterOptions {
    pub max_items: Option<usize>,
    pub subreddit: String,
    pub sort_by: Option<String>,
}

pub struct RedditCommentsAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
    subreddit: String,
    sort_by: String,
}

impl<F: Fetch> RedditCommentsAdapter<F> {
    pub fn new(fetch: F, options: RedditCommentsAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(100).clamp(1, 100),
            subreddit: if options.subreddit.trim().is_empty() {
                String::new()
            } else {
                options.subreddit
            },
            sort_by: options
                .sort_by
                .filter(|sort| !sort.is_empty())
                .unwrap_or_else(|| "new".to_string()),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for RedditCommentsAdapter<F> {
    fn name(&self) -> &str {
        "reddit-comments"
    }

    fn source_type(&self) -> &str {
        "feed"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let subreddit = &self.subreddit;
        let sort_by = &self.sort_by;
        let max_items = self.max_items;

        Box::pin(async move {
            if subreddit.is_empty() {
                return Ok(Vec::new());
            }
            let base = format!(
                "{REDDIT_API_BASE}/r/{subreddit}/comments.json?limit={max_items}&sort={sort_by}&raw_json=1"
            );
            let Ok(response) = fetch.fetch(&base, FetchInit::get()).await else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            let Ok(body) = serde_json::from_str::<Value>(&response.body) else {
                return Ok(Vec::new());
            };
            let comments: Vec<Value> = body
                .get("data")
                .and_then(|data| data.get("children"))
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();

            let mut items = Vec::new();
            for child in comments.into_iter().take(max_items) {
                let Some(comment) = child.get("data") else {
                    continue;
                };
                let text = comment
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim()
                    .to_string();
                if text.is_empty() || text == "[removed]" || text == "[deleted]" {
                    continue;
                }
                let permalink = comment
                    .get("permalink")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if permalink.is_empty() {
                    continue;
                }
                let link_title = comment
                    .get("link_title")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let published = comment
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
                metadata.insert("kind".to_string(), Value::String("comment".to_string()));
                metadata.insert(
                    "subreddit".to_string(),
                    comment.get("subreddit").cloned().unwrap_or(Value::Null),
                );
                metadata.insert(
                    "linkId".to_string(),
                    comment.get("link_id").cloned().unwrap_or(Value::Null),
                );
                metadata.insert(
                    "parentId".to_string(),
                    comment.get("parent_id").cloned().unwrap_or(Value::Null),
                );
                metadata.insert(
                    "author".to_string(),
                    comment.get("author").cloned().unwrap_or(Value::Null),
                );
                metadata.insert(
                    "score".to_string(),
                    comment.get("score").cloned().unwrap_or(Value::Null),
                );
                metadata.insert("published".to_string(), Value::String(published.clone()));
                metadata.insert(
                    "removedByCategory".to_string(),
                    comment
                        .get("removed_by_category")
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                metadata.insert(
                    "collapsed".to_string(),
                    Value::Bool(
                        comment
                            .get("collapsed")
                            .and_then(Value::as_bool)
                            .unwrap_or(false),
                    ),
                );
                metadata.insert("linkTitle".to_string(), Value::String(link_title.clone()));

                items.push(SourceItem {
                    title: if link_title.is_empty() {
                        format!("r/{subreddit} comment")
                    } else {
                        link_title
                    },
                    url: format!("https://reddit.com{permalink}"),
                    content: text,
                    image_url: None,
                    metadata,
                });
            }
            Ok(items)
        })
    }
}
