//! GitHub trending repositories adapter, ported from
//! `packages/adapters/src/github.ts`.

use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use crate::xml_util::replace_all;

const GITHUB_SEARCH_REPOSITORIES: &str = "https://api.github.com/search/repositories";

#[derive(Debug, Clone, Default)]
pub struct GitHubTrendingAdapterOptions {
    pub max_items: Option<usize>,
    pub min_stars: Option<i64>,
    pub pushed_after: Option<String>,
    pub query: Option<String>,
    pub topic: Option<String>,
}

pub struct GitHubTrendingAdapter<F: Fetch> {
    fetch: F,
    max_items: usize,
    min_stars: i64,
    pushed_after: Option<String>,
    query: Option<String>,
    topic: Option<String>,
}

impl<F: Fetch> GitHubTrendingAdapter<F> {
    pub fn new(fetch: F, options: GitHubTrendingAdapterOptions) -> Self {
        Self {
            fetch,
            max_items: options.max_items.unwrap_or(10),
            min_stars: options.min_stars.unwrap_or(100),
            pushed_after: options.pushed_after,
            query: options.query,
            topic: options.topic,
        }
    }
}

#[derive(Debug, Deserialize)]
struct GitHubRepository {
    created_at: String,
    description: Option<String>,
    forks_count: i64,
    full_name: String,
    html_url: String,
    language: Option<String>,
    pushed_at: String,
    stargazers_count: i64,
    updated_at: String,
    #[serde(default)]
    topics: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Default)]
struct GitHubSearchResponse {
    #[serde(default)]
    items: Vec<GitHubRepository>,
}

fn string_from_metadata(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::trim)
        .map(str::to_string)
}

fn number_from_metadata(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64)
}

impl<F: Fetch + Send + Sync> SourceAdapter for GitHubTrendingAdapter<F> {
    fn name(&self) -> &str {
        "github-trending"
    }

    fn source_type(&self) -> &str {
        "feed"
    }

    fn fetch<'a>(
        &'a self,
        config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let max_items = self.max_items;
        let query = build_github_query(
            number_from_metadata(config_metadata.get("minStars")).unwrap_or(self.min_stars),
            string_from_metadata(config_metadata.get("pushedAfter"))
                .or_else(|| self.pushed_after.clone()),
            string_from_metadata(config_metadata.get("query")).or_else(|| self.query.clone()),
            string_from_metadata(config_metadata.get("topic")).or_else(|| self.topic.clone()),
        );
        let per_page = number_from_metadata(config_metadata.get("maxItems"))
            .map(|count| count.max(0) as usize)
            .unwrap_or(max_items);

        Box::pin(async move {
            let url = search_url(&query, per_page);

            let init = FetchInit {
                method: "GET".to_string(),
                headers: vec![
                    (
                        "accept".to_string(),
                        "application/vnd.github+json".to_string(),
                    ),
                    ("user-agent".to_string(), "Zyquor/1.0".to_string()),
                ],
                body: None,
                timeout: None,
            };
            let Ok(response) = fetch.fetch(&url, init).await else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            let Ok(body) = serde_json::from_str::<GitHubSearchResponse>(&response.body) else {
                return Ok(Vec::new());
            };
            Ok(body
                .items
                .into_iter()
                .take(per_page)
                .map(repository_to_source_item)
                .collect())
        })
    }

    fn enrich<'a>(&'a self, item: SourceItem) -> AdapterFuture<'a, SourceItem> {
        let fetch = &self.fetch;
        Box::pin(async move {
            let full_name = item
                .metadata
                .get("fullName")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .unwrap_or("")
                .to_string();
            if full_name.is_empty() {
                return Ok(item);
            }

            let init = FetchInit {
                method: "GET".to_string(),
                headers: vec![
                    (
                        "accept".to_string(),
                        "application/vnd.github.raw+json".to_string(),
                    ),
                    ("user-agent".to_string(), "Zyquor/1.0".to_string()),
                ],
                body: None,
                timeout: Some(Duration::from_millis(10_000)),
            };
            let Ok(response) = fetch
                .fetch(
                    &format!("https://api.github.com/repos/{full_name}/readme"),
                    init,
                )
                .await
            else {
                return Ok(item);
            };
            if !response.ok() {
                return Ok(item);
            }
            let raw = response.body;
            if raw.trim().is_empty() {
                return Ok(item);
            }
            let excerpt = clean_readme(&raw).chars().take(1200).collect::<String>();
            if excerpt.is_empty() {
                return Ok(item);
            }
            let content = format!("{}\n{}", item.content, excerpt);
            let mut enriched = item;
            enriched.content = content;
            Ok(enriched)
        })
    }
}

fn search_url(query: &str, per_page: usize) -> String {
    let Ok(mut url) = url::Url::parse(GITHUB_SEARCH_REPOSITORIES) else {
        return String::new();
    };
    url.query_pairs_mut()
        .append_pair("q", query)
        .append_pair("sort", "stars")
        .append_pair("order", "desc")
        .append_pair("per_page", &per_page.clamp(1, 30).to_string());
    url.to_string()
}

fn build_github_query(
    min_stars: i64,
    pushed_after: Option<String>,
    query: Option<String>,
    topic: Option<String>,
) -> String {
    let first = match query {
        Some(query) if !query.trim().is_empty() => query.trim().to_string(),
        _ => match topic {
            Some(topic) if !topic.is_empty() => format!("topic:{topic}"),
            _ => "topic:ai".to_string(),
        },
    };
    let mut terms = vec![first, format!("stars:>{min_stars}")];
    if let Some(pushed_after) = pushed_after.filter(|value| !value.is_empty()) {
        terms.push(format!("pushed:>{pushed_after}"));
    }
    terms.join(" ")
}

fn repository_to_source_item(repository: GitHubRepository) -> SourceItem {
    let topics = repository.topics.clone().unwrap_or_default();
    let topics_line = if topics.is_empty() {
        String::new()
    } else {
        format!(
            "Topics: {}",
            topics
                .iter()
                .take(8)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    let description = repository
        .description
        .clone()
        .unwrap_or_else(|| "No description provided.".to_string());
    let language = repository
        .language
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    let content = [
        description,
        format!("Language: {language}"),
        format!("Stars: {}", repository.stargazers_count),
        format!("Forks: {}", repository.forks_count),
        format!("Updated: {}", repository.updated_at),
        topics_line,
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n");

    let mut metadata = Map::new();
    metadata.insert("forks".to_string(), Value::from(repository.forks_count));
    metadata.insert(
        "fullName".to_string(),
        Value::String(repository.full_name.clone()),
    );
    metadata.insert(
        "language".to_string(),
        repository
            .language
            .clone()
            .map(Value::String)
            .unwrap_or(Value::Null),
    );
    metadata.insert(
        "published".to_string(),
        Value::String(repository.created_at.clone()),
    );
    metadata.insert(
        "pushedAt".to_string(),
        Value::String(repository.pushed_at.clone()),
    );
    metadata.insert("source".to_string(), Value::String("github".to_string()));
    metadata.insert(
        "stars".to_string(),
        Value::from(repository.stargazers_count),
    );
    metadata.insert(
        "topics".to_string(),
        Value::Array(topics.into_iter().map(Value::String).collect()),
    );
    metadata.insert(
        "updatedAt".to_string(),
        Value::String(repository.updated_at.clone()),
    );

    SourceItem {
        title: repository.full_name.clone(),
        url: repository.html_url.clone(),
        content,
        image_url: None,
        metadata,
    }
}

/// `cleanReadme` from `github.ts`: strip fenced code, images, tags, heading
/// markers, and link URLs; collapse whitespace.
pub(crate) fn clean_readme(raw: &str) -> String {
    let without_code = replace_all(r"```[\s\S]*?```", raw, " ");
    let without_images = replace_all(r"!\[[^\]]*\]\([^)]*\)", &without_code, " ");
    let without_tags = replace_all(r"<[^>]+>", &without_images, " ");
    let without_headings = replace_all(r"(?m)^\s{0,3}#{1,6}\s+", &without_tags, "");
    let links_unwrapped = replace_all(r"\[([^\]]*)\]\([^)]*\)", &without_headings, "$1");
    let collapsed = links_unwrapped
        .split('\n')
        .map(|line| replace_all(r"[ \t]+", line, " ").trim().to_string())
        .collect::<Vec<_>>()
        .join("\n");
    replace_all(r"\n{2,}", &collapsed, "\n").trim().to_string()
}
