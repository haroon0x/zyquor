//! Anthropic release-notes adapter, ported from
//! `packages/adapters/src/anthropic-release-notes.ts`.

use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::{first_group, replace_all, strip_tags};

const RELEASE_NOTES_URL: &str = "https://docs.anthropic.com/en/release-notes";

#[derive(Debug, Clone, Default)]
pub struct AnthropicReleaseNotesAdapterOptions {
    pub max_items: Option<usize>,
}

pub struct AnthropicReleaseNotesAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
}

impl<F: Fetch> AnthropicReleaseNotesAdapter<F> {
    pub fn new(fetch: F, options: AnthropicReleaseNotesAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(8),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for AnthropicReleaseNotesAdapter<F> {
    fn name(&self) -> &str {
        "anthropic-release-notes"
    }

    fn source_type(&self) -> &str {
        "anthropic-release-notes"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;

        Box::pin(async move {
            let Ok(response) = fetch.fetch(RELEASE_NOTES_URL, FetchInit::get()).await else {
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
    // `html.split(/<h2 class="font-heading text-primary">/).slice(1)`
    let parts: Vec<&str> = html
        .split(r#"<h2 class="font-heading text-primary">"#)
        .skip(1)
        .collect();
    let mut items = Vec::new();
    for part in parts {
        let Some(anchor) = first_group(r#"id="([^"]+)""#, part) else {
            continue;
        };
        let Some(published_raw) = first_group(r"([A-Z][a-z]+ \d{1,2}, \d{4})", part) else {
            continue;
        };
        let Some(published_millis) = crate::dates::parse_datetime_millis(&published_raw) else {
            continue;
        };
        if published_millis == 0 {
            continue;
        }
        let published = crate::dates::iso_from_unix_millis(published_millis).unwrap_or_default();

        let lines = clean_lines(part);
        let Some(title_idx) = lines.iter().position(|line| {
            !is_date_line(line) && line.len() <= 80 && line.chars().any(|c| c.is_ascii_alphabetic())
        }) else {
            continue;
        };
        let title = lines[title_idx].clone();
        // `[...new Set(lines.filter(...))].join(" ")` — dedupe, keep first.
        let mut seen: Vec<String> = Vec::new();
        let mut content_parts: Vec<String> = Vec::new();
        for line in lines
            .iter()
            .filter(|line| **line != title && line.len() >= 30)
        {
            if seen.contains(line) {
                continue;
            }
            seen.push(line.clone());
            content_parts.push(line.clone());
        }
        let content = content_parts.join(" ");
        let content = if content.is_empty() {
            title.clone()
        } else {
            content
        };

        let mut metadata = Map::new();
        metadata.insert("published".to_string(), Value::String(published));
        metadata.insert(
            "source".to_string(),
            Value::String("anthropic-release-notes".to_string()),
        );

        items.push(SourceItem {
            title,
            url: format!("{RELEASE_NOTES_URL}#{anchor}"),
            content,
            image_url: None,
            metadata,
        });
    }
    items
}

fn is_date_line(line: &str) -> bool {
    // `/^\d{1,2},\s*\d{4}$/`
    let digits: Vec<&str> = line.split(',').collect();
    if digits.len() != 2 {
        return false;
    }
    digits[0].trim().chars().all(|c| c.is_ascii_digit())
        && digits[0].trim().len() <= 2
        && digits[1].trim().chars().all(|c| c.is_ascii_digit())
        && digits[1].trim().len() == 4
}

fn clean_lines(html: &str) -> Vec<String> {
    strip_tags(html, "\n")
        .split('\n')
        .map(|line| replace_all(r"\s+", line, " ").trim().to_string())
        .filter(|line| !line.is_empty())
        .collect()
}
