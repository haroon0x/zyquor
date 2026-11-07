//! Generic RSS feed adapter, ported from `packages/adapters/src/rss.ts`.

use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::{decode_xml, extract_rss_image_url, extract_xml_tag};

#[derive(Debug, Clone, Default)]
pub struct RssAdapterOptions {
    pub max_items: Option<usize>,
}

pub struct RssAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
}

impl<F: Fetch> RssAdapter<F> {
    pub fn new(fetch: F, options: RssAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(10),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for RssAdapter<F> {
    fn name(&self) -> &str {
        "rss"
    }

    fn source_type(&self) -> &str {
        "feed"
    }

    fn fetch<'a>(
        &'a self,
        config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        Box::pin(async move {
            let feed_url = config_metadata
                .get("feedUrl")
                .and_then(Value::as_str)
                .filter(|url| !url.is_empty());
            let Some(feed_url) = feed_url else {
                return Ok(Vec::new());
            };

            let Ok(response) = self.fetch.fetch(feed_url, FetchInit::get()).await else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            let items = parse_rss_items(&response.body);
            Ok(items.into_iter().take(self.max_items).collect())
        })
    }
}

/// `parseRssItems` from `rss.ts`.
pub(crate) fn parse_rss_items(xml: &str) -> Vec<SourceItem> {
    let mut items = Vec::new();
    for item_xml in split_xml_blocks(xml, "item") {
        let title = decode_xml(&extract_xml_tag(&item_xml, "title"));
        let link = decode_xml(&or_non_empty(
            extract_xml_tag(&item_xml, "link"),
            extract_xml_tag(&item_xml, "guid"),
        ));
        let description = decode_xml(&or_non_empty(
            extract_xml_tag(&item_xml, "description"),
            extract_xml_tag(&item_xml, "content:encoded"),
        ));
        let published = decode_xml(&or_non_empty(
            extract_xml_tag(&item_xml, "pubDate"),
            extract_xml_tag(&item_xml, "dc:date"),
        ));
        let image_url = extract_rss_image_url(&item_xml);

        if title.is_empty() || link.is_empty() {
            continue;
        }

        let mut item = SourceItem::new(
            title.clone(),
            link,
            if description.is_empty() {
                title.clone()
            } else {
                description
            },
        );
        if !image_url.is_empty() {
            item.image_url = Some(image_url);
        }
        if !published.is_empty() {
            let mut metadata = Map::new();
            metadata.insert("published".to_string(), Value::String(published));
            item.metadata = metadata;
        }
        items.push(item);
    }
    items
}

fn or_non_empty(first: String, second: String) -> String {
    if first.is_empty() { second } else { first }
}

/// Split `<tag>…</tag>` blocks, mirroring `split(/<item>([\s\S]*?)<\/item>/)`
/// — non-greedy, so a nested same-tag element ends the block early, exactly
/// like the regex.
pub(crate) fn split_xml_blocks(xml: &str, tag: &str) -> Vec<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let mut blocks = Vec::new();
    let mut index = 0_usize;
    while let Some(open_at) = xml[index..].find(&open) {
        let absolute_open = index + open_at;
        let content_start = absolute_open + open.len();
        let Some(close_offset) = xml[content_start..].find(&close) else {
            break;
        };
        blocks.push(xml[content_start..content_start + close_offset].to_string());
        index = content_start + close_offset + close.len();
    }
    blocks
}
