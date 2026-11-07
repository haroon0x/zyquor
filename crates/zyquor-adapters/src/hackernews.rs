//! Hacker News (Firebase) adapter, ported from `packages/adapters/src/hackernews.ts`.

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, CrawlService, SourceAdapter, SourceItem};

const HN_API_BASE: &str = "https://hacker-news.firebaseio.com/v0";

#[derive(Clone, Default)]
pub struct HackerNewsAdapterOptions {
    pub crawl_service: Option<Arc<dyn CrawlService>>,
    pub feed: Option<String>,
    pub max_items: Option<usize>,
}

pub struct HackerNewsAdapter<F: Fetch> {
    fetch: F,
    crawl_service: Option<Arc<dyn CrawlService>>,
    feed: String,
    max_items: usize,
    name: String,
}

impl<F: Fetch> HackerNewsAdapter<F> {
    pub fn new(fetch: F, options: HackerNewsAdapterOptions) -> Self {
        let feed = options
            .feed
            .filter(|feed| !feed.is_empty())
            .unwrap_or_else(|| "topstories".to_string());
        let name = if feed == "topstories" {
            "hackernews".to_string()
        } else {
            format!("hackernews-{}", feed.replace("stories", ""))
        };
        Self {
            fetch,
            crawl_service: options.crawl_service,
            feed,
            max_items: options.max_items.unwrap_or(5),
            name,
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for HackerNewsAdapter<F> {
    fn name(&self) -> &str {
        &self.name
    }

    fn source_type(&self) -> &str {
        "news"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let feed = &self.feed;
        let max_items = self.max_items;
        let crawl_service = self.crawl_service.clone();
        Box::pin(async move {
            let Ok(top_response) = fetch
                .fetch(&format!("{HN_API_BASE}/{feed}.json"), FetchInit::get())
                .await
            else {
                return Ok(Vec::new());
            };
            if !top_response.ok() {
                return Ok(Vec::new());
            }
            let Ok(top_ids) = serde_json::from_str::<Vec<i64>>(&top_response.body) else {
                return Ok(Vec::new());
            };

            let mut items = Vec::new();
            for id in top_ids.into_iter().take(max_items) {
                if let Some(item) = fetch_hn_item(fetch, &crawl_service, id).await {
                    items.push(item);
                }
            }
            Ok(items)
        })
    }
}

async fn fetch_hn_item<F: Fetch + Send + Sync>(
    fetch: &F,
    crawl_service: &Option<Arc<dyn CrawlService>>,
    id: i64,
) -> Option<SourceItem> {
    let response = fetch
        .fetch(&format!("{HN_API_BASE}/item/{id}.json"), FetchInit::get())
        .await
        .ok()?;
    if !response.ok() {
        return None;
    }
    let body: Value = serde_json::from_str(&response.body).ok()?;
    let title = body
        .get("title")?
        .as_str()
        .filter(|title| !title.is_empty())?;
    let url = body
        .get("url")
        .and_then(Value::as_str)
        .filter(|url| !url.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("https://news.ycombinator.com/item?id={id}"));
    let mut content = body
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let item_url = body.get("url").and_then(Value::as_str).unwrap_or("");
    if !item_url.is_empty() && content.is_empty() {
        if let Some(crawl_service) = crawl_service.as_ref() {
            if let Ok(crawled) = crawl_service.crawl(item_url).await {
                // `(markdown || "").trim().slice(0, 3000)` — trim, then
                // slice; JS does not re-trim the result.
                content = crawled
                    .markdown
                    .trim()
                    .chars()
                    .take(3000)
                    .collect::<String>();
            }
        }
    }

    let published = body
        .get("time")
        .and_then(Value::as_i64)
        .filter(|time| *time != 0)
        .and_then(crate::dates::iso_from_unix_seconds);

    let mut metadata = Map::new();
    metadata.insert(
        "author".to_string(),
        body.get("by").cloned().unwrap_or(Value::Null),
    );
    metadata.insert("comments".to_string(), json_i64(body.get("descendants"), 0));
    metadata.insert(
        "published".to_string(),
        published.map(Value::String).unwrap_or(Value::Null),
    );
    metadata.insert("score".to_string(), json_i64(body.get("score"), 0));
    metadata.insert("sourceId".to_string(), Value::from(id));

    Some(SourceItem {
        title: title.to_string(),
        url,
        content: if content.is_empty() {
            title.to_string()
        } else {
            content
        },
        image_url: None,
        metadata,
    })
}

pub(crate) fn json_i64(value: Option<&Value>, default: i64) -> Value {
    value
        .and_then(Value::as_i64)
        .map(Value::from)
        .unwrap_or_else(|| Value::from(default))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::fetch::{Fetch, FetchInit, FetchResponse};
    use crate::{RssAdapter, RssAdapterOptions};
    use std::collections::HashMap;
    use std::sync::Mutex;

    struct FakeFetch {
        routes: Mutex<HashMap<String, (u16, String)>>,
        calls: Mutex<Vec<(String, FetchInit)>>,
    }

    impl FakeFetch {
        fn new(routes: Vec<(&str, u16, &str)>) -> Self {
            Self {
                routes: Mutex::new(
                    routes
                        .into_iter()
                        .map(|(url, status, body)| (url.to_string(), (status, body.to_string())))
                        .collect(),
                ),
                calls: Mutex::new(Vec::new()),
            }
        }
    }

    impl Fetch for FakeFetch {
        fn fetch<'a>(
            &'a self,
            url: &'a str,
            init: FetchInit,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = crate::types::AdapterResult<FetchResponse>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                self.calls.lock().unwrap().push((url.to_string(), init));
                let (status, body) = self
                    .routes
                    .lock()
                    .unwrap()
                    .get(url)
                    .cloned()
                    .unwrap_or((404, String::new()));
                Ok(FetchResponse { status, body })
            })
        }
    }

    #[tokio::test]
    async fn hn_adapter_maps_items_and_metadata() {
        let item = r#"{"by":"sama","descendants":42,"score":100,"time":1793988011,"title":"Rust is great","url":"https://example.test/a","text":""}"#;
        let adapter = HackerNewsAdapter::new(
            FakeFetch::new(vec![
                (
                    "https://hacker-news.firebaseio.com/v0/topstories.json",
                    200,
                    "[42]",
                ),
                (
                    "https://hacker-news.firebaseio.com/v0/item/42.json",
                    200,
                    item,
                ),
            ]),
            HackerNewsAdapterOptions::default(),
        );

        let items = adapter.fetch(&ConfigMetadata::new()).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Rust is great");
        assert_eq!(items[0].url, "https://example.test/a");
        assert_eq!(
            items[0].metadata.get("published").unwrap(),
            &Value::String("2026-11-06T18:00:11.000Z".to_string())
        );
        assert_eq!(
            items[0].metadata.get("author").unwrap(),
            &Value::String("sama".to_string())
        );
        assert_eq!(items[0].metadata.get("comments").unwrap(), &Value::from(42));
        assert_eq!(items[0].metadata.get("score").unwrap(), &Value::from(100));
        assert_eq!(items[0].metadata.get("sourceId").unwrap(), &Value::from(42));
    }

    #[tokio::test]
    async fn hn_adapter_falls_back_to_discussion_url() {
        let item = r#"{"by":"pg","time":1762605211,"title":"Ask HN: no url link","text":""}"#;
        let adapter = HackerNewsAdapter::new(
            FakeFetch::new(vec![
                (
                    "https://hacker-news.firebaseio.com/v0/topstories.json",
                    200,
                    "[7]",
                ),
                (
                    "https://hacker-news.firebaseio.com/v0/item/7.json",
                    200,
                    item,
                ),
            ]),
            HackerNewsAdapterOptions::default(),
        );

        let items = adapter.fetch(&ConfigMetadata::new()).await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].url, "https://news.ycombinator.com/item?id=7");
        // No text and no crawl: content falls back to the title.
        assert_eq!(items[0].content, "Ask HN: no url link");
    }

    #[tokio::test]
    async fn rss_adapter_parses_and_filters() {
        let xml = r#"<rss><channel><item><title>Point &amp; click</title><link>https://a.test/1</link><description>First</description><pubDate>Fri, 06 Nov 2026 12:00:00 GMT</pubDate></item><item><title>Missing link</title></item></channel></rss>"#;
        let adapter = RssAdapter::new(
            FakeFetch::new(vec![("https://feeds.test/rss", 200, xml)]),
            RssAdapterOptions::default(),
        );
        let items = adapter
            .fetch(&ConfigMetadata::from_iter([(
                "feedUrl".to_string(),
                Value::String("https://feeds.test/rss".to_string()),
            )]))
            .await
            .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "Point & click");
        assert_eq!(items[0].content, "First");
        assert_eq!(
            items[0].metadata.get("published").unwrap(),
            &Value::String("Fri, 06 Nov 2026 12:00:00 GMT".to_string())
        );
    }
}
