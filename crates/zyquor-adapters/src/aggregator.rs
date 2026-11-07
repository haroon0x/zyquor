//! Source aggregator, ported from `packages/adapters/src/aggregator.ts`.
//!
//! Runs the configured adapters, scores/filters their items, tracks per-source
//! health across calls, and ranks the results. The health map is module-level
//! mutable state, exactly like the TypeScript `sourceHealth` map.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use chrono::DateTime;
use serde_json::{Map, Value};

use crate::fetch::{Fetch, ReqwestFetch};
use crate::types::{ConfigMetadata, SourceAdapter, SourceItem};

#[derive(Debug, Clone)]
pub struct AggregatedItem {
    pub source_item: SourceItem,
    pub source: String,
    pub source_type: String,
    pub engagement_score: i64,
    pub topic_tags: Vec<String>,
    pub freshness: f64,
}

#[derive(Clone, Default)]
pub struct AggregatorOptions {
    pub crawl_service: Option<Arc<dyn crate::types::CrawlService>>,
    pub fetch: Option<Arc<dyn Fetch>>,
    pub health_cooldown_ms: Option<u64>,
    pub include_hacker_news: Option<bool>,
    pub include_reddit: Option<bool>,
    pub include_tech_crunch: Option<bool>,
    pub include_arxiv: Option<bool>,
    pub include_github: Option<bool>,
    pub include_product_hunt: Option<bool>,
    pub include_company_rss: Option<bool>,
    pub include_expanded_hacker_news: Option<bool>,
    pub include_hiring: Option<bool>,
    pub max_items: Option<usize>,
    pub now: Option<DateTime<chrono::Utc>>,
    pub reddit_min_score: Option<i64>,
    pub reddit_sort: Option<String>,
    pub reddit_subreddits: Option<Vec<String>>,
    pub require_topic_match: Option<bool>,
    pub sort_by: Option<String>,
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SourceHealthSnapshot {
    pub consecutive_failures: u64,
    pub last_error: Option<String>,
    pub last_failure_at: Option<String>,
    pub last_item_count: usize,
    pub last_success_at: Option<String>,
    pub name: String,
    pub skipped_until: Option<String>,
    pub success_count: u64,
}

const PREFERRED_TOPIC_KEYWORDS: &[&str] = &[
    "llm",
    "gpt",
    "openai",
    "anthropic",
    "google",
    "microsoft",
    "model",
    "benchmark",
    "weights",
    "release",
    "reasoning",
    "startup",
    "funding",
    "product",
    "api",
    "developer",
    "programming",
    "security",
    "privacy",
    "crypto",
    "web3",
    "saas",
    "cloud",
    "rust",
    "python",
    "science",
    "research",
    "paper",
    "arxiv",
    "climate",
    "energy",
    "battery",
    "biotech",
    "healthcare",
    "economy",
    "markets",
    "inflation",
    "rates",
    "policy",
    "regulation",
    "geopolitics",
    "defense",
    "semiconductor",
    "chips",
];

const DEFAULT_HEALTH_COOLDOWN_MS: u64 = 15 * 60 * 1000;

static SOURCE_HEALTH: OnceLock<Mutex<HashMap<String, SourceHealthSnapshot>>> = OnceLock::new();

fn source_health() -> &'static Mutex<HashMap<String, SourceHealthSnapshot>> {
    SOURCE_HEALTH.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn get_aggregated_source_health() -> Vec<SourceHealthSnapshot> {
    let mut health: Vec<SourceHealthSnapshot> = source_health()
        .lock()
        .map(|guard| guard.values().cloned().collect())
        .unwrap_or_default();
    health.sort_by(|a, b| a.name.cmp(&b.name));
    health
}

pub fn reset_aggregated_source_health() {
    if let Ok(mut guard) = source_health().lock() {
        guard.clear();
    }
}

fn topic_keyword_regex(keywords: &[&str]) -> Option<fancy_regex::Regex> {
    let stems: Vec<&str> = keywords
        .iter()
        .copied()
        .filter(|keyword| keyword.len() >= 3)
        .collect();
    if stems.is_empty() {
        return None;
    }
    fancy_regex::Regex::new(&format!(r"\b(?:{})\w*", stems.join("|"))).ok()
}

fn is_source_cooling_down(name: &str, now: DateTime<chrono::Utc>) -> bool {
    let Ok(health) = source_health().lock() else {
        return false;
    };
    let Some(snapshot) = health.get(name) else {
        return false;
    };
    let Some(skipped_until) = snapshot.skipped_until.as_deref() else {
        return false;
    };
    crate::dates::parse_datetime_millis(skipped_until)
        .map(|skipped| skipped > now.timestamp_millis())
        .unwrap_or(false)
}

fn health_snapshot(name: &str) -> SourceHealthSnapshot {
    source_health()
        .lock()
        .ok()
        .and_then(|guard| guard.get(name).cloned())
        .unwrap_or_else(|| SourceHealthSnapshot {
            name: name.to_string(),
            ..SourceHealthSnapshot::default()
        })
}

fn record_source_success(name: &str, item_count: usize, now: DateTime<chrono::Utc>) {
    let previous = health_snapshot(name);
    let mut snapshot = previous.clone();
    snapshot.consecutive_failures = 0;
    snapshot.last_error = None;
    snapshot.last_item_count = item_count;
    snapshot.last_success_at =
        Some(crate::dates::iso_from_unix_millis(now.timestamp_millis()).unwrap_or_default());
    snapshot.skipped_until = None;
    snapshot.success_count = previous.success_count + 1;
    if let Ok(mut guard) = source_health().lock() {
        guard.insert(name.to_string(), snapshot);
    }
}

fn record_source_failure(
    name: &str,
    error: &crate::types::AdapterError,
    now: DateTime<chrono::Utc>,
    cooldown_ms: u64,
) {
    let previous = health_snapshot(name);
    let consecutive_failures = previous.consecutive_failures + 1;
    let mut snapshot = previous;
    snapshot.consecutive_failures = consecutive_failures;
    snapshot.last_error = Some(error.message.clone());
    snapshot.last_failure_at =
        Some(crate::dates::iso_from_unix_millis(now.timestamp_millis()).unwrap_or_default());
    snapshot.last_item_count = 0;
    snapshot.skipped_until = if consecutive_failures >= 2 {
        Some(
            crate::dates::iso_from_unix_millis(now.timestamp_millis() + cooldown_ms as i64)
                .unwrap_or_default(),
        )
    } else {
        snapshot.skipped_until.clone()
    };
    if let Ok(mut guard) = source_health().lock() {
        guard.insert(name.to_string(), snapshot);
    }
}

fn topic_query(value: Option<&str>) -> String {
    let Some(value) = value else {
        return String::new();
    };
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    let ignored: std::collections::HashSet<&str> = [
        "about", "after", "before", "from", "have", "into", "just", "latest", "post", "that",
        "their", "then", "this", "tweet", "what", "when", "where", "which", "with", "write",
    ]
    .into_iter()
    .collect();
    let lowered = value.to_lowercase();
    let without_urls = crate::xml_util::replace_all(r"https?://\S+", &lowered, " ");
    without_urls
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '+' && c != '#' && c != '-' && c != '.')
        .filter(|word| word.len() >= 3 && !ignored.contains(word))
        .take(8)
        .collect::<Vec<_>>()
        .join(" ")
}

fn matches_topic(text: &str, query: &str) -> bool {
    let words: Vec<&str> = {
        let mut unique = Vec::new();
        for word in query.split_whitespace().filter(|word| !word.is_empty()) {
            if !unique.contains(&word) {
                unique.push(word);
            }
        }
        unique
    };
    let text_words: std::collections::HashSet<String> =
        match fancy_regex::Regex::new(r"[a-z0-9+#.-]+") {
            Ok(regex) => regex
                .find_iter(text)
                .filter_map(Result::ok)
                .map(|found| found.as_str().to_string())
                .collect(),
            Err(_) => std::collections::HashSet::new(),
        };
    let matches = words
        .iter()
        .filter(|word| text_words.contains(**word))
        .count();
    matches >= 2.min(words.len().div_ceil(2))
}

fn is_fresh_topic_item(item: &SourceItem, now: DateTime<chrono::Utc>) -> bool {
    let raw = item
        .metadata
        .get("published")
        .or_else(|| item.metadata.get("pubDate"));
    let Some(raw) = raw.and_then(Value::as_str) else {
        return false;
    };
    let Some(published_at) = crate::dates::parse_datetime_millis(raw) else {
        return false;
    };
    let age = now.timestamp_millis() - published_at;
    (-5 * 60 * 60 * 1000..=48 * 60 * 60 * 1000).contains(&age)
}

fn extract_topic_tags(text: &str) -> Vec<String> {
    let tag_groups: &[(&str, &[&str])] = &[
        ("ai", &["ai", "ml", "llm", "gpt", "neural"]),
        ("startups", &["startup", "funding", "vc"]),
        ("devtools", &["developer", "programming", "api"]),
        ("security", &["security", "hack", "vulnerability"]),
        ("cloud", &["cloud", "aws", "kubernetes"]),
        ("business", &["saas", "revenue", "growth"]),
        ("research", &["research", "paper", "arxiv"]),
        (
            "science",
            &[
                "science",
                "climate",
                "energy",
                "battery",
                "biotech",
                "healthcare",
            ],
        ),
        ("economy", &["economy", "markets", "inflation", "rates"]),
        (
            "policy",
            &["policy", "regulation", "geopolitics", "defense"],
        ),
    ];
    let mut tags = Vec::new();
    for (tag, keywords) in tag_groups {
        if let Some(regex) = topic_keyword_regex(keywords) {
            if regex.is_match(text).unwrap_or(false) {
                tags.push((*tag).to_string());
            }
        }
    }
    if tags.is_empty() {
        vec!["general".to_string()]
    } else {
        tags
    }
}

fn calculate_freshness(item: &SourceItem, now: DateTime<chrono::Utc>) -> f64 {
    let date_str = item
        .metadata
        .get("published")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or_else(|| {
            item.metadata
                .get("pubDate")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
        });
    if let Some(date_str) = date_str {
        if let Some(published_at) = crate::dates::parse_datetime_millis(date_str) {
            let age_hours = (now.timestamp_millis() - published_at) as f64 / 3_600_000.0;
            return (1.0 - age_hours / 72.0).max(0.0);
        }
    }
    0.5
}

fn estimate_engagement(
    item: &SourceItem,
    source: &str,
    tags: &[String],
    has_preferred_topic: bool,
) -> i64 {
    let mut score = 50.0_f64;
    score *= match source {
        "hackernews" => 1.5,
        "techcrunch" => 1.3,
        "arxiv" => 0.9,
        "reddit" => 1.2,
        "github" => 1.25,
        "producthunt" => 1.15,
        "company-rss" => 1.35,
        "hiring" => 1.1,
        _ => 1.0,
    };

    let high_eng_patterns = [
        r"(?i)how (i|we)",
        r"(?i)built|building",
        r"(?i)\d+x|\d+%",
        r"(?i)mistake|lesson",
        r"(?i)open.?source",
    ];
    for pattern in high_eng_patterns {
        if let Ok(regex) = fancy_regex::Regex::new(pattern) {
            if regex.is_match(&item.title).unwrap_or(false) {
                score += 10.0;
            }
        }
    }

    if source == "reddit" {
        let upvotes = metadata_num(item, "score");
        let comments = metadata_num(item, "numComments");
        score += (upvotes + 1.0).log10() * 5.0;
        score += (comments + 1.0).log10() * 3.0;
    }
    if source == "github" {
        let stars = metadata_num(item, "stars");
        score += (stars + 1.0).log10() * 4.0;
    }
    if source == "producthunt" {
        let votes = metadata_num(item, "votes");
        let comments = metadata_num(item, "comments");
        score += (votes + 1.0).log10() * 5.0;
        score += (comments + 1.0).log10() * 3.0;
    }

    if tags.iter().any(|tag| tag == "ai") {
        score += 15.0;
    }
    if tags.iter().any(|tag| tag == "startups") {
        score += 10.0;
    }
    if tags.iter().any(|tag| tag == "science") {
        score += 8.0;
    }
    if tags.iter().any(|tag| tag == "economy") {
        score += 8.0;
    }
    if tags.iter().any(|tag| tag == "policy") {
        score += 6.0;
    }
    if has_preferred_topic {
        score += 5.0;
    }

    score.round() as i64
}

fn metadata_num(item: &SourceItem, key: &str) -> f64 {
    item.metadata
        .get(key)
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
}

/// `inferTweetType` from `aggregator.ts`.
pub fn infer_tweet_type(item: &SourceItem) -> String {
    let title = item.title.to_lowercase();
    let matches = |pattern: &str| -> bool {
        fancy_regex::Regex::new(&format!("(?i){pattern}"))
            .map(|regex| regex.is_match(&title).unwrap_or(false))
            .unwrap_or(false)
    };
    if matches(r"how to|tutorial|guide") {
        return "guide".to_string();
    }
    if matches(r"mistake|wrong|lesson|learned") {
        return "guide".to_string();
    }
    if matches(r"opinion|think|believe|should") {
        return "opinion".to_string();
    }
    if matches(r"tool|app|product|launch") {
        return "useful_info".to_string();
    }
    let content = item.content.to_lowercase();
    let content_matches = |pattern: &str| -> bool {
        fancy_regex::Regex::new(&format!("(?i){pattern}"))
            .map(|regex| regex.is_match(&content).unwrap_or(false))
            .unwrap_or(false)
    };
    if content_matches(r"study|research|paper") {
        return "useful_info".to_string();
    }
    "feed_observation".to_string()
}

struct BuiltAdapter {
    adapter: Box<dyn SourceAdapter>,
    name: String,
}

fn build_adapters(
    options: &AggregatorOptions,
    fetch: &Arc<dyn Fetch>,
    query: &str,
    now: DateTime<chrono::Utc>,
) -> Vec<BuiltAdapter> {
    let mut adapters: Vec<BuiltAdapter> = Vec::new();
    let crawl_service = options.crawl_service.clone();
    let include_hacker_news = options.include_hacker_news.unwrap_or(true);

    if include_hacker_news {
        let adapter: Box<dyn SourceAdapter> = if query.is_empty() {
            Box::new(crate::hackernews::HackerNewsAdapter::new(
                fetch.clone(),
                crate::hackernews::HackerNewsAdapterOptions {
                    crawl_service: crawl_service.clone(),
                    feed: None,
                    max_items: Some(10),
                },
            ))
        } else {
            Box::new(crate::hackernews_search::HackerNewsSearchAdapter::new(
                fetch.clone(),
                crate::hackernews_search::HackerNewsSearchAdapterOptions {
                    crawl_service: crawl_service.clone(),
                    max_items: Some(12),
                    now: Some(now),
                    topic: query.to_string(),
                },
            ))
        };
        adapters.push(BuiltAdapter {
            adapter,
            // The TypeScript builder uses `name: "hackernews"` for both the
            // top-stories and search variants; the adapter's own `name()`
            // differs ("hackernews" vs "hackernews-search") but the builder
            // name is what labels items and picks the scoring multiplier.
            name: "hackernews".to_string(),
        });
    }

    if !query.is_empty() {
        adapters.insert(
            0,
            BuiltAdapter {
                adapter: Box::new(crate::gdelt::GdeltAdapter::new(
                    fetch.clone(),
                    crate::gdelt::GdeltAdapterOptions {
                        max_items: Some(20),
                        timeout_ms: None,
                        topic: query.to_string(),
                    },
                )),
                name: "gdelt".to_string(),
            },
        );
    }

    let include_expanded = options.include_expanded_hacker_news.unwrap_or(true);
    if include_expanded && query.is_empty() {
        for (feed, count) in [
            ("beststories", 8),
            ("newstories", 8),
            ("showstories", 6),
            ("askstories", 4),
        ] {
            adapters.push(BuiltAdapter {
                adapter: Box::new(crate::hackernews::HackerNewsAdapter::new(
                    fetch.clone(),
                    crate::hackernews::HackerNewsAdapterOptions {
                        crawl_service: crawl_service.clone(),
                        feed: Some(feed.to_string()),
                        max_items: Some(count),
                    },
                )),
                name: "hackernews".to_string(),
            });
        }
    }

    let include_reddit = options.include_reddit.unwrap_or(true);
    if include_reddit {
        let subreddits: Vec<String> = if let Some(subreddits) = options
            .reddit_subreddits
            .as_ref()
            .filter(|subreddits| !subreddits.is_empty())
        {
            subreddits.clone()
        } else {
            [
                "programming",
                "technology",
                "MachineLearning",
                "LocalLLaMA",
                "OpenAI",
            ]
            .iter()
            .map(|subreddit| (*subreddit).to_string())
            .collect()
        };
        for subreddit in subreddits {
            adapters.push(BuiltAdapter {
                adapter: Box::new(crate::reddit::RedditAdapter::new(
                    fetch.clone(),
                    crate::reddit::RedditAdapterOptions {
                        crawl_service: crawl_service.clone(),
                        max_items: Some(6),
                        min_comments: None,
                        min_score: Some(options.reddit_min_score.unwrap_or(10)),
                        subreddit: Some(subreddit),
                        sort_by: Some(
                            options
                                .reddit_sort
                                .clone()
                                .unwrap_or_else(|| "hot".to_string()),
                        ),
                    },
                )),
                name: "reddit".to_string(),
            });
        }
    }

    if options.include_tech_crunch.unwrap_or(true) && query.is_empty() {
        adapters.push(BuiltAdapter {
            adapter: Box::new(crate::techcrunch::TechCrunchAdapter::new(
                fetch.clone(),
                crate::techcrunch::TechCrunchAdapterOptions {
                    crawl_service: None,
                    max_items: Some(8),
                    sections: Some(vec!["ai".to_string(), "startups".to_string()]),
                },
            )),
            name: "techcrunch".to_string(),
        });
    }

    if options.include_arxiv.unwrap_or(true) {
        let adapter: Box<dyn SourceAdapter> = if !query.is_empty() {
            Box::new(crate::arxiv::ArxivAdapter::new(
                fetch.clone(),
                crate::arxiv::ArxivAdapterOptions {
                    max_items: Some(12),
                    search_query: Some(format!("all:\"{}\"", query.replace('"', ""))),
                    categories: None,
                },
            ))
        } else {
            Box::new(crate::arxiv::ArxivAdapter::new(
                fetch.clone(),
                crate::arxiv::ArxivAdapterOptions {
                    max_items: Some(8),
                    search_query: None,
                    categories: Some(
                        [
                            "cs.AI", "cs.LG", "cs.CL", "cs.CV", "cs.RO", "cs.CR", "cs.DB", "cs.SE",
                            "stat.ML", "econ.GN", "q-fin",
                        ]
                        .iter()
                        .map(|category| (*category).to_string())
                        .collect(),
                    ),
                },
            ))
        };
        adapters.push(BuiltAdapter {
            adapter,
            name: "arxiv".to_string(),
        });
    }

    if options.include_github.unwrap_or(true) {
        if !query.is_empty() {
            adapters.push(BuiltAdapter {
                adapter: Box::new(crate::github::GitHubTrendingAdapter::new(
                    fetch.clone(),
                    crate::github::GitHubTrendingAdapterOptions {
                        max_items: Some(12),
                        min_stars: Some(0),
                        pushed_after: None,
                        query: Some(query.to_string()),
                        topic: None,
                    },
                )),
                name: "github".to_string(),
            });
        } else {
            for topic in ["ai", "llm", "agents", "developer-tools"] {
                adapters.push(BuiltAdapter {
                    adapter: Box::new(crate::github::GitHubTrendingAdapter::new(
                        fetch.clone(),
                        crate::github::GitHubTrendingAdapterOptions {
                            max_items: Some(6),
                            min_stars: None,
                            pushed_after: None,
                            query: None,
                            topic: Some(topic.to_string()),
                        },
                    )),
                    name: "github".to_string(),
                });
            }
        }
    }

    if options.include_product_hunt.unwrap_or(true) && query.is_empty() {
        let adapter = crate::producthunt::ProductHuntAdapter::new(
            fetch.clone(),
            crate::producthunt::ProductHuntAdapterOptions {
                api_token: None,
                max_items: Some(10),
            },
            &|_| None,
        );
        adapters.push(BuiltAdapter {
            adapter: Box::new(adapter),
            name: "producthunt".to_string(),
        });
    }

    if options.include_company_rss.unwrap_or(true) && query.is_empty() {
        adapters.push(BuiltAdapter {
            adapter: Box::new(crate::company_rss::CompanyRssAdapter::new(
                fetch.clone(),
                crate::company_rss::CompanyRssAdapterOptions {
                    max_items: Some(12),
                    feeds: None,
                },
            )),
            name: "company-rss".to_string(),
        });
    }

    if options.include_hiring.unwrap_or(true) && query.is_empty() {
        adapters.push(BuiltAdapter {
            adapter: Box::new(crate::hiring::HiringAdapter::new(
                fetch.clone(),
                crate::hiring::HiringAdapterOptions { max_items: Some(8) },
            )),
            name: "hiring".to_string(),
        });
    }

    adapters
}

pub async fn aggregate_sources(options: &AggregatorOptions) -> Vec<AggregatedItem> {
    let fetch: Arc<dyn Fetch> = options
        .fetch
        .clone()
        .unwrap_or_else(|| Arc::new(ReqwestFetch::new()));

    let include_hacker_news = options.include_hacker_news.unwrap_or(true);
    let include_reddit = options.include_reddit.unwrap_or(true);
    let _ = include_hacker_news;
    let _ = include_reddit;

    let max_items = options.max_items.unwrap_or(20);
    let health_cooldown_ms = options
        .health_cooldown_ms
        .unwrap_or(DEFAULT_HEALTH_COOLDOWN_MS);
    let now = options.now.unwrap_or_else(chrono::Utc::now);
    let require_topic_match = options.require_topic_match.unwrap_or(false);
    let sort_by = options
        .sort_by
        .clone()
        .unwrap_or_else(|| "engagement".to_string());

    let query = topic_query(options.topic.as_deref());
    let built = build_adapters(options, &fetch, &query, now);

    let active: Vec<BuiltAdapter> = built
        .into_iter()
        .filter(|entry| !is_source_cooling_down(&entry.name, now))
        .collect();

    let futures: Vec<_> = active
        .iter()
        .map(|entry| {
            let config: ConfigMetadata = Map::new();
            async move {
                (
                    entry.adapter.fetch(&config).await,
                    entry.name.clone(),
                    entry.adapter.name().to_string(),
                    entry.adapter.source_type().to_string(),
                )
            }
        })
        .collect();
    let results = futures::future::join_all(futures).await;

    let mut aggregated: Vec<AggregatedItem> = Vec::new();
    let preferred_regex = topic_keyword_regex(PREFERRED_TOPIC_KEYWORDS);
    for (items_result, source_name, adapter_name, source_type) in results {
        match items_result {
            Err(error) => {
                record_source_failure(&adapter_name, &error, now, health_cooldown_ms);
                continue;
            }
            Ok(items) => {
                if items.is_empty() {
                    record_source_failure(
                        &adapter_name,
                        &crate::types::AdapterError::new("No items returned"),
                        now,
                        health_cooldown_ms,
                    );
                } else {
                    record_source_success(&adapter_name, items.len(), now);
                }

                for item in items {
                    let text = format!("{} {}", item.title, item.content).to_lowercase();
                    let has_preferred_topic = preferred_regex
                        .as_ref()
                        .map(|regex| regex.is_match(&text).unwrap_or(false))
                        .unwrap_or(false);

                    if !query.is_empty() && !is_fresh_topic_item(&item, now) {
                        continue;
                    }
                    if !query.is_empty() && !matches_topic(&text, &query) {
                        continue;
                    }
                    if require_topic_match && !has_preferred_topic {
                        continue;
                    }

                    let topic_tags = extract_topic_tags(&text);
                    aggregated.push(AggregatedItem {
                        engagement_score: estimate_engagement(
                            &item,
                            &source_name,
                            &topic_tags,
                            has_preferred_topic,
                        ),
                        freshness: calculate_freshness(&item, now),
                        source_item: item,
                        source: source_name.clone(),
                        source_type: source_type.clone(),
                        topic_tags,
                    });
                }
            }
        }
    }

    let use_freshness_sort = sort_by == "freshness" || !query.is_empty();
    aggregated.sort_by(|a, b| {
        if use_freshness_sort {
            b.freshness
                .partial_cmp(&a.freshness)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.engagement_score.cmp(&a.engagement_score))
        } else {
            b.engagement_score.cmp(&a.engagement_score)
        }
    });

    aggregated.truncate(max_items);
    aggregated
}

pub fn create_aggregated_news_adapter(options: AggregatorOptions) -> AggregatedNewsAdapter {
    AggregatedNewsAdapter { options }
}

pub struct AggregatedNewsAdapter {
    options: AggregatorOptions,
}

impl SourceAdapter for AggregatedNewsAdapter {
    fn name(&self) -> &str {
        "aggregated-news"
    }

    fn source_type(&self) -> &str {
        "news"
    }

    fn fetch<'a>(
        &'a self,
        config_metadata: &'a ConfigMetadata,
    ) -> crate::types::AdapterFuture<'a, Vec<SourceItem>> {
        let options = &self.options;
        Box::pin(async move {
            let topic = config_metadata
                .get("topic")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| options.topic.clone());
            let max_items = config_metadata
                .get("maxItems")
                .and_then(Value::as_u64)
                .map(|count| count as usize)
                .or(options.max_items);
            let reddit_min_score = config_metadata
                .get("redditMinScore")
                .and_then(Value::as_i64)
                .or(options.reddit_min_score);
            let reddit_sort = config_metadata
                .get("redditSort")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| options.reddit_sort.clone());
            let reddit_subreddits = match config_metadata.get("redditSubreddits") {
                Some(Value::Array(list)) => Some(
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>(),
                ),
                _ => options.reddit_subreddits.clone(),
            };
            let sort_by = config_metadata
                .get("sortBy")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| options.sort_by.clone());
            let require_topic_match = config_metadata
                .get("requireTopicMatch")
                .and_then(Value::as_bool)
                .or(options.require_topic_match);
            let bool_option = |key: &str, fallback: Option<bool>| -> Option<bool> {
                config_metadata
                    .get(key)
                    .and_then(Value::as_bool)
                    .or(fallback)
            };

            let merged = AggregatorOptions {
                crawl_service: options.crawl_service.clone(),
                fetch: options.fetch.clone(),
                health_cooldown_ms: options.health_cooldown_ms,
                include_hacker_news: bool_option("includeHackerNews", options.include_hacker_news),
                include_reddit: bool_option("includeReddit", options.include_reddit),
                include_tech_crunch: bool_option("includeTechCrunch", options.include_tech_crunch),
                include_arxiv: bool_option("includeArxiv", options.include_arxiv),
                include_github: bool_option("includeGitHub", options.include_github),
                include_product_hunt: bool_option(
                    "includeProductHunt",
                    options.include_product_hunt,
                ),
                include_company_rss: bool_option("includeCompanyRss", options.include_company_rss),
                include_expanded_hacker_news: bool_option(
                    "includeExpandedHackerNews",
                    options.include_expanded_hacker_news,
                ),
                include_hiring: bool_option("includeHiring", options.include_hiring),
                max_items,
                now: options.now,
                reddit_min_score,
                reddit_sort,
                reddit_subreddits,
                require_topic_match,
                sort_by,
                topic,
            };

            let aggregated = aggregate_sources(&merged).await;
            Ok(aggregated
                .into_iter()
                .map(|item| item.source_item)
                .collect())
        })
    }
}
