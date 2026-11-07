//! arXiv adapter, ported from `packages/adapters/src/arxiv.ts`.

use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::rss::split_xml_blocks;
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::{all_first_groups, extract_tag_trim, strip_html};

const ARXIV_API: &str = "https://export.arxiv.org/api/query";
const ARXIV_RSS_BASE: &str = "https://rss.arxiv.org/rss";

#[derive(Debug, Clone, Default)]
pub struct ArxivAdapterOptions {
    pub max_items: Option<usize>,
    pub search_query: Option<String>,
    pub categories: Option<Vec<String>>,
}

pub struct ArxivAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
    search_query: Option<String>,
    categories: Vec<String>,
}

impl<F: Fetch> ArxivAdapter<F> {
    pub fn new(fetch: F, options: ArxivAdapterOptions) -> Self {
        let categories = options
            .categories
            .filter(|categories| !categories.is_empty())
            .unwrap_or_else(|| {
                ["cs.AI", "cs.LG", "cs.CL"]
                    .iter()
                    .map(|category| (*category).to_string())
                    .collect()
            });
        let search_query = options.search_query.filter(|query| !query.is_empty());
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(10),
            search_query,
            categories,
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for ArxivAdapter<F> {
    fn name(&self) -> &str {
        "arxiv"
    }

    fn source_type(&self) -> &str {
        "feed"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;
        let search_query = self.search_query.clone();
        let categories = self.categories.clone();

        Box::pin(async move {
            let headers = vec![(
                "User-Agent".to_string(),
                "Zyquor/1.0 (local source monitor)".to_string(),
            )];

            if search_query.is_none() {
                return Ok(fetch_rss_fallback(fetch, &categories, max_items, headers).await);
            }
            let search_query = search_query.unwrap_or_default();

            let url = format!(
                "{ARXIV_API}?search_query={}&start=0&max_results={max_items}&sortBy=submittedDate&sortOrder=descending",
                crate::fetch::encode_uri_component(&search_query),
            );

            let response = fetch
                .fetch(
                    &url,
                    FetchInit {
                        method: "GET".to_string(),
                        headers: headers.clone(),
                        body: None,
                        timeout: None,
                    },
                )
                .await;
            let items = match response {
                Ok(response) if response.ok() => {
                    let items = parse_atom_feed(&response.body);
                    if items.is_empty() {
                        fetch_rss_fallback(fetch, &categories, max_items, headers).await
                    } else {
                        items
                    }
                }
                Ok(_) => fetch_rss_fallback(fetch, &categories, max_items, headers).await,
                Err(_) => fetch_rss_fallback(fetch, &categories, max_items, headers).await,
            };
            Ok(items)
        })
    }
}

async fn fetch_rss_fallback<F: Fetch + Send + Sync>(
    fetch: &F,
    categories: &[String],
    max_items: usize,
    headers: Vec<(String, String)>,
) -> Vec<SourceItem> {
    let mut items = Vec::new();
    for category in categories {
        let url = format!(
            "{ARXIV_RSS_BASE}/{}",
            crate::fetch::encode_uri_component(category)
        );
        let Ok(response) = fetch
            .fetch(
                &url,
                FetchInit {
                    method: "GET".to_string(),
                    headers: headers.clone(),
                    body: None,
                    timeout: None,
                },
            )
            .await
        else {
            continue;
        };
        if !response.ok() {
            continue;
        }
        items.extend(parse_rss_feed(&response.body));
        if items.len() >= max_items {
            break;
        }
    }
    items.into_iter().take(max_items).collect()
}

fn parse_atom_feed(xml: &str) -> Vec<SourceItem> {
    let mut items = Vec::new();
    for entry_xml in split_xml_blocks(xml, "entry") {
        let title = strip_html(&extract_tag_trim(&entry_xml, "title"));
        let summary = strip_html(&or_non_empty(
            extract_tag_trim(&entry_xml, "summary"),
            extract_tag_trim(&entry_xml, "content"),
        ));
        let published = or_non_empty(
            extract_tag_trim(&entry_xml, "published"),
            extract_tag_trim(&entry_xml, "updated"),
        );
        let link = extract_tag_trim(&entry_xml, "id");
        let category = extract_attribute_case_sensitive(&entry_xml, "category", "term");

        let author = crate::xml_util::first_group(r"(?s)<author>.*?<name>(.*?)</name>", &entry_xml)
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "Unknown".to_string());

        if title.is_empty() || link.is_empty() {
            continue;
        }

        let mut metadata = Map::new();
        metadata.insert("published".to_string(), Value::String(published));
        metadata.insert("author".to_string(), Value::String(author.clone()));
        metadata.insert("category".to_string(), Value::String(category.clone()));

        items.push(SourceItem {
            title,
            url: link,
            content: format!(
                "{}...\n\nAuthors: {author}\nCategory: {category}",
                summary.chars().take(500).collect::<String>()
            ),
            image_url: None,
            metadata,
        });
    }
    items
}

fn parse_rss_feed(xml: &str) -> Vec<SourceItem> {
    let mut items = Vec::new();
    for item_xml in split_xml_blocks(xml, "item") {
        let title = strip_html(&extract_tag_trim(&item_xml, "title"));
        let link = strip_html(&extract_tag_trim(&item_xml, "link"));
        let description = strip_html(&extract_tag_trim(&item_xml, "description"));
        let published = or_non_empty(
            extract_tag_trim(&item_xml, "dc:date"),
            extract_tag_trim(&item_xml, "pubDate"),
        );
        let category = all_first_groups(r"<category>([\s\S]*?)</category>", &item_xml)
            .iter()
            .map(|raw| strip_html(raw))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(", ");
        let authors = all_first_groups(r"<dc:creator>([\s\S]*?)</dc:creator>", &item_xml)
            .iter()
            .map(|raw| strip_html(raw))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join(", ");

        if title.is_empty() || link.is_empty() {
            continue;
        }

        let authors = if authors.is_empty() {
            "Unknown".to_string()
        } else {
            authors
        };
        let mut metadata = Map::new();
        metadata.insert("author".to_string(), Value::String(authors.clone()));
        metadata.insert("category".to_string(), Value::String(category.clone()));
        metadata.insert("published".to_string(), Value::String(published));
        metadata.insert("source".to_string(), Value::String("arxiv-rss".to_string()));

        items.push(SourceItem {
            title,
            url: link,
            content: format!(
                "{}...\n\nAuthors: {authors}\nCategory: {category}",
                description.chars().take(500).collect::<String>()
            ),
            image_url: None,
            metadata,
        });
    }
    items
}

fn or_non_empty(first: String, second: String) -> String {
    if first.is_empty() { second } else { first }
}

/// `extractTag` with an attribute from `arxiv.ts` (case-sensitive, no
/// required whitespace before the attribute name).
fn extract_attribute_case_sensitive(xml: &str, tag: &str, attribute: &str) -> String {
    crate::xml_util::first_group(
        &format!(r#"<{tag}[^>]*{attribute}=["']([^"']+)["'][^>]*>"#),
        xml,
    )
    .unwrap_or_default()
}
