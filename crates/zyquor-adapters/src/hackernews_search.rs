//! Hacker News Algolia search adapter, ported from
//! `packages/adapters/src/hackernews-search.ts`.

use std::sync::Arc;

use chrono::Utc;
use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, CrawlService, SourceAdapter, SourceItem};

const HN_SEARCH_API: &str = "https://hn.algolia.com/api/v1/search_by_date";

#[derive(Clone, Default)]
pub struct HackerNewsSearchAdapterOptions {
    pub crawl_service: Option<Arc<dyn CrawlService>>,
    pub max_items: Option<usize>,
    /// The `Date` the search window is anchored at (TypeScript takes `now`
    /// from options, defaulting to "today").
    pub now: Option<chrono::DateTime<Utc>>,
    /// `story` (default) or `comment`. Comment search is what the outreach
    /// finder uses; stories are what source ingestion uses.
    pub tags: Option<String>,
    /// Window in days. The source-ingestion adapter keeps the 14-day default;
    /// outreach asks for a wider 30-day window because it ranks by recency.
    pub window_days: Option<i64>,
    pub topic: String,
}

pub struct HackerNewsSearchAdapter<F: Fetch> {
    fetch: F,
    crawl_service: Option<Arc<dyn CrawlService>>,
    max_items: usize,
    now: chrono::DateTime<Utc>,
    tags: String,
    window_days: i64,
    topic: String,
}

impl<F: Fetch> HackerNewsSearchAdapter<F> {
    pub fn new(fetch: F, options: HackerNewsSearchAdapterOptions) -> Self {
        Self {
            fetch,
            crawl_service: options.crawl_service,
            max_items: options.max_items.unwrap_or(10),
            now: options.now.unwrap_or_else(Utc::now),
            tags: options
                .tags
                .filter(|tags| !tags.is_empty())
                .unwrap_or_else(|| "story".to_string()),
            window_days: options.window_days.unwrap_or(14).clamp(1, 90),
            topic: options.topic,
        }
    }
}

/// The search URL with its three query params, matching
/// `packages/adapters/src/hackernews-search.ts` (topic, the `story` tag, the
/// page size clamped to 50, and the 14-day lower-bound epoch).
fn search_url(
    topic: &str,
    tags: &str,
    window_days: i64,
    max_items: usize,
    now: chrono::DateTime<Utc>,
) -> String {
    // A constant URL: this never fails. On the theoretically-impossible
    // parse failure, fall back to returning the bare base string (the
    // subsequent fetch fails and the adapter returns no items, same as
    // the TypeScript adapter's catch path).
    let Ok(mut url) = url::Url::parse(HN_SEARCH_API) else {
        return String::new();
    };
    url.query_pairs_mut()
        .append_pair("query", topic)
        .append_pair("tags", tags)
        .append_pair("hitsPerPage", &max_items.clamp(1, 50).to_string())
        .append_pair(
            "numericFilters",
            &format!(
                "created_at_i>{}",
                (now.timestamp_millis() - window_days * 24 * 60 * 60 * 1000) / 1000
            ),
        );
    url.to_string()
}

impl<F: Fetch + Send + Sync> SourceAdapter for HackerNewsSearchAdapter<F> {
    fn name(&self) -> &str {
        "hackernews-search"
    }

    fn source_type(&self) -> &str {
        "news"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let crawl_service = &self.crawl_service;
        let max_items = self.max_items;
        let topic = &self.topic;
        let now = self.now;
        let tags = &self.tags;
        let window_days = self.window_days;

        Box::pin(async move {
            let url = search_url(topic, tags, window_days, max_items, now);

            let Ok(response) = fetch.fetch(&url, FetchInit::get()).await else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            let Ok(body) = serde_json::from_str::<Value>(&response.body) else {
                return Ok(Vec::new());
            };

            let mut items = Vec::new();
            let is_comment = tags == "comment";
            for hit in body
                .get("hits")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let Some(created_at) = hit
                    .get("created_at")
                    .and_then(Value::as_str)
                    .filter(|created| !created.is_empty())
                else {
                    continue;
                };

                let object_id = hit
                    .get("objectID")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if object_id.is_empty() {
                    continue;
                }

                let (title, story_url, content) = if is_comment {
                    let story_title = hit
                        .get("story_title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    let comment_text = hit
                        .get("comment_text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_string();
                    if comment_text.is_empty() {
                        continue;
                    }
                    (
                        if story_title.is_empty() {
                            "Hacker News comment".to_string()
                        } else {
                            story_title
                        },
                        format!("https://news.ycombinator.com/item?id={object_id}"),
                        comment_text,
                    )
                } else {
                    let Some(title) = hit
                        .get("title")
                        .and_then(Value::as_str)
                        .map(|title| title.trim().to_string())
                        .filter(|title| !title.is_empty())
                    else {
                        continue;
                    };
                    let story_url = hit
                        .get("url")
                        .and_then(Value::as_str)
                        .map(|url| url.trim().to_string())
                        .filter(|url| !url.is_empty())
                        .unwrap_or_else(|| {
                            format!("https://news.ycombinator.com/item?id={object_id}")
                        });
                    let mut content = hit
                        .get("story_text")
                        .and_then(Value::as_str)
                        .map(|text| text.trim().to_string())
                        .filter(|text| !text.is_empty())
                        .unwrap_or_else(|| title.clone());
                    let hit_url = hit.get("url").and_then(Value::as_str).unwrap_or("");
                    if !hit_url.is_empty() {
                        if let Some(crawl_service) = crawl_service.as_ref() {
                            if let Ok(crawled) = crawl_service.crawl(hit_url).await {
                                let markdown_slice = crawled
                                    .markdown
                                    .trim()
                                    .chars()
                                    .take(3000)
                                    .collect::<String>();
                                if !markdown_slice.is_empty() {
                                    content = markdown_slice;
                                }
                            }
                        }
                    }
                    (title, story_url, content)
                };

                let mut metadata = Map::new();
                metadata.insert(
                    "author".to_string(),
                    hit.get("author").cloned().unwrap_or(Value::Null),
                );
                metadata.insert(
                    "comments".to_string(),
                    hit.get("num_comments").cloned().unwrap_or(Value::from(0)),
                );
                metadata.insert(
                    "published".to_string(),
                    Value::String(created_at.to_string()),
                );
                metadata.insert(
                    "score".to_string(),
                    hit.get("points").cloned().unwrap_or(Value::from(0)),
                );
                metadata.insert(
                    "source".to_string(),
                    Value::String("hackernews-search".to_string()),
                );
                metadata.insert("sourceId".to_string(), Value::String(object_id.clone()));
                metadata.insert(
                    "kind".to_string(),
                    Value::String(if is_comment { "comment" } else { "story" }.to_string()),
                );
                if is_comment {
                    metadata.insert(
                        "storyId".to_string(),
                        hit.get("story_id").cloned().unwrap_or(Value::Null),
                    );
                    metadata.insert(
                        "storyTitle".to_string(),
                        hit.get("story_title").cloned().unwrap_or(Value::Null),
                    );
                    metadata.insert(
                        "parentId".to_string(),
                        hit.get("parent_id").cloned().unwrap_or(Value::Null),
                    );
                    metadata.insert(
                        "threadUrl".to_string(),
                        Value::String(format!(
                            "https://news.ycombinator.com/item?id={}",
                            hit.get("story_id")
                                .and_then(Value::as_i64)
                                .map(|id| id.to_string())
                                .unwrap_or_default()
                        )),
                    );
                }

                items.push(SourceItem {
                    title,
                    url: story_url,
                    content,
                    image_url: None,
                    metadata,
                });
            }
            Ok(items)
        })
    }
}
