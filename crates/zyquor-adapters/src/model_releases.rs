//! Model releases adapter (OpenRouter / Hugging Face / Simon Willison),
//! ported from `packages/adapters/src/model-releases.ts`.

use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::{decode_xml_apos, extract_attribute, extract_tag_trim, strip_html};

const MAX_SOURCE_AGE_MS: i64 = 48 * 60 * 60 * 1000;

#[derive(Debug, Clone, Default)]
pub struct ModelReleasesAdapterOptions {
    pub max_items: Option<usize>,
    pub now: Option<DateTime<Utc>>,
}

pub struct ModelReleasesAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
    now: DateTime<Utc>,
}

impl<F: Fetch> ModelReleasesAdapter<F> {
    pub fn new(fetch: F, options: ModelReleasesAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(20),
            now: options.now.unwrap_or_else(Utc::now),
        }
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for ModelReleasesAdapter<F> {
    fn name(&self) -> &str {
        "model-releases"
    }

    fn source_type(&self) -> &str {
        "model-releases"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;
        let now = self.now;

        Box::pin(async move {
            type ItemsFuture<'a> = std::pin::Pin<
                Box<
                    dyn std::future::Future<
                            Output = Result<Vec<SourceItem>, crate::types::AdapterError>,
                        > + Send
                        + 'a,
                >,
            >;
            let results = futures::future::join_all([
                Box::pin(fetch_openrouter_models(fetch)) as ItemsFuture<'_>,
                Box::pin(fetch_hugging_face_models(fetch, now)) as ItemsFuture<'_>,
                Box::pin(fetch_simon_willison(fetch)) as ItemsFuture<'_>,
            ])
            .await;

            let now_millis = now.timestamp_millis();
            let mut items: Vec<SourceItem> = results
                .into_iter()
                .filter_map(|result| result.ok())
                .flatten()
                .filter(|item| {
                    let Some(raw) = item.metadata.get("published").and_then(Value::as_str) else {
                        return false;
                    };
                    let Some(published_at) = crate::dates::parse_datetime_millis(raw) else {
                        return false;
                    };
                    let age = now_millis - published_at;
                    (-5 * 60 * 60 * 1000..=MAX_SOURCE_AGE_MS).contains(&age)
                })
                .collect();

            items.sort_by(|a, b| {
                let a_time = a
                    .metadata
                    .get("published")
                    .and_then(Value::as_str)
                    .and_then(crate::dates::parse_datetime_millis)
                    .unwrap_or(0);
                let b_time = b
                    .metadata
                    .get("published")
                    .and_then(Value::as_str)
                    .and_then(crate::dates::parse_datetime_millis)
                    .unwrap_or(0);
                b_time.cmp(&a_time)
            });

            Ok(items.into_iter().take(max_items).collect())
        })
    }
}

#[derive(Debug, Deserialize)]
struct OpenRouterModel {
    id: String,
    name: Option<String>,
    created: i64,
    context_length: Option<i64>,
    pricing: Option<OpenRouterPricing>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterPricing {
    prompt: Option<Value>,
    completion: Option<Value>,
}

fn pricing_to_f64(value: Option<&Value>) -> f64 {
    // TypeScript: `Number(pricing?.prompt ?? 0)` — strings or numbers.
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text.parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    }
}

#[derive(Debug, Deserialize)]
struct OpenRouterResponse {
    #[serde(default)]
    data: Vec<OpenRouterModel>,
}

async fn fetch_openrouter_models<F: Fetch + Send + Sync>(
    fetch: &F,
) -> Result<Vec<SourceItem>, crate::types::AdapterError> {
    let response = fetch
        .fetch("https://openrouter.ai/api/v1/models", FetchInit::get())
        .await?;
    if !response.ok() {
        return Ok(Vec::new());
    }
    let Ok(body) = serde_json::from_str::<OpenRouterResponse>(&response.body) else {
        return Ok(Vec::new());
    };
    let mut items = Vec::new();
    for model in body.data {
        let prompt_per_m = pricing_to_f64(
            model
                .pricing
                .as_ref()
                .and_then(|pricing| pricing.prompt.as_ref()),
        ) * 1_000_000.0;
        let completion_per_m = pricing_to_f64(
            model
                .pricing
                .as_ref()
                .and_then(|pricing| pricing.completion.as_ref()),
        ) * 1_000_000.0;
        let published = crate::dates::iso_from_unix_seconds(model.created).unwrap_or_default();
        let day = published.get(0..10).unwrap_or("").to_string();
        let content = format!(
            "Released on OpenRouter {day}. Model id: {}. Context length: {} tokens. Pricing: ${:.2} per 1M input tokens, ${:.2} per 1M output tokens.",
            model.id,
            model
                .context_length
                .map(|len| len.to_string())
                .unwrap_or_else(|| "unknown".to_string()),
            prompt_per_m,
            completion_per_m
        );

        let mut metadata = Map::new();
        metadata.insert("published".to_string(), Value::String(published));
        metadata.insert(
            "source".to_string(),
            Value::String("openrouter".to_string()),
        );

        items.push(SourceItem {
            title: model.name.unwrap_or_else(|| model.id.clone()),
            url: format!("https://openrouter.ai/{}", model.id),
            content,
            image_url: None,
            metadata,
        });
    }
    Ok(items)
}

#[derive(Debug, Deserialize)]
struct HuggingFaceModel {
    id: String,
    #[serde(rename = "createdAt")]
    created_at: String,
    #[serde(default)]
    downloads: i64,
    #[serde(default)]
    likes: i64,
    #[serde(default)]
    pipeline_tag: Option<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    private: bool,
    #[serde(default)]
    gated: bool,
}

async fn fetch_hugging_face_models<F: Fetch + Send + Sync>(
    fetch: &F,
    now: DateTime<Utc>,
) -> Result<Vec<SourceItem>, crate::types::AdapterError> {
    let Ok(mut url) = url::Url::parse("https://huggingface.co/api/models") else {
        return Ok(Vec::new());
    };
    url.query_pairs_mut()
        .append_pair("sort", "createdAt")
        .append_pair("direction", "-1")
        .append_pair("limit", "40");

    let response = fetch.fetch(url.as_str(), FetchInit::get()).await?;
    if !response.ok() {
        return Ok(Vec::new());
    }
    let Ok(models) = serde_json::from_str::<Vec<HuggingFaceModel>>(&response.body) else {
        return Ok(Vec::new());
    };

    let now_millis = now.timestamp_millis();
    let mut items = Vec::new();
    for model in models {
        if model.private || model.gated {
            continue;
        }
        if model.likes < 1 && model.downloads < 10 {
            continue;
        }
        let Some(created_millis) = crate::dates::parse_datetime_millis(&model.created_at) else {
            continue;
        };
        let age = now_millis - created_millis;
        if age > MAX_SOURCE_AGE_MS {
            break;
        }
        let facts = [
            format!(
                "Released on Hugging Face {}.",
                &model.created_at[..model.created_at.len().min(10)]
            ),
            format!("Model id: {}.", model.id),
            model
                .pipeline_tag
                .clone()
                .map(|tag| format!("Task: {tag}."))
                .unwrap_or_default(),
            format!("Downloads: {}. Likes: {}.", model.downloads, model.likes),
            format!(
                "Tags: {}.",
                model
                    .tags
                    .iter()
                    .take(12)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ]
        .into_iter()
        .filter(|fact| !fact.is_empty())
        .collect::<Vec<_>>()
        .join(" ");

        let mut metadata = Map::new();
        metadata.insert("published".to_string(), Value::String(model.created_at));
        metadata.insert(
            "source".to_string(),
            Value::String("huggingface".to_string()),
        );

        items.push(SourceItem {
            title: model.id.clone(),
            url: format!("https://huggingface.co/{}", model.id),
            content: facts,
            image_url: None,
            metadata,
        });
    }
    Ok(items)
}

async fn fetch_simon_willison<F: Fetch + Send + Sync>(
    fetch: &F,
) -> Result<Vec<SourceItem>, crate::types::AdapterError> {
    let response = fetch
        .fetch(
            "https://simonwillison.net/atom/everything/",
            FetchInit::get(),
        )
        .await?;
    if !response.ok() {
        return Ok(Vec::new());
    }
    let xml = response.body;
    let mut entries = Vec::new();
    for entry_xml in crate::rss::split_xml_blocks(&xml, "entry") {
        let title = decode_xml_apos(&extract_tag_trim(&entry_xml, "title"));
        let link = decode_xml_apos(&or_non_empty(
            extract_attribute(&entry_xml, "link", "href"),
            extract_tag_trim(&entry_xml, "link"),
        ));
        let content = decode_xml_apos(&strip_html(&or_non_empty(
            extract_tag_trim(&entry_xml, "content"),
            extract_tag_trim(&entry_xml, "summary"),
        )));
        let published = decode_xml_apos(&or_non_empty(
            extract_tag_trim(&entry_xml, "published"),
            extract_tag_trim(&entry_xml, "updated"),
        ));
        if title.is_empty() || link.is_empty() {
            continue;
        }
        let mut item = SourceItem::new(
            title.clone(),
            link,
            if content.is_empty() { title } else { content },
        );
        if !published.is_empty() {
            let mut metadata = Map::new();
            metadata.insert("published".to_string(), Value::String(published));
            metadata.insert(
                "source".to_string(),
                Value::String("simonwillison".to_string()),
            );
            item.metadata = metadata;
        }
        entries.push(item);
    }
    Ok(entries)
}

fn or_non_empty(first: String, second: String) -> String {
    if first.is_empty() { second } else { first }
}
