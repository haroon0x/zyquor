//! Source adapter types, ported from `packages/adapters/src/types.ts`.

use std::fmt;
use std::future::Future;
use std::pin::Pin;

use serde_json::{Map, Value};

/// Config metadata passed to `fetch()`, mirroring `Record<string, unknown>`.
///
/// Callers pass an empty map when a source has no stored config.
pub type ConfigMetadata = Map<String, Value>;

/// One item harvested from a source.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SourceItem {
    pub title: String,
    pub url: String,
    pub content: String,
    pub image_url: Option<String>,
    pub metadata: ConfigMetadata,
}

impl SourceItem {
    pub fn new(
        title: impl Into<String>,
        url: impl Into<String>,
        content: impl Into<String>,
    ) -> Self {
        Self {
            title: title.into(),
            url: url.into(),
            content: content.into(),
            image_url: None,
            metadata: ConfigMetadata::new(),
        }
    }
}

/// Errors an adapter can report. Most TypeScript adapters never throw (they
/// catch failures and return `[]`); only the X feed and Goldfish adapters
/// propagate errors, which the aggregator records as source failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterError {
    pub message: String,
}

impl AdapterError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for AdapterError {}

pub type AdapterResult<T> = Result<T, AdapterError>;

/// Boxed future returned by [`SourceAdapter`] methods.
pub type AdapterFuture<'a, T> = Pin<Box<dyn Future<Output = AdapterResult<T>> + Send + 'a>>;

/// A source adapter, mirroring `SourceAdapter`.
pub trait SourceAdapter: Send + Sync {
    fn name(&self) -> &str;
    fn source_type(&self) -> &str;

    fn fetch<'a>(
        &'a self,
        config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>>;

    /// Optional enrichment pass; the default returns the item unchanged,
    /// matching the TypeScript `enrich?` optionality.
    fn enrich<'a>(&'a self, item: SourceItem) -> AdapterFuture<'a, SourceItem> {
        Box::pin(async move { Ok(item) })
    }
}

/// Result of crawling one page for markdown.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CrawlResult {
    pub markdown: String,
    pub metadata: Option<ConfigMetadata>,
}

/// A crawl service, mirroring `CrawlService`.
pub trait CrawlService: Send + Sync {
    fn crawl<'a>(&'a self, url: &'a str) -> AdapterFuture<'a, CrawlResult>;
}
