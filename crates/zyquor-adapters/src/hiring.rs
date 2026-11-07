//! Hacker News "Who is hiring?" adapter, ported from
//! `packages/adapters/src/hiring.ts`.

use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::strip_html;

const HN_API_BASE: &str = "https://hacker-news.firebaseio.com/v0";

#[derive(Debug, Clone, Default)]
pub struct HiringAdapterOptions {
    pub max_items: Option<usize>,
}

pub struct HiringAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
}

impl<F: Fetch> HiringAdapter<F> {
    pub fn new(fetch: F, options: HiringAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(10),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for HiringAdapter<F> {
    fn name(&self) -> &str {
        "hiring-hackernews"
    }

    fn source_type(&self) -> &str {
        "job"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;

        Box::pin(async move {
            let Ok(response) = fetch
                .fetch(&format!("{HN_API_BASE}/jobstories.json"), FetchInit::get())
                .await
            else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            let Ok(ids) = serde_json::from_str::<Vec<i64>>(&response.body) else {
                return Ok(Vec::new());
            };

            let mut items = Vec::new();
            for id in ids.into_iter().take(max_items) {
                if let Some(item) = fetch_hiring_item(fetch, id).await {
                    items.push(item);
                }
            }
            Ok(items)
        })
    }
}

async fn fetch_hiring_item<F: Fetch + Send + Sync>(fetch: &F, id: i64) -> Option<SourceItem> {
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
    let body_text = strip_html(body.get("text").and_then(Value::as_str).unwrap_or(""));

    let content = [
        title.to_string(),
        body_text,
        "Verified hiring source: Hacker News job post.".to_string(),
        "Post should say the account is not affiliated and is sharing the opportunity.".to_string(),
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n");

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
    metadata.insert(
        "published".to_string(),
        published.map(Value::String).unwrap_or(Value::Null),
    );
    metadata.insert(
        "source".to_string(),
        Value::String("hackernews-jobs".to_string()),
    );
    metadata.insert("sourceId".to_string(), Value::from(id));
    // Source metadata kind, not a tweet type: routing maps job items to the
    // useful_info tweet type.
    metadata.insert("type".to_string(), Value::String("hiring".to_string()));

    Some(SourceItem {
        title: title.to_string(),
        url,
        content,
        image_url: None,
        metadata,
    })
}
