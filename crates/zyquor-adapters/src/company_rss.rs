//! Company RSS feeds adapter, ported from
//! `packages/adapters/src/company-rss.ts`.

use serde_json::Value;

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};

pub const DEFAULT_COMPANY_RSS_FEEDS: &[(&str, &str)] = &[
    ("openai", "https://openai.com/news/rss.xml"),
    ("openai-dev", "https://developers.openai.com/rss.xml"),
    ("anthropic", "https://www.anthropic.com/news/rss.xml"),
    ("deepmind", "https://deepmind.google/discover/blog/rss.xml"),
    ("github", "https://github.blog/feed/"),
    ("cloudflare", "https://blog.cloudflare.com/rss/"),
    ("vercel", "https://vercel.com/blog/rss.xml"),
    ("supabase", "https://supabase.com/blog/rss.xml"),
    ("stripe", "https://stripe.com/blog/feed.rss"),
    ("mistral", "https://mistral.ai/news/rss"),
    ("huggingface", "https://hf.co/blog/feed.xml"),
];

#[derive(Debug, Clone, Default)]
pub struct CompanyRssAdapterOptions {
    pub max_items: Option<usize>,
    pub feeds: Option<Vec<(String, String)>>,
}

pub struct CompanyRssAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
    feeds: Vec<(String, String)>,
}

impl<F: Fetch> CompanyRssAdapter<F> {
    pub fn new(fetch: F, options: CompanyRssAdapterOptions) -> Self {
        let feeds = options
            .feeds
            .filter(|feeds| !feeds.is_empty())
            .unwrap_or_else(|| {
                DEFAULT_COMPANY_RSS_FEEDS
                    .iter()
                    .cloned()
                    .map(|(name, url)| (name.to_string(), url.to_string()))
                    .collect()
            });
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(20),
            feeds,
        }
    }
}

fn parse_feeds(value: Option<&Value>) -> Option<Vec<(String, String)>> {
    let array = value.and_then(Value::as_array)?;
    let feeds: Vec<(String, String)> = array
        .iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(Value::as_str)?;
            let url = item.get("url").and_then(Value::as_str)?;
            Some((name.to_string(), url.to_string()))
        })
        .collect();
    if feeds.is_empty() { None } else { Some(feeds) }
}

impl<F: Fetch + Send + Sync> SourceAdapter for CompanyRssAdapter<F> {
    fn name(&self) -> &str {
        "company-rss"
    }

    fn source_type(&self) -> &str {
        "feed"
    }

    fn fetch<'a>(
        &'a self,
        config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;
        let configured_feeds = parse_feeds(config_metadata.get("feeds"));
        let feeds = configured_feeds.unwrap_or_else(|| self.feeds.clone());

        Box::pin(async move {
            let per_feed_max = (max_items / feeds.len().max(1)).max(1);
            // `Math.max(1, Math.ceil(maxItems / max(feeds.length, 1)))`
            let per_feed_max = if max_items % feeds.len().max(1) == 0 {
                per_feed_max
            } else {
                per_feed_max + 1
            };

            // TypeScript creates a fresh rss adapter per fetch; the inline
            // `fetch + parse_rss_items` here is the same behaviour without
            // needing `F: Clone`.
            let results = futures::future::join_all(feeds.iter().map(|(feed_name, feed_url)| {
                let feed_name = feed_name.clone();
                let feed_url = feed_url.clone();
                async move {
                    let Ok(response) = fetch.fetch(&feed_url, FetchInit::get()).await else {
                        return (feed_name, Vec::new());
                    };
                    if !response.ok() {
                        return (feed_name, Vec::new());
                    }
                    let items = crate::rss::parse_rss_items(&response.body)
                        .into_iter()
                        .take(per_feed_max)
                        .collect::<Vec<SourceItem>>();
                    (feed_name, items)
                }
            }))
            .await;

            let mut all = Vec::new();
            for (feed_name, items) in results {
                for item in items {
                    let mut metadata = item.metadata.clone();
                    metadata.insert("feedName".to_string(), Value::String(feed_name.clone()));
                    metadata.insert(
                        "source".to_string(),
                        Value::String("company-rss".to_string()),
                    );
                    all.push(SourceItem {
                        title: format!("[{feed_name}] {}", item.title),
                        url: item.url,
                        content: item.content,
                        image_url: item.image_url,
                        metadata,
                    });
                }
            }
            Ok(all.into_iter().take(max_items).collect())
        })
    }
}
