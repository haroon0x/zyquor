//! DeepSeek updates adapter, ported from
//! `packages/adapters/src/deepseek-updates.ts`.

use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::strip_tags;

const UPDATES_URL: &str = "https://api-docs.deepseek.com/updates/";

#[derive(Debug, Clone, Default)]
pub struct DeepSeekUpdatesAdapterOptions {
    pub max_items: Option<usize>,
}

pub struct DeepSeekUpdatesAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
}

impl<F: Fetch> DeepSeekUpdatesAdapter<F> {
    pub fn new(fetch: F, options: DeepSeekUpdatesAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(5),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for DeepSeekUpdatesAdapter<F> {
    fn name(&self) -> &str {
        "deepseek-updates"
    }

    fn source_type(&self) -> &str {
        "deepseek-updates"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;

        Box::pin(async move {
            let Ok(response) = fetch.fetch(UPDATES_URL, FetchInit::get()).await else {
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
    // `html.split(/<h2[^>]*id="date-(\d{4}-\d{2}-\d{2})"[^>]*>/)` — the
    // capture group becomes its own element in the split result.
    let parts: Vec<&str> =
        split_keep_captures(html, r#"<h2[^>]*id="date-(\d{4}-\d{2}-\d{2})"[^>]*>"#);
    let mut items = Vec::new();
    let mut index = 1;
    while index < parts.len() {
        let date_part = parts[index];
        let body = parts.get(index + 1).copied().unwrap_or("");
        index += 2;

        if date_part.is_empty() || !is_date_shape(date_part) || body.trim().is_empty() {
            continue;
        }
        let Some((id, heading_text)) =
            first_match_id_text(body, r#"<h3[^>]*id="([^"]+)"[^>]*>([\s\S]*?)</h3>"#)
        else {
            continue;
        };
        let title = clean_text(&strip_tags(&heading_text, " "));
        if id.is_empty() || title.is_empty() {
            continue;
        }

        let content = clean_text(&strip_tags(body, " "));
        let content = if content.is_empty() {
            title.clone()
        } else {
            content
        };

        let mut metadata = Map::new();
        metadata.insert(
            "published".to_string(),
            Value::String(format!("{date_part}T12:00:00.000Z")),
        );
        metadata.insert(
            "source".to_string(),
            Value::String("deepseek-updates".to_string()),
        );

        items.push(SourceItem {
            title,
            url: format!("{UPDATES_URL}#{id}"),
            content,
            image_url: None,
            metadata,
        });
    }
    items
}

/// `split` with the capture group kept (String.split with a capturing
/// group's segments interleave with the pattern matches).
fn split_keep_captures<'a>(value: &'a str, pattern: &str) -> Vec<&'a str> {
    let Some(regex) = fancy_regex::Regex::new(pattern).ok() else {
        return vec![value];
    };
    let mut iterator = regex.captures_iter(value);
    let mut parts = Vec::new();
    let mut last = 0_usize;
    while let Some(Ok(caps)) = iterator.next() {
        let whole = caps.get(0);
        let Some(group) = caps.get(1) else {
            continue;
        };
        let Some(whole) = whole else {
            continue;
        };
        parts.push(&value[last..whole.start()]);
        parts.push(group.as_str());
        last = whole.end();
    }
    parts.push(&value[last..]);
    parts
}

fn is_date_shape(value: &str) -> bool {
    value.len() == 10
        && value.as_bytes().get(4) == Some(&b'-')
        && value.as_bytes().get(7) == Some(&b'-')
        && value.chars().filter(|c| c.is_ascii_digit()).count() == 8
}

fn first_match_id_text(value: &str, pattern: &str) -> Option<(String, String)> {
    let groups = crate::xml_util::capture_groups(pattern, value)?;
    let id = groups.first().cloned().unwrap_or_default();
    let text = groups.get(1).cloned().unwrap_or_default();
    if id.is_empty() || text.is_empty() {
        return None;
    }
    Some((id, text))
}

fn clean_text(value: &str) -> String {
    // `cleanText` from deepseek-updates.ts, in its native order: `&nbsp;` to
    // a space, smart quotes straightened, zero-width stripped, whitespace
    // collapsed and trimmed, and only then entities decoded.
    let mut normalized = value.replace("&nbsp;", " ");
    normalized = normalized
        .replace(['\u{2018}', '\u{2019}'], "'")
        .replace(['\u{201C}', '\u{201D}'], "\"")
        .replace(['\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}'], "");
    let collapsed = crate::xml_util::replace_all(r"\s+", &normalized, " ");
    crate::xml_util::decode_xml_apos(collapsed.trim())
}
