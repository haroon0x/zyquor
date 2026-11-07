//! Source adapters, ported from `packages/adapters`.
//!
//! Every adapter talks to the network through the [`fetch::Fetch`] seam, so
//! the crate's tests run without network access. `goldfish`, `goldfish_context`
//! and `aggregator` are the remaining modules; the HTTP adapters are complete.

pub mod a16z;
pub(crate) mod aggregator;
pub mod anthropic_release_notes;
pub mod arxiv;
pub mod company_rss;
pub mod crawl4ai;
pub mod cursor_changelog;
pub mod dates;
pub(crate) mod deepseek_updates;
pub(crate) mod fetch;
pub(crate) mod gdelt;
pub(crate) mod github;
pub mod goldfish;
pub mod goldfish_context;
pub(crate) mod hackernews;
pub(crate) mod hackernews_search;
pub(crate) mod hiring;
pub(crate) mod model_releases;
pub(crate) mod producthunt;
pub(crate) mod reddit;
pub(crate) mod rss;
pub(crate) mod techcrunch;
pub(crate) mod types;
pub(crate) mod x_feed;
pub(crate) mod xai_news;
pub(crate) mod xml_util;

pub use a16z::{A16zAdapter, A16zAdapterOptions};
pub use aggregator::{
    AggregatedItem, AggregatedNewsAdapter, AggregatorOptions, SourceHealthSnapshot,
    aggregate_sources, create_aggregated_news_adapter, get_aggregated_source_health,
    infer_tweet_type, reset_aggregated_source_health,
};
pub use anthropic_release_notes::{
    AnthropicReleaseNotesAdapter, AnthropicReleaseNotesAdapterOptions,
};
pub use arxiv::{ArxivAdapter, ArxivAdapterOptions};
pub use company_rss::{CompanyRssAdapter, CompanyRssAdapterOptions, DEFAULT_COMPANY_RSS_FEEDS};
pub use crawl4ai::{Crawl4AiOptions, Crawl4AiService};
pub use cursor_changelog::{CursorChangelogAdapter, CursorChangelogAdapterOptions};
pub use deepseek_updates::{DeepSeekUpdatesAdapter, DeepSeekUpdatesAdapterOptions};
pub use fetch::{Fetch, FetchInit, FetchResponse, ReqwestFetch};
pub use gdelt::{GdeltAdapter, GdeltAdapterOptions};
pub use github::{GitHubTrendingAdapter, GitHubTrendingAdapterOptions};
pub use goldfish::{
    GoldfishAdapter, GoldfishAdapterOptions, call_goldfish_tool, goldfish_mcp_command,
};
pub use goldfish_context::{
    GoldfishContextBundle, GoldfishContextInput, GoldfishContextMemory, GoldfishContextWiki,
    clear_goldfish_context_cache, derive_goldfish_terms, fetch_goldfish_reply_context,
    render_goldfish_memory,
};
pub use hackernews::{HackerNewsAdapter, HackerNewsAdapterOptions};
pub use hackernews_search::{HackerNewsSearchAdapter, HackerNewsSearchAdapterOptions};
pub use hiring::{HiringAdapter, HiringAdapterOptions};
pub use model_releases::{ModelReleasesAdapter, ModelReleasesAdapterOptions};
pub use producthunt::{ProductHuntAdapter, ProductHuntAdapterOptions};
pub use reddit::{RedditAdapter, RedditAdapterOptions};
pub use rss::{RssAdapter, RssAdapterOptions};
pub use techcrunch::{TechCrunchAdapter, TechCrunchAdapterOptions};
pub use types::{
    AdapterError, AdapterFuture, AdapterResult, ConfigMetadata, CrawlResult, CrawlService,
    SourceAdapter, SourceItem,
};
pub use x_feed::{XFeedAdapter, XFeedAdapterOptions, XFeedTweet};
pub use xai_news::{XaiNewsAdapter, XaiNewsAdapterOptions};
