//! The automatic ingest engine, ported from
//! `packages/automation/src/ingest.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use chrono::{DateTime, Timelike};
use serde_json::Value;
use zyquor_adapters::{ConfigMetadata, SourceAdapter, SourceItem};
use zyquor_core::types::PostJobStatus;
use zyquor_generation::providers::DraftGenerationProvider;
use zyquor_storage::{IngestConfig, SqliteRepository};

use crate::AutomationDeps;
use crate::draft::{PacketDraftOptions, draft_from_source_packet};
use crate::packet::{
    has_enough_source_context, packet_fields_from_feed_digest, packet_fields_from_item,
};
use crate::performance::{SourcePerformance, source_performance_by_type};
use crate::quality::is_low_signal_source_title;
use crate::routing::{RecentPostType, RoutingContext, route_tweet_type};
use crate::topic::has_topic_overlap;

#[derive(Debug, Clone, Default)]
pub struct IngestError {
    pub config_id: String,
    pub error: String,
}

#[derive(Debug, Clone, Default)]
pub struct IngestProgress {
    pub errors: Vec<IngestError>,
    pub processed: usize,
}

#[derive(Debug, Clone, Default)]
pub struct IngestRunResult {
    pub config_id: String,
    pub draft_id: String,
    pub job_id: Option<String>,
    pub packet_id: String,
    pub source_type: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct IngestSkipped {
    pub blocked_url: usize,
    pub duplicate_packet: usize,
    pub duplicate_posted_url: usize,
    pub host_cap: usize,
    pub off_topic: usize,
    pub packet_cap: usize,
    pub schedule_window: usize,
    pub thin_context: usize,
    pub topic_overlap: usize,
    pub low_signal: usize,
}

impl IngestSkipped {
    fn new() -> Self {
        Self::default()
    }
}

#[derive(Debug, Clone, Default)]
pub struct IngestResult {
    pub errors: Vec<IngestError>,
    pub processed: usize,
    pub results: Vec<IngestRunResult>,
    pub skipped: IngestSkipped,
}

pub struct RunAutomaticIngestOptions<'a> {
    pub adapters: HashMap<String, Arc<dyn SourceAdapter>>,
    pub generation_provider: Arc<dyn DraftGenerationProvider>,
    pub repository: &'a SqliteRepository,
    pub deps: &'a AutomationDeps,
    pub now: DateTime<chrono::Utc>,
    pub auto_approve: bool,
    pub on_progress: Option<Arc<dyn Fn(IngestProgress) + Send + Sync>>,
    pub should_continue: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

const CORE_AI_TERMS: &[&str] = &[
    "ai",
    "a.i.",
    "artificial intelligence",
    "agi",
    "llm",
    "llms",
    "language model",
    "foundation model",
    "frontier model",
    "gpt",
    "chatgpt",
    "claude",
    "gemini",
    "llama",
    "mistral",
    "qwen",
    "deepseek",
    "grok",
    "openai",
    "anthropic",
    "huggingface",
    "hugging face",
    "ollama",
    "vllm",
    "agent",
    "agents",
    "agentic",
    "copilot",
    "cursor",
    "codex",
    "devin",
    "fine-tune",
    "fine-tuning",
    "finetune",
    "finetuning",
    "lora",
    "quantization",
    "quantized",
    "inference",
    "prompt",
    "prompting",
    "rag",
    "retrieval augmented",
    "embedding",
    "embeddings",
    "transformer",
    "attention",
    "context window",
    "token",
    "tokens",
    "tokenizer",
    "mcp",
    "model context protocol",
    "tool use",
    "function calling",
    "benchmark",
    "eval",
    "evals",
    "hallucination",
    "alignment",
    "rlhf",
    "diffusion",
    "multimodal",
    "vision model",
    "reasoning model",
    "chain of thought",
    "vector database",
    "sandbox",
    "harness",
    "vibe coding",
    "code generation",
    "machine learning",
    "deep learning",
    "neural network",
    "training run",
    "pretraining",
];

const SUPPORTING_TERMS: &[&str] = &[
    "developer",
    "programming",
    "software",
    "open source",
    "framework",
    "sdk",
    "api",
    "startup",
    "funding",
    "launch",
    "release",
    "product",
    "shipped",
    "github",
    "repo",
    "library",
    "cli",
    "terminal",
    "ide",
    "editor",
    "database",
    "infrastructure",
    "latency",
    "throughput",
    "gpu",
    "nvidia",
    "compute",
];

const OFF_TOPIC_TERMS: &[&str] = &[
    "nuclear",
    "reactor",
    "barge",
    "climate",
    "carbon",
    "emissions",
    "solar farm",
    "wind farm",
    "crypto",
    "bitcoin",
    "ethereum",
    "blockchain",
    "web3",
    "nft",
    "token sale",
    "gdp",
    "inflation",
    "interest rate",
    "federal reserve",
    "central bank",
    "jobs report",
    "unemployment",
    "stocks",
    "bonds",
    "yield",
    "tariff",
    "vaccine",
    "drug trial",
    "clinical trial",
    "biotech",
    "pharma",
    "rocket",
    "spacex",
    "satellite",
    "asteroid",
    "election",
    "senate",
    "congress",
    "parliament",
    "lawsuit filed",
    "dating app",
    "sports",
    "football",
    "basketball",
    "olympics",
];

const BLOCKED_SOURCE_HOSTS: &[&str] = &[
    "book.stripe.com",
    "buy.stripe.com",
    "checkout.stripe.com",
    "pay.stripe.com",
    "gumroad.com",
];
const MAX_SOURCE_AGE_MS: i64 = 48 * 60 * 60 * 1000;

fn term_pattern(term: &str) -> Option<fancy_regex::Regex> {
    let escaped = escape_regex_literal(term);
    fancy_regex::Regex::new(&format!(r"(?i)(^|[^a-z0-9]){escaped}([^a-z0-9]|$)")).ok()
}

fn escape_regex_literal(value: &str) -> String {
    value
        .chars()
        .flat_map(|c| {
            if ".*+?^${}()|[]\\".contains(c) {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect()
}

fn term_patterns(terms: &[&str]) -> Vec<fancy_regex::Regex> {
    terms.iter().filter_map(|term| term_pattern(term)).collect()
}

/// Whether an item is on-topic (the AI-core gate from ingest.ts).
pub fn is_on_topic_source_item(item: &SourceItem) -> bool {
    let text = format!("{} {}", item.title, item.content);
    let core_patterns = term_patterns(CORE_AI_TERMS);
    let has_core = core_patterns
        .iter()
        .any(|pattern| pattern.is_match(&text).unwrap_or(false));
    if !has_core {
        let off_patterns = term_patterns(OFF_TOPIC_TERMS);
        if off_patterns
            .iter()
            .any(|pattern| pattern.is_match(&text).unwrap_or(false))
        {
            return false;
        }
    }
    has_core
}

pub(crate) fn is_provider_failure(message: &str) -> bool {
    const PATTERNS: &[&str] = &[
        r"(?i)insufficient credits",
        r"(?i)per-day",
        r"(?i)daily limit",
        r"(?i)quota exceeded",
        r"(?i)\b(401|403)\b",
        r"(?i)unauthorized",
        r"(?i)invalid api key",
        r"(?i)was not found at",
        r"(?i)failed to start",
        r"(?i)is not confirmed free",
        r"(?i)ECONNREFUSED",
    ];
    PATTERNS.iter().any(|pattern| {
        fancy_regex::Regex::new(pattern)
            .map(|regex| regex.is_match(message).unwrap_or(false))
            .unwrap_or(false)
    })
}

pub(crate) fn daily_packet_target(today: &str, deps: &AutomationDeps) -> usize {
    deps.daily_packet_target(today)
}

pub(crate) fn is_within_schedule_window(
    start: &str,
    end: &str,
    now: DateTime<chrono::Utc>,
) -> bool {
    let current = now.hour() * 60 + now.minute();
    let start_total = parse_hhmm(start);
    let end_total = parse_hhmm(end);
    let (Some(start_total), Some(end_total)) = (start_total, end_total) else {
        return false;
    };
    if start_total <= end_total {
        current >= start_total && current < end_total
    } else {
        current >= start_total || current < end_total
    }
}

fn parse_hhmm(value: &str) -> Option<u32> {
    let parts: Vec<&str> = value.split(':').collect();
    if parts.len() != 2 {
        return None;
    }
    let hours = parts[0].parse::<u32>().ok()?;
    let minutes = parts[1].parse::<u32>().ok()?;
    Some(hours * 60 + minutes)
}

fn same_host_post_cap(host: &str, deps: &AutomationDeps) -> i64 {
    deps.same_host_post_cap(host)
}

fn source_relevance_score(item: &SourceItem) -> usize {
    let text = format!("{} {}", item.title, item.content);
    let core_patterns = CORE_AI_TERMS
        .iter()
        .filter_map(|term| term_pattern(term))
        .collect::<Vec<_>>();
    let supporting_patterns = SUPPORTING_TERMS
        .iter()
        .filter_map(|term| term_pattern(term))
        .collect::<Vec<_>>();
    let core = core_patterns
        .iter()
        .filter(|pattern| pattern.is_match(&text).unwrap_or(false))
        .count();
    let supporting = supporting_patterns
        .iter()
        .filter(|pattern| pattern.is_match(&text).unwrap_or(false))
        .count();
    core * 3 + supporting
}

fn source_host(url: Option<&str>) -> Option<String> {
    let url = url?;
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.trim_start_matches("www.").to_lowercase();
    if host.is_empty() { None } else { Some(host) }
}

fn is_allowed_source_url(url: Option<&str>) -> bool {
    let Some(url) = url else {
        return true;
    };
    let Some(host) = source_host(Some(url)) else {
        return true;
    };
    if BLOCKED_SOURCE_HOSTS.contains(&host.as_str()) {
        return false;
    }
    if host.ends_with(".stripe.com")
        && fancy_regex::Regex::new(r"(?i)/(buy|checkout|pay|payment|link|invoice)\b")
            .map(|regex| regex.is_match(url).unwrap_or(false))
            .unwrap_or(false)
    {
        return false;
    }
    true
}

fn item_source_key(item: &SourceItem) -> String {
    if let Some(source) = item.metadata.get("source").and_then(Value::as_str) {
        if !source.is_empty() {
            return source.to_string();
        }
    }
    source_host(Some(&item.url))
        .map(|host| host.trim_start_matches("www.").to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn is_fresh_source_item(item: &SourceItem, now: DateTime<chrono::Utc>) -> bool {
    let raw = item
        .metadata
        .get("published")
        .or_else(|| item.metadata.get("pubDate"));
    let Some(raw) = raw.and_then(Value::as_str) else {
        return false;
    };
    if raw.trim().is_empty() {
        return false;
    }
    let Some(published_at) = crate::dates::parse_millis(raw) else {
        return false;
    };
    let age = now.timestamp_millis() - published_at;
    (-5 * 60 * 60 * 1000..=MAX_SOURCE_AGE_MS).contains(&age)
}

fn prioritize_source_items(items: Vec<SourceItem>) -> Vec<SourceItem> {
    let mut scored: Vec<(usize, SourceItem)> = items
        .into_iter()
        .map(|item| (source_relevance_score(&item), item))
        .collect();
    // Stable descending sort by score, matching JS `.sort((a,b) => b - a)`.
    scored.sort_by_key(|(score, _)| std::cmp::Reverse(*score));

    let mut groups: indexmap::IndexMap<String, Vec<SourceItem>> = indexmap::IndexMap::new();
    for (score, item) in scored {
        let _ = score;
        let key = item_source_key(&item);
        groups.entry(key).or_default().push(item);
    }

    let mut prioritized = Vec::new();
    while !groups.is_empty() {
        let mut emptied = Vec::new();
        for (key, group) in groups.iter_mut() {
            if group.is_empty() {
                emptied.push(key.clone());
                continue;
            }
            prioritized.push(group.remove(0));
            if group.is_empty() {
                emptied.push(key.clone());
            }
        }
        for key in emptied {
            groups.shift_remove(&key);
        }
    }
    prioritized
}

fn performance_key(config: &IngestConfig, performance: &HashMap<String, SourcePerformance>) -> f64 {
    match performance.get(&config.source_type) {
        Some(perf) if perf.posts >= 1 => perf.engagement_per_post,
        _ => 0.25,
    }
}

const DEAD_SOURCE_ENGAGEMENT_FLOOR: f64 = 0.5;
const DEAD_SOURCE_CAP_RATIO: f64 = 0.25;

fn performance_adjusted_target(
    base_target: usize,
    source_performance: Option<&SourcePerformance>,
    deps: &AutomationDeps,
) -> (usize, String) {
    let Some(perf) = source_performance else {
        return (base_target, "no-performance-data".to_string());
    };
    if perf.posts < 1 {
        return (base_target, "no-performance-data".to_string());
    }
    if (perf.posts as i64) < deps.dead_source_min_sample {
        return (
            base_target,
            format!("insufficient-sample posts={}", perf.posts),
        );
    }
    if perf.engagement_per_post < DEAD_SOURCE_ENGAGEMENT_FLOOR {
        let reduced = ((base_target as f64) * DEAD_SOURCE_CAP_RATIO).floor() as usize;
        return (
            reduced.max(1),
            format!(
                "dead-source engagementPerPost={:.2}",
                perf.engagement_per_post
            ),
        );
    }
    (
        base_target,
        format!("engagementPerPost={:.2}", perf.engagement_per_post),
    )
}

pub async fn run_automatic_ingest(
    options: &RunAutomaticIngestOptions<'_>,
) -> Result<IngestResult, crate::AutomationError> {
    let repository = options.repository;
    let deps = options.deps;
    let now = options.now;

    let configs = repository.list_ingest_configs(None)?;
    let history = repository.list_post_history()?;
    let performance_by_type = source_performance_by_type(repository)?;

    let mut enabled: Vec<IngestConfig> = configs
        .into_iter()
        .filter(|config| config.enabled)
        .collect();
    enabled.sort_by(|left, right| {
        performance_key(right, &performance_by_type)
            .partial_cmp(&performance_key(left, &performance_by_type))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut errors: Vec<IngestError> = Vec::new();
    let mut results: Vec<IngestRunResult> = Vec::new();
    let mut skipped = IngestSkipped::new();
    let today = now.format("%Y-%m-%d").to_string();

    let posted_source_urls: HashSet<String> = history
        .iter()
        .filter_map(|item| item.source_url.clone())
        .filter(|url| !url.is_empty())
        .collect();

    let mut posted_host_counts: HashMap<String, usize> = HashMap::new();
    let mut posted_titles_by_host: HashMap<String, Vec<String>> = HashMap::new();
    for item in history
        .iter()
        .filter(|item| item.posted_at.starts_with(&today))
    {
        let Some(host) = source_host(item.source_url.as_deref()) else {
            continue;
        };
        *posted_host_counts.entry(host.clone()).or_default() += 1;
        posted_titles_by_host.entry(host).or_default().push(
            item.source_title
                .clone()
                .unwrap_or_else(|| item.posted_text.clone()),
        );
    }

    let mut seen_urls_this_run: HashSet<String> = HashSet::new();
    let mut seen_hosts_this_run: HashMap<String, usize> = HashMap::new();
    let mut provider_failed = false;

    let all_jobs = repository.list_jobs(None, Some(&[PostJobStatus::Approved]), None)?;
    let mut carried_over_by_account: HashMap<String, usize> = HashMap::new();
    for job in all_jobs {
        if job.mode != zyquor_core::types::PostingMode::Autopost
            || !job.created_at.starts_with(&today)
        {
            continue;
        }
        *carried_over_by_account
            .entry(job.account_id.clone())
            .or_default() += 1;
    }

    let recent_posts: Vec<RecentPostType> = history
        .iter()
        .map(|item| RecentPostType {
            account_id: item.account_id.clone(),
            post_url: item.post_url.clone(),
            posted_at: item.posted_at.clone(),
            posted_text: Some(item.posted_text.clone()),
            tweet_type: item.tweet_type.clone(),
        })
        .collect();

    for config in &enabled {
        if options.should_continue.as_ref().is_some_and(|f| !f()) {
            break;
        }
        if provider_failed {
            break;
        }

        if !is_within_schedule_window(
            &config.schedule_window_start,
            &config.schedule_window_end,
            now,
        ) {
            skipped.schedule_window += 1;
            continue;
        }

        let packets = repository.list_source_packets(Some(&config.account_id), None, None)?;
        let today_packets: Vec<_> = packets
            .iter()
            .filter(|packet| {
                packet.source_type == config.source_type && packet.created_at.starts_with(&today)
            })
            .collect();
        let base_target =
            (config.max_packets_per_day as usize).min(daily_packet_target(&today, deps));
        let (target, _reason) = performance_adjusted_target(
            base_target,
            performance_by_type.get(&config.source_type),
            deps,
        );
        let carried_over = carried_over_by_account
            .get(&config.account_id)
            .copied()
            .unwrap_or(0)
            .min(target.saturating_sub(1));
        let effective_cap = target.saturating_sub(carried_over);
        if today_packets.len() >= effective_cap {
            skipped.packet_cap += 1;
            continue;
        }

        let Some(adapter) = options.adapters.get(&config.source_type) else {
            continue;
        };
        if !is_source_type(&config.source_type) {
            continue;
        }

        let remaining = effective_cap - today_packets.len();

        let mut fetch_metadata: ConfigMetadata = config.metadata.clone();
        if config.source_type == "x-feed" {
            fetch_metadata.insert(
                "accountId".to_string(),
                Value::String(config.account_id.clone()),
            );
        }

        let raw: Vec<SourceItem> = match adapter.fetch(&fetch_metadata).await {
            Ok(items) => items,
            Err(error) => {
                errors.push(IngestError {
                    config_id: config.id.clone(),
                    error: error.to_string(),
                });
                continue;
            }
        };

        let fresh: Vec<SourceItem> = if config.source_type == "goldfish" {
            raw
        } else {
            raw.into_iter()
                .filter(|item| is_fresh_source_item(item, now))
                .collect()
        };

        let fresh_len = fresh.len();
        let on_topic: Vec<SourceItem> = if matches!(
            config.source_type.as_str(),
            "job" | "x-feed" | "model-releases" | "goldfish"
        ) {
            fresh
        } else {
            fresh.into_iter().filter(is_on_topic_source_item).collect()
        };
        skipped.off_topic += fresh_len - on_topic.len();

        let items = prioritize_source_items(on_topic);
        let mut created_for_config = 0_usize;

        for item in items {
            if created_for_config >= remaining {
                break;
            }
            let host = source_host(Some(&item.url));
            if !is_allowed_source_url(Some(&item.url)) {
                skipped.blocked_url += 1;
                continue;
            }
            let host_posts_today = (host
                .as_ref()
                .map(|host| posted_host_counts.get(host).copied().unwrap_or(0))
                .unwrap_or(0))
                + (host
                    .as_ref()
                    .map(|host| seen_hosts_this_run.get(host).copied().unwrap_or(0))
                    .unwrap_or(0));
            if host.is_some()
                && host_posts_today as i64
                    >= same_host_post_cap(host.as_deref().unwrap_or(""), deps)
            {
                skipped.host_cap += 1;
                continue;
            }
            if host.is_some()
                && has_topic_overlap(
                    &item.title,
                    posted_titles_by_host
                        .get(host.as_deref().unwrap_or(""))
                        .cloned()
                        .unwrap_or_default()
                        .as_slice(),
                )
            {
                skipped.topic_overlap += 1;
                continue;
            }
            if !item.url.is_empty()
                && (posted_source_urls.contains(&item.url)
                    || seen_urls_this_run.contains(&item.url))
            {
                skipped.duplicate_posted_url += 1;
                continue;
            }
            if !item.url.is_empty() {
                seen_urls_this_run.insert(item.url.clone());
            }
            if !item.url.is_empty() {
                match repository.get_source_packet_by_url(&item.url, Some(&config.account_id)) {
                    Ok(Some(_existing)) => {
                        skipped.duplicate_packet += 1;
                        continue;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        errors.push(IngestError {
                            config_id: config.id.clone(),
                            error: error.to_string(),
                        });
                        continue;
                    }
                }
            }

            let enriched = match adapter.enrich(item.clone()).await {
                Ok(enriched) => enriched,
                Err(_) => item.clone(),
            };
            let fields = if config.source_type == "x-feed" {
                packet_fields_from_feed_digest(&enriched)
            } else {
                packet_fields_from_item(&enriched)
            };
            if !has_enough_source_context(&fields.title, &fields.summary, &fields.facts) {
                skipped.thin_context += 1;
                continue;
            }
            if is_low_signal_source_title(&fields.title) {
                skipped.low_signal += 1;
                continue;
            }

            let tweet_type = route_tweet_type(
                &enriched,
                Some(adapter.name()),
                Some(adapter.source_type()),
                &config.tweet_type_mix,
                &RoutingContext {
                    account_id: config.account_id.clone(),
                    recent_posts: recent_posts.clone(),
                },
            );

            let packet_created =
                match repository.create_source_packet(&zyquor_storage::NewSourcePacket {
                    account_id: config.account_id.clone(),
                    source_type: config.source_type.clone(),
                    title: fields.title.clone(),
                    url: if enriched.url.is_empty() {
                        None
                    } else {
                        Some(enriched.url.clone())
                    },
                    summary: fields.summary,
                    facts: fields.facts,
                    tweet_type: tweet_type.as_str().to_string(),
                }) {
                    Ok(packet) => packet,
                    Err(error) => {
                        errors.push(IngestError {
                            config_id: config.id.clone(),
                            error: error.to_string(),
                        });
                        continue;
                    }
                };
            let drafted = draft_from_source_packet(
                repository,
                options.generation_provider.clone(),
                packet_created.clone(),
                deps,
                PacketDraftOptions {
                    auto_approve: options.auto_approve,
                    count: Some(1),
                    media_urls: if enriched.image_url.is_some() {
                        Some(vec![enriched.image_url.clone().unwrap_or_default()])
                    } else {
                        None
                    },
                    mode: None,
                },
            )
            .await;

            match drafted {
                Ok(drafted) => {
                    results.push(IngestRunResult {
                        config_id: config.id.clone(),
                        draft_id: drafted.draft.id.clone(),
                        job_id: drafted.approved.clone().map(|(_, job)| job.id),
                        packet_id: packet_created.id.clone(),
                        source_type: packet_created.source_type.clone(),
                        url: packet_created.url.clone(),
                    });
                    created_for_config += 1;
                    if let Some(on_progress) = &options.on_progress {
                        on_progress(IngestProgress {
                            errors: errors.clone(),
                            processed: results.len(),
                        });
                    }
                    if let Some(host) = &host {
                        *seen_hosts_this_run.entry(host.clone()).or_default() += 1;
                        posted_titles_by_host
                            .entry(host.clone())
                            .or_default()
                            .push(fields.title.clone());
                    }
                }
                Err(error) => {
                    let _ = repository.delete_source_packet(&packet_created.id);
                    if matches!(error, crate::AutomationError::TopicDraftExists { .. }) {
                        skipped.topic_overlap += 1;
                        continue;
                    }
                    let message = error.to_string();
                    errors.push(IngestError {
                        config_id: config.id.clone(),
                        error: message.clone(),
                    });
                    if let Some(on_progress) = &options.on_progress {
                        on_progress(IngestProgress {
                            errors: errors.clone(),
                            processed: results.len(),
                        });
                    }
                    if is_provider_failure(&message) {
                        provider_failed = true;
                        break;
                    }
                }
            }
        }
    }

    Ok(IngestResult {
        processed: results.len(),
        errors,
        results,
        skipped,
    })
}

fn is_source_type(value: &str) -> bool {
    value.parse::<zyquor_core::types::SourceType>().is_ok()
}
