//! TechCrunch multi-feed adapter, ported from
//! `packages/adapters/src/techcrunch.ts`.

use std::sync::Arc;

use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::rss::split_xml_blocks;
use crate::types::{AdapterFuture, ConfigMetadata, CrawlService, SourceAdapter, SourceItem};
use crate::xml_util::{decode_xml, extract_rss_image_url, extract_tag_trim, strip_cdata};

const TECH_CRUNCH_FEEDS: &[&str] = &["https://techcrunch.com/feed/"];
const TECH_CRUNCH_SECTIONS: &[&str] = &["ai", "startups"];

#[derive(Clone, Default)]
pub struct TechCrunchAdapterOptions {
    pub crawl_service: Option<Arc<dyn CrawlService>>,
    pub max_items: Option<usize>,
    pub sections: Option<Vec<String>>,
}

pub struct TechCrunchAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
    section_feeds: Vec<String>,
}

impl<F: Fetch> TechCrunchAdapter<F> {
    pub fn new(fetch: F, options: TechCrunchAdapterOptions) -> Self {
        let sections = options
            .sections
            .filter(|sections| !sections.is_empty())
            .unwrap_or_else(|| {
                TECH_CRUNCH_SECTIONS
                    .iter()
                    .map(|section| (*section).to_string())
                    .collect()
            });
        let mut feeds: Vec<String> = TECH_CRUNCH_FEEDS
            .iter()
            .map(|feed| (*feed).to_string())
            .collect();
        feeds.extend(
            sections
                .iter()
                .map(|section| format!("https://techcrunch.com/category/{section}/feed/")),
        );
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(10),
            section_feeds: feeds,
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for TechCrunchAdapter<F> {
    fn name(&self) -> &str {
        "techcrunch"
    }

    fn source_type(&self) -> &str {
        "news"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let feeds = &self.section_feeds;
        let max_items = self.max_items;

        Box::pin(async move {
            let mut all_items = Vec::new();
            for feed_url in feeds {
                let response = match fetch.fetch(feed_url, FetchInit::get()).await {
                    Ok(response) => response,
                    Err(_) => continue,
                };
                if !response.ok() {
                    continue;
                }
                all_items.extend(parse_rss_items(&response.body));
            }

            let mut seen: Vec<String> = Vec::new();
            let unique: Vec<SourceItem> = all_items
                .into_iter()
                .filter(|item| {
                    if seen.contains(&item.title) {
                        return false;
                    }
                    seen.push(item.title.clone());
                    true
                })
                .collect();
            Ok(unique.into_iter().take(max_items).collect())
        })
    }
}

/// `parseRssItems` from `techcrunch.ts` (differs slightly from `rss.ts`:
/// descriptions are CDATA-stripped, `pubDate` and `category` land in metadata
/// even when empty).
fn parse_rss_items(xml: &str) -> Vec<SourceItem> {
    let mut items = Vec::new();
    for item_xml in split_xml_blocks(xml, "item") {
        let title = decode_xml(&extract_tag_trim(&item_xml, "title"));
        let link = decode_xml(&extract_tag_trim(&item_xml, "link"));
        let description = decode_xml(&strip_cdata(&or_non_empty(
            extract_tag_trim(&item_xml, "description"),
            extract_tag_trim(&item_xml, "content:encoded"),
        )));
        let pub_date = extract_tag_trim(&item_xml, "pubDate");
        let category = decode_xml(&extract_tag_trim(&item_xml, "category"));
        let image_url = extract_rss_image_url(&item_xml);

        if title.is_empty() || link.is_empty() {
            continue;
        }

        let mut metadata = Map::new();
        metadata.insert("pubDate".to_string(), Value::String(pub_date));
        metadata.insert("category".to_string(), Value::String(category));

        let item = SourceItem {
            title: title.clone(),
            url: link,
            content: if description.is_empty() {
                title
            } else {
                description
            },
            image_url: if image_url.is_empty() {
                None
            } else {
                Some(image_url)
            },
            metadata,
        };
        items.push(item);
    }
    items
}

fn or_non_empty(first: String, second: String) -> String {
    if first.is_empty() { second } else { first }
}
