//! Product Hunt GraphQL adapter, ported from
//! `packages/adapters/src/producthunt.ts`.

use serde::Deserialize;
use serde_json::{Map, Value};

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterFuture, ConfigMetadata, SourceAdapter, SourceItem};
use zyquor_core::paths::EnvLookup;

const PRODUCT_HUNT_GRAPHQL_URL: &str = "https://api.producthunt.com/v2/api/graphql";

#[derive(Debug, Clone, Default)]
pub struct ProductHuntAdapterOptions {
    pub api_token: Option<String>,
    pub max_items: Option<usize>,
}

pub struct ProductHuntAdapter<F: Fetch> {
    fetch: F,
    api_token: Option<String>,
    max_items: usize,
}

impl<F: Fetch> ProductHuntAdapter<F> {
    /// The `ZYQUOR_PRODUCTHUNT_API_TOKEN` fallback is read from `env` at
    /// construction, matching the TypeScript `process.env` read in the factory.
    pub fn new(fetch: F, options: ProductHuntAdapterOptions, env: EnvLookup<'_>) -> Self {
        let api_token = options
            .api_token
            .clone()
            .filter(|token| !token.trim().is_empty())
            .or_else(|| {
                env("ZYQUOR_PRODUCTHUNT_API_TOKEN").filter(|token| !token.trim().is_empty())
            });
        Self {
            fetch,
            api_token,
            max_items: options.max_items.unwrap_or(10),
        }
    }
}

fn token_from_metadata(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|token| !token.trim().is_empty())
        .map(str::trim)
        .map(str::to_string)
}

fn number_from_metadata(value: Option<&Value>) -> Option<usize> {
    value.and_then(Value::as_u64).map(|count| count as usize)
}

#[derive(Debug, Deserialize, Default)]
struct ProductHuntResponse {
    #[serde(default)]
    data: ProductHuntData,
}

#[derive(Debug, Deserialize, Default)]
struct ProductHuntData {
    #[serde(default)]
    posts: ProductHuntPosts,
}

#[derive(Debug, Deserialize, Default)]
struct ProductHuntPosts {
    #[serde(default)]
    edges: Vec<ProductHuntEdge>,
}

#[derive(Debug, Deserialize)]
struct ProductHuntEdge {
    node: ProductHuntPost,
}

#[derive(Debug, Deserialize)]
struct ProductHuntPost {
    #[serde(rename = "commentsCount")]
    comments_count: i64,
    #[serde(rename = "createdAt")]
    created_at: String,
    description: Option<String>,
    id: String,
    name: String,
    tagline: String,
    topics: ProductHuntTopics,
    url: String,
    website: Option<String>,
    #[serde(rename = "votesCount")]
    votes_count: i64,
}

#[derive(Debug, Deserialize, Default)]
struct ProductHuntTopics {
    #[serde(default)]
    edges: Vec<ProductHuntTopicEdge>,
}

#[derive(Debug, Deserialize)]
struct ProductHuntTopicEdge {
    node: ProductHuntTopicNode,
}

#[derive(Debug, Deserialize)]
struct ProductHuntTopicNode {
    name: String,
}

fn product_hunt_post_to_source_item(post: ProductHuntPost) -> SourceItem {
    let topics: Vec<String> = post
        .topics
        .edges
        .into_iter()
        .map(|edge| edge.node.name)
        .collect();
    let description = post.description.unwrap_or_else(|| post.tagline.clone());
    let content = [
        description,
        format!("Votes: {}", post.votes_count),
        format!("Comments: {}", post.comments_count),
        if topics.is_empty() {
            String::new()
        } else {
            format!("Topics: {}", topics.join(", "))
        },
    ]
    .into_iter()
    .filter(|line| !line.is_empty())
    .collect::<Vec<_>>()
    .join("\n");

    let mut metadata = Map::new();
    metadata.insert("comments".to_string(), Value::from(post.comments_count));
    metadata.insert("id".to_string(), Value::String(post.id));
    metadata.insert("published".to_string(), Value::String(post.created_at));
    metadata.insert(
        "source".to_string(),
        Value::String("producthunt".to_string()),
    );
    metadata.insert(
        "topics".to_string(),
        Value::Array(topics.into_iter().map(Value::String).collect()),
    );
    metadata.insert("votes".to_string(), Value::from(post.votes_count));

    SourceItem {
        title: format!("{}: {}", post.name, post.tagline),
        url: post.website.unwrap_or(post.url),
        content,
        image_url: None,
        metadata,
    }
}

impl<F: Fetch + Send + Sync> SourceAdapter for ProductHuntAdapter<F> {
    fn name(&self) -> &str {
        "producthunt"
    }

    fn source_type(&self) -> &str {
        "feed"
    }

    fn fetch<'a>(
        &'a self,
        config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let fetch = &self.fetch;
        let api_token =
            token_from_metadata(config_metadata.get("apiToken")).or_else(|| self.api_token.clone());
        let max_items = self.max_items;
        let count = number_from_metadata(config_metadata.get("maxItems")).unwrap_or(max_items);

        Box::pin(async move {
            let Some(token) = api_token else {
                return Ok(Vec::new());
            };

            let body = serde_json::json!({
                "query": r#"query LatestPosts($first: Int!) {
  posts(first: $first, order: NEWEST) {
    edges {
      node {
        id
        name
        tagline
        description
        url
        website
        votesCount
        commentsCount
        createdAt
        topics { edges { node { name } } }
      }
    }
  }
}"#,
                "variables": { "first": count.clamp(1, 20) },
            });

            let init = FetchInit {
                method: "POST".to_string(),
                headers: vec![
                    ("authorization".to_string(), format!("Bearer {token}")),
                    ("content-type".to_string(), "application/json".to_string()),
                    ("user-agent".to_string(), "Zyquor/1.0".to_string()),
                ],
                body: serde_json::to_string(&body).ok(),
                timeout: None,
            };
            let Ok(response) = fetch.fetch(PRODUCT_HUNT_GRAPHQL_URL, init).await else {
                return Ok(Vec::new());
            };
            if !response.ok() {
                return Ok(Vec::new());
            }
            let Ok(body) = serde_json::from_str::<ProductHuntResponse>(&response.body) else {
                return Ok(Vec::new());
            };
            Ok(body
                .data
                .posts
                .edges
                .into_iter()
                .map(|edge| product_hunt_post_to_source_item(edge.node))
                .collect())
        })
    }
}
