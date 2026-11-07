//! Tweet-type routing, ported from `packages/automation/src/routing.ts` plus
//! `inferTweetTypeFromText` / `normalizeTweetType` from `context.ts` /
//! `selection.ts`.

use chrono::DateTime;
use serde_json::{Map, Value};
use zyquor_adapters::SourceItem;
use zyquor_core::types::TweetType;

const ROLLING_TYPE_WINDOW: usize = 10;
const DAILY_TYPE_CAP: usize = 3;
const CONSECUTIVE_TYPE_PENALTY: f64 = 0.4;

/// The bits of a past post the router needs for pacing.
#[derive(Debug, Clone, Default)]
pub struct RecentPostType {
    pub account_id: String,
    pub post_url: Option<String>,
    pub posted_at: String,
    pub posted_text: Option<String>,
    pub tweet_type: Option<String>,
}

/// Everything a routing decision needs about the account.
#[derive(Debug, Clone, Default)]
pub struct RoutingContext {
    pub account_id: String,
    pub recent_posts: Vec<RecentPostType>,
}

fn is_tweet_type(value: &str) -> bool {
    value.parse::<TweetType>().is_ok()
}

/// `normalizeTweetType` from `selection.ts`: unknown or empty values fall
/// back to `useful_info`.
pub fn normalize_tweet_type(value: &str) -> TweetType {
    if is_tweet_type(value) {
        value.parse::<TweetType>().unwrap_or(TweetType::UsefulInfo)
    } else {
        TweetType::UsefulInfo
    }
}

/// `inferTweetTypeFromText` from `context.ts`: a deterministic prior for a
/// source item, by title/metadata keywords.
pub(crate) fn infer_tweet_type_from_text(
    title: &str,
    content: &str,
    source: &str,
    metadata_type: &str,
) -> TweetType {
    let title_lower = title.to_lowercase();
    let content_lower = content.to_lowercase();
    if metadata_type == "hiring"
        || source.contains("hackernews-jobs")
        || matches_title_pattern(&title_lower, r"(?i)hiring|is hiring|we're hiring|jobs?")
    {
        return TweetType::UsefulInfo;
    }
    if source == "company-rss"
        || matches_title_pattern(&title_lower, r"(?i)\b(blog|article|post|essay|guide)\b")
    {
        return TweetType::UsefulInfo;
    }
    if matches_title_pattern(
        &format!("{title_lower} {content_lower}"),
        r"(?i)\b(history|invented|inventor|founded|founder|created|origin|born|died|legacy|anniversary|pioneer)\b",
    ) {
        return TweetType::NarrativeHistory;
    }
    if matches_title_pattern(&title_lower, r"(?i)how to|tutorial|guide") {
        return TweetType::Guide;
    }
    if matches_title_pattern(&title_lower, r"(?i)mistake|wrong|lesson|learned") {
        return TweetType::Guide;
    }
    if matches_title_pattern(&title_lower, r"(?i)opinion|think|believe|should") {
        return TweetType::Opinion;
    }
    if matches_title_pattern(&title_lower, r"(?i)tool|app|product|launch") {
        return TweetType::UsefulInfo;
    }
    if matches_title_pattern(&content_lower, r"(?i)study|research|paper") {
        return TweetType::UsefulInfo;
    }
    TweetType::FeedObservation
}

fn matches_title_pattern(haystack: &str, pattern: &str) -> bool {
    fancy_regex::Regex::new(pattern)
        .map(|regex| regex.is_match(haystack).unwrap_or(false))
        .unwrap_or(false)
}

fn distinct_recent_posts(
    posts: &[RecentPostType],
    account_id: &str,
    now: DateTime<chrono::Utc>,
) -> (Vec<TweetType>, std::collections::HashMap<TweetType, usize>) {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut distinct: Vec<&RecentPostType> = Vec::new();
    for post in posts {
        if post.account_id != account_id {
            continue;
        }
        let Some(tweet_type) = post.tweet_type.as_deref() else {
            continue;
        };
        if !is_tweet_type(tweet_type) {
            continue;
        }
        if post.posted_text.as_deref().is_some_and(is_bare_url) {
            continue;
        }
        let key = post
            .post_url
            .clone()
            .unwrap_or_else(|| format!("{}-{tweet_type}", post.posted_at));
        if seen.contains(&key) {
            continue;
        }
        seen.insert(key);
        distinct.push(post);
    }

    let recent_types: Vec<TweetType> = distinct
        .iter()
        .rev()
        .take(ROLLING_TYPE_WINDOW)
        .filter_map(|post| post.tweet_type.as_deref()?.parse::<TweetType>().ok())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    let today = now.format("%Y-%m-%d").to_string();
    let mut today_counts: std::collections::HashMap<TweetType, usize> =
        std::collections::HashMap::new();
    for post in &distinct {
        if !post.posted_at.starts_with(&today) {
            continue;
        }
        if let Ok(tweet_type) = post
            .tweet_type
            .as_deref()
            .unwrap_or("")
            .parse::<TweetType>()
        {
            *today_counts.entry(tweet_type).or_default() += 1;
        }
    }

    (recent_types, today_counts)
}

fn is_bare_url(text: &str) -> bool {
    matches_title_pattern(text.trim(), r"^https?://\S+$")
}

/// FNV-1a over UTF-16 code units, matching the JS `charCodeAt` loop.
fn stable_hash(value: &str) -> u32 {
    let mut hash: u32 = 2_166_136_261;
    for unit in value.encode_utf16() {
        hash ^= unit as u32;
        hash = hash.wrapping_mul(16_777_619);
    }
    hash
}

fn tweet_type_from_mix(
    inferred: TweetType,
    item: &SourceItem,
    mix: &Map<String, Value>,
    recent_types: &[TweetType],
    today_counts: &std::collections::HashMap<TweetType, usize>,
) -> TweetType {
    let mut entries: Vec<(TweetType, f64)> = Vec::new();
    for (key, weight_value) in mix.iter() {
        let weight = weight_value.as_f64().filter(|weight| weight.is_finite());
        let Ok(tweet_type) = key.parse::<TweetType>() else {
            continue;
        };
        let Some(weight) = weight.filter(|weight| *weight > 0.0) else {
            continue;
        };
        if tweet_type == TweetType::NarrativeHistory && inferred != TweetType::NarrativeHistory {
            continue;
        }

        let mut adjusted = weight;
        if today_counts.get(&tweet_type).copied().unwrap_or(0) >= DAILY_TYPE_CAP {
            adjusted = 0.0;
        }
        let recent_count = recent_types
            .iter()
            .filter(|recent| **recent == tweet_type)
            .count();
        if recent_count >= ROLLING_TYPE_WINDOW {
            adjusted = 0.0;
        } else {
            adjusted *= 1.0 - recent_count as f64 / ROLLING_TYPE_WINDOW as f64;
        }
        if recent_types.last() == Some(&tweet_type) {
            adjusted *= CONSECUTIVE_TYPE_PENALTY;
        }
        entries.push((tweet_type, adjusted));
    }

    let total: f64 = entries.iter().map(|(_, weight)| weight).sum();
    if total <= 0.0 {
        return inferred;
    }

    // `stableHash(...) % total` (JS keeps it fractional; same here).
    let hash = stable_hash(&format!("{}\n{}", item.url, item.title));
    let mut selected = (hash as f64) % total;
    for (tweet_type, weight) in entries {
        selected -= weight;
        if selected < 0.0 {
            return tweet_type;
        }
    }
    inferred
}

/// Route an ingested item to a tweet type. `mix` is the ingest config's
/// `tweetTypeMix` weights.
pub fn route_tweet_type(
    item: &SourceItem,
    source_name: Option<&str>,
    source_type: Option<&str>,
    mix: &Map<String, Value>,
    context: &RoutingContext,
) -> TweetType {
    let source_name = item
        .metadata
        .get("source")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .or(source_name)
        .unwrap_or("");
    let source_type = source_type.unwrap_or("");
    let metadata_type = item
        .metadata
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("");

    if source_type == "job"
        || metadata_type == "hiring"
        || source_name == "hiring"
        || source_name == "hackernews-jobs"
    {
        return TweetType::UsefulInfo;
    }
    if source_type == "x-feed" {
        return TweetType::FeedObservation;
    }

    let (recent_types, today_counts) = distinct_recent_posts(
        &context.recent_posts,
        &context.account_id,
        chrono::Utc::now(),
    );
    let inferred =
        infer_tweet_type_from_text(&item.title, &item.content, source_name, metadata_type);
    tweet_type_from_mix(inferred, item, mix, &recent_types, &today_counts)
}
