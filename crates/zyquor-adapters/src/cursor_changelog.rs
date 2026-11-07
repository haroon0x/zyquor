//! Cursor changelog adapter, ported from
//! `packages/adapters/src/cursor-changelog.ts`.

use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::{first_group, strip_tags};

const CHANGELOG_URL: &str = "https://cursor.com/changelog";

#[derive(Debug, Clone, Default)]
pub struct CursorChangelogAdapterOptions {
    pub max_items: Option<usize>,
}

pub struct CursorChangelogAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
}

impl<F: Fetch> CursorChangelogAdapter<F> {
    pub fn new(fetch: F, options: CursorChangelogAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(8),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for CursorChangelogAdapter<F> {
    fn name(&self) -> &str {
        "cursor-changelog"
    }

    fn source_type(&self) -> &str {
        "cursor-changelog"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;

        Box::pin(async move {
            let Ok(response) = fetch.fetch(CHANGELOG_URL, FetchInit::get()).await else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            Ok(parse_entries(&response.body)
                .into_iter()
                .take(max_items)
                .collect())
        })
    }
}

fn parse_entries(html: &str) -> Vec<SourceItem> {
    // `html.split(/<article[^>]*>/).slice(1)`
    let parts = crate::xml_util::split_pattern(r"<article[^>]*>", html);
    let parts: Vec<&str> = parts.iter().skip(1).map(String::as_str).collect();
    let mut items = Vec::new();
    for part in parts {
        let Some(published_raw) = first_group(r#"<time[^>]*dateTime="([^"]+)"[^>]*>"#, part) else {
            continue;
        };
        let title = clean_text(&strip_tags(
            &first_group(r"<h1[^>]*>([\s\S]*?)</h1>", part).unwrap_or_default(),
            " ",
        ));
        let Some(slug) = first_group(r#"href="/changelog/([a-z0-9-]+)""#, part) else {
            continue;
        };
        if published_raw.is_empty() || title.is_empty() || slug.is_empty() {
            continue;
        }
        let Some(published_millis) = crate::dates::parse_datetime_millis(&published_raw) else {
            continue;
        };
        let published = crate::dates::iso_from_unix_millis(published_millis).unwrap_or_default();

        let body = clean_text(&strip_tags(part, " "));
        let title_index = body.find(&title);
        let content = title_index
            .map(|index| body[index..].to_string())
            .filter(|content| !content.is_empty())
            .unwrap_or_else(|| body.clone());
        let content = if content.is_empty() {
            title.clone()
        } else {
            content
        };

        let mut metadata = Map::new();
        metadata.insert("published".to_string(), Value::String(published));
        metadata.insert(
            "source".to_string(),
            Value::String("cursor-changelog".to_string()),
        );

        items.push(SourceItem {
            title,
            url: format!("https://cursor.com/changelog/{slug}"),
            content,
            image_url: None,
            metadata,
        });
    }
    items
}

fn clean_text(value: &str) -> String {
    crate::xml_util::decode_xml(&crate::xml_util::clean_text_whitespace(value))
}
