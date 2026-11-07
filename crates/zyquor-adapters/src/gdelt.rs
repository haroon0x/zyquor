//! GDELT context (artlist) adapter, ported from
//! `packages/adapters/src/gdelt.ts`.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};

const GDELT_CONTEXT_API: &str = "https://api.gdeltproject.org/api/v2/context/context";

#[derive(Debug, Clone)]
pub struct GdeltAdapterOptions {
    pub max_items: Option<usize>,
    pub timeout_ms: Option<u64>,
    pub topic: String,
}

pub struct GdeltAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
    timeout_ms: u64,
    topic: String,
}

impl<F: Fetch> GdeltAdapter<F> {
    pub fn new(fetch: F, options: GdeltAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(20),
            timeout_ms: options.timeout_ms.unwrap_or(30_000),
            topic: options.topic,
        }
    }
}

#[derive(Debug, Deserialize, Default)]
struct GdeltArticle {
    context: Option<String>,
    domain: Option<String>,
    language: Option<String>,
    seendate: Option<String>,
    sentence: Option<String>,
    title: Option<String>,
    url: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
struct GdeltResponse {
    #[serde(default)]
    articles: Vec<GdeltArticle>,
}

/// `gdeltQuery` from `gdelt.ts`.
fn gdelt_query(topic: &str) -> String {
    let lowered = topic.to_lowercase();
    let words: Vec<&str> = lowered
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '-')
        .filter(|word| word.len() >= 3)
        .take(5)
        .collect();
    if words.is_empty() {
        return String::new();
    }
    if words.len() == 1 {
        words[0].to_string()
    } else {
        format!("near20:\"{}\"", words.join(" "))
    }
}

/// `gdeltTimestamp` from `gdelt.ts`.
fn gdelt_timestamp(value: Option<&str>) -> Option<String> {
    let value = value.unwrap_or("");
    // `^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$` → ISO string, or
    // `null` when the date is invalid.
    let digits: Vec<&str> = value.split('T').collect();
    if digits.len() != 2 {
        return None;
    }
    let date_part = digits[0];
    let time_part = &digits[1][..digits[1].len().saturating_sub(1)];
    if digits[1].len() != 7 || !digits[1].ends_with('Z') || date_part.len() != 8 {
        return None;
    }
    if !date_part.chars().all(|c| c.is_ascii_digit())
        || !time_part.chars().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let year = &date_part[0..4];
    let month = &date_part[4..6];
    let day = &date_part[6..8];
    let hour = &time_part[0..2];
    let minute = &time_part[2..4];
    let second = &time_part[4..6];
    let iso = format!("{year}-{month}-{day}T{hour}:{minute}:{second}Z");
    // `Date.parse`-equivalent validation: an impossible date yields no item.
    let parsed = chrono::DateTime::parse_from_rfc3339(&iso).ok()?;
    Some(parsed.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn article_to_source_item(article: &GdeltArticle) -> Option<SourceItem> {
    let title = article
        .title
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let url = article
        .url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())?;
    let published = gdelt_timestamp(article.seendate.as_deref())?;
    let content = article
        .context
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            article
                .sentence
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
        })
        .unwrap_or(title)
        .to_string();

    let mut metadata = Map::new();
    metadata.insert(
        "domain".to_string(),
        article
            .domain
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    metadata.insert("published".to_string(), Value::String(published));
    metadata.insert(
        "source".to_string(),
        Value::String("gdelt-context".to_string()),
    );

    Some(SourceItem {
        title: title.to_string(),
        url: url.to_string(),
        content,
        image_url: None,
        metadata,
    })
}

impl<F: Fetch + Send + Sync> SourceAdapter for GdeltAdapter<F> {
    fn name(&self) -> &str {
        "gdelt-context"
    }

    fn source_type(&self) -> &str {
        "news"
    }

    fn fetch<'a>(
        &'a self,
        _config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;
        let timeout_ms = self.timeout_ms;
        let query = gdelt_query(&self.topic);

        Box::pin(async move {
            if query.is_empty() {
                return Ok(Vec::new());
            }

            let url = {
                let Ok(mut url) = url::Url::parse(GDELT_CONTEXT_API) else {
                    return Ok(Vec::new());
                };
                url.query_pairs_mut()
                    .append_pair("query", &query)
                    .append_pair("mode", "artlist")
                    .append_pair("format", "json")
                    .append_pair("maxrecords", &max_items.clamp(1, 75).to_string())
                    .append_pair("timespan", "48h")
                    .append_pair("sort", "datedesc");
                url.to_string()
            };

            let attempt = || async {
                fetch
                    .fetch(
                        &url,
                        FetchInit {
                            method: "GET".to_string(),
                            headers: vec![("User-Agent".to_string(), "Zyquor/1.0".to_string())],
                            body: None,
                            timeout: Some(Duration::from_millis(timeout_ms)),
                        },
                    )
                    .await
            };

            // `catch { sleep 1000; retry }`, then `429 → sleep 6000; retry`.
            let first = attempt().await;
            let response = match first {
                Err(_) => {
                    tokio::time::sleep(Duration::from_millis(1_000)).await;
                    attempt().await
                }
                Ok(response) if response.status == 429 => {
                    tokio::time::sleep(Duration::from_millis(6_000)).await;
                    attempt().await
                }
                Ok(response) => Ok(response),
            };
            let Ok(response) = response else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            let Ok(body) = serde_json::from_str::<GdeltResponse>(&response.body) else {
                return Ok(Vec::new());
            };
            Ok(body
                .articles
                .iter()
                .filter(|article| {
                    // `!article.language || article.language.toLowerCase() === "english"` —
                    // empty strings are falsy in JS, so they pass the filter.
                    match article.language.as_deref() {
                        None | Some("") => true,
                        Some(language) => language.eq_ignore_ascii_case("english"),
                    }
                })
                .filter_map(article_to_source_item)
                .collect())
        })
    }
}
