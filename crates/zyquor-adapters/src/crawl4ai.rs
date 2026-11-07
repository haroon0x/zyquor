//! Crawl4AI crawl service, ported from `packages/adapters/src/crawl4ai.ts`.

use std::time::Duration;

use serde_json::Value;

use crate::fetch::{Fetch, FetchInit};
use crate::types::{AdapterError, AdapterFuture, CrawlResult, CrawlService};
use zyquor_core::paths::EnvLookup;

#[derive(Debug, Clone)]
pub struct Crawl4AiOptions {
    pub api_url: Option<String>,
    pub timeout_ms: Option<u64>,
}

impl Default for Crawl4AiOptions {
    fn default() -> Self {
        Self {
            api_url: None,
            timeout_ms: Some(30_000),
        }
    }
}

pub struct Crawl4AiService<F: Fetch> {
    fetch: F,
    api_url: String,
    timeout_ms: u64,
}

impl<F: Fetch> Crawl4AiService<F> {
    pub fn new(fetch: F, options: Crawl4AiOptions, env: EnvLookup<'_>) -> Self {
        let api_url = options
            .api_url
            .clone()
            .filter(|api_url| !api_url.is_empty())
            .or_else(|| env("CRAWL4AI_API_URL").filter(|api_url| !api_url.is_empty()))
            .unwrap_or_else(|| "http://127.0.0.1:11235/crawl".to_string());
        Self {
            fetch,
            api_url,
            timeout_ms: options.timeout_ms.unwrap_or(30_000),
        }
    }
}

impl<F: Fetch + Send + Sync> CrawlService for Crawl4AiService<F> {
    fn crawl<'a>(&'a self, url: &'a str) -> AdapterFuture<'a, CrawlResult> {
        let fetch = &self.fetch;
        let api_url = self.api_url.clone();
        let timeout_ms = self.timeout_ms;

        Box::pin(async move {
            let body = serde_json::json!({ "url": url });
            let init = FetchInit {
                method: "POST".to_string(),
                headers: vec![("Content-Type".to_string(), "application/json".to_string())],
                body: serde_json::to_string(&body).ok(),
                timeout: Some(Duration::from_millis(timeout_ms)),
            };
            let response = fetch
                .fetch(&api_url, init)
                .await
                .map_err(|error| AdapterError::new(error.message))?;

            if !response.ok() {
                return Err(AdapterError::new(format!(
                    "Crawl4AI returned {}",
                    response.status
                )));
            }

            let Ok(payload) = serde_json::from_str::<Value>(&response.body) else {
                return Err(AdapterError::new(
                    "Crawl4AI returned an invalid response".to_string(),
                ));
            };

            let markdown = ["markdown", "text", "content"]
                .iter()
                .find_map(|key| payload.get(*key).and_then(Value::as_str))
                .unwrap_or("")
                .trim()
                .to_string();

            let metadata = payload.get("metadata").and_then(Value::as_object).cloned();

            Ok(CrawlResult { markdown, metadata })
        })
    }
}
