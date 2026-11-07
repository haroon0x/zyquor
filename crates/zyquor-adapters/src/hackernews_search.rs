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
    /// The `Date` the 14-day window is anchored at (TypeScript takes `now`
    /// from options, defaulting to "today").
    pub now: Option<chrono::DateTime<Utc>>,
    pub topic: String,
}

pub struct HackerNewsSearchAdapter<F: Fetch> {
    fetch: F,
    crawl_service: Option<Arc<dyn CrawlService>>,
    max_items: usize,
    now: chrono::DateTime<Utc>,
    topic: String,
}

impl<F: Fetch> HackerNewsSearchAdapter<F> {
    pub fn new(fetch: F, options: HackerNewsSearchAdapterOptions) -> Self {
        Self {
            fetch,
            crawl_service: options.crawl_service,
            max_items: options.max_items.unwrap_or(10),
            now: options.now.unwrap_or_else(Utc::now),
            topic: options.topic,
        }
    }
}

/// The search URL with its three query params, matching
/// `packages/adapters/src/hackernews-search.ts` (topic, the `story` tag, the
/// page size clamped to 50, and the 14-day lower-bound epoch).
fn search_url(topic: &str, max_items: usize, now: chrono::DateTime<Utc>) -> String {
    // A constant URL: this never fails. On the theoretically-impossible
    // parse failure, fall back to returning the bare base string (the
    // subsequent fetch fails and the adapter returns no items, same as
    // the TypeScript adapter's catch path).
    let Ok(mut url) = url::Url::parse(HN_SEARCH_API) else {
        return String::new();
    };
    url.query_pairs_mut()
        .append_pair("query", topic)
        .append_pair("tags", "story")
        .append_pair("hitsPerPage", &max_items.clamp(1, 50).to_string())
        .append_pair(
            "numericFilters",
            &format!(
                "created_at_i>{}",
                (now.timestamp_millis() - 14 * 24 * 60 * 60 * 1000) / 1000
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

        Box::pin(async move {
            let url = search_url(topic, max_items, now);

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
            for hit in body
                .get("hits")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
            {
                let Some(title) = hit
                    .get("title")
                    .and_then(Value::as_str)
                    .map(|title| title.trim().to_string())
                    .filter(|title| !title.is_empty())
                else {
                    continue;
                };
                let Some(created_at) = hit
                    .get("created_at")
                    .and_then(Value::as_str)
                    .filter(|created| !created.is_empty())
                else {
                    continue;
                };

                let story_url = hit
                    .get("url")
                    .and_then(Value::as_str)
                    .map(|url| url.trim().to_string())
                    .filter(|url| !url.is_empty())
                    .unwrap_or_else(|| {
                        format!(
                            "https://news.ycombinator.com/item?id={}",
                            hit.get("objectID").and_then(Value::as_str).unwrap_or("")
                        )
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
                metadata.insert(
                    "sourceId".to_string(),
                    hit.get("objectID").cloned().unwrap_or(Value::Null),
                );

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
