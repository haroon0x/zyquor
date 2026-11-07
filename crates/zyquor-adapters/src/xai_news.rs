//! xAI news adapter, ported from `packages/adapters/src/xai-news.ts`.

use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::{first_group, replace_all, strip_tags};

const NEWS_URL: &str = "https://x.ai/news";

#[derive(Debug, Clone, Default)]
pub struct XaiNewsAdapterOptions {
    pub max_items: Option<usize>,
}

pub struct XaiNewsAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
}

impl<F: Fetch> XaiNewsAdapter<F> {
    pub fn new(fetch: F, options: XaiNewsAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(8),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for XaiNewsAdapter<F> {
    fn name(&self) -> &str {
        "xai-news"
    }

    fn source_type(&self) -> &str {
        "xai-news"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;

        Box::pin(async move {
            let Ok(response) = fetch.fetch(NEWS_URL, FetchInit::get()).await else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            Ok(parse_listing(&response.body)
                .into_iter()
                .take(max_items)
                .collect())
        })
    }

    fn enrich<'a>(&'a self, item: SourceItem) -> AdapterFuture<'a, SourceItem> {
        let fetch = &self.fetch;
        Box::pin(async move {
            let Ok(response) = fetch.fetch(&item.url, FetchInit::get()).await else {
                return Ok(item);
            };
            if !response.ok() {
                return Ok(item);
            }
            let body = extract_article_text(&response.body);
            if body.is_empty() {
                return Ok(item);
            }
            let mut item = item;
            item.content = body;
            Ok(item)
        })
    }
}

fn parse_listing(html: &str) -> Vec<SourceItem> {
    // `[...html.matchAll(/<a[^>]*href="(\/news\/[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/g)]`
    let cards = card_matches(html);
    let mut seen: Vec<String> = Vec::new();
    let mut items = Vec::new();
    for (slug, body) in cards {
        if slug.is_empty() || seen.contains(&slug) {
            continue;
        }
        seen.push(slug.clone());

        let title = clean_text(
            &first_group(r"<h[1-4][^>]*>([\s\S]*?)</h[1-4]>", &body).unwrap_or_default(),
        );
        let published = first_group(
            r"(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4}",
            &body,
        )
        .and_then(|value| parse_date(&value));
        let blurb = clean_text(&first_group(r"<p[^>]*>([\s\S]*?)</p>", &body).unwrap_or_default());
        if title.is_empty() || published.is_none() {
            continue;
        }

        let mut metadata = Map::new();
        metadata.insert(
            "published".to_string(),
            Value::String(published.unwrap_or_default()),
        );
        metadata.insert("source".to_string(), Value::String("xai-news".to_string()));

        // `content: blurb || title`
        let content = if blurb.is_empty() {
            title.clone()
        } else {
            blurb
        };
        items.push(SourceItem {
            title,
            url: format!("https://x.ai{slug}"),
            content,
            image_url: None,
            metadata,
        });
    }
    items
}

/// `matchAll` over the anchor pattern, returning `(slug, inner)` pairs.
fn card_matches(html: &str) -> Vec<(String, String)> {
    let Some(regex) =
        fancy_regex::Regex::new(r#"<a[^>]*href="(/news/[a-z0-9-]+)"[^>]*>([\s\S]*?)</a>"#).ok()
    else {
        return Vec::new();
    };
    regex
        .captures_iter(html)
        .filter_map(Result::ok)
        .map(|caps| {
            (
                caps.get(1)
                    .map(|value| value.as_str().to_string())
                    .unwrap_or_default(),
                caps.get(2)
                    .map(|value| value.as_str().to_string())
                    .unwrap_or_default(),
            )
        })
        .collect()
}

fn extract_article_text(html: &str) -> String {
    let Some(anchor) = html.find("post-title-navigator-anchor") else {
        return String::new();
    };
    let Some(start) = html[anchor..].find('>') else {
        return String::new();
    };
    let start = anchor + start + 1;
    let region = match html[start..].find("</main>") {
        Some(end) => &html[start..start + end],
        None => &html[start..],
    };
    clean_lines(region).join(" ").chars().take(3000).collect()
}

fn clean_lines(html: &str) -> Vec<String> {
    strip_tags(html, "\n")
        .split('\n')
        .map(|line| replace_all(r"\s+", line, " ").trim().to_string())
        .filter(|line| line.len() >= 60)
        .collect()
}

fn clean_text(value: &str) -> String {
    crate::xml_util::decode_xml_apos(&crate::xml_util::clean_text_whitespace(value))
}

fn parse_date(value: &str) -> Option<String> {
    let millis = crate::dates::parse_datetime_millis(value)?;
    crate::dates::iso_from_unix_millis(millis)
}
