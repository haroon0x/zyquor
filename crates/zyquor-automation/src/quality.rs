//! Post quality gates, ported from `packages/automation/src/quality.ts`.

use chrono::DateTime;
use fancy_regex::Regex;
use zyquor_core::AI_SLOP_PHRASES;
use zyquor_generation::{format_tweet_text, passes_tweet_quality_floor};
use zyquor_storage::PostHistory;
use zyquor_storage::SourcePacket;

const SAME_PACKET_COOLDOWN_MS: i64 = 2 * 60 * 60 * 1000;

const LOW_SIGNAL_TITLE_PATTERNS: &[&str] = &[
    r"(?i)\b50%\s+off\b",
    r"(?i)\blast\s+24\s+hours?\b",
    r"(?i)\bdiscount\b",
    r"(?i)\bpromo\b",
    r"(?i)\bsale\b",
    r"(?i)\bgiveaway\b",
    r"(?i)\ba\s+guide\s+to\b",
    r"(?i)\bguides?\s+to\s+using\b",
    r"(?i)\bhow\s+to\s+use\b",
    r"(?i)\bhow\s+to\s+get\s+started\b",
    r"(?i)\bgetting\s+started\s+with\b",
    r"(?i)\b(now\s+(available|live)|rolling\s+out|coming\s+soon)\b",
    r"(?i)\bintroducing\b",
    r"(?i)\bannouncing\b",
    r"(?i)\bnew\s+(in|to)\s+the\s+\w+\b",
    r"(?i)\b[a-z]+\s+releases?\s+(a|new)\b",
];

const RISKY_UNSUPPORTED_PATTERNS: &[&str] = &[
    r"(?i)\balways\s+(safe|works|wins|fails)\b",
    r"(?i)\bnever\s+(safe|works|wins|fails)\b",
    r"(?i)\beveryone\s+(is|was|will|can)\b",
    r"(?i)\bno one\s+(is|was|will|can)\b",
];

// "we"/"our" + an action verb. For non-feed source packets the material is
// always someone else's work, so first-person ownership phrasing ("we built
// X", "we dropped Postgres") misattributes it to the account owner and must
// be rejected.
const FIRST_PERSON_MISATTRIBUTION: &str = r#"(?i)(?:^|[\s(),;:.'"])(?:we|our)\s+(?:team|company|engineering)?\s*(?:built|build|ship(?:s|ped)?|made|make|created?|launch(?:ed)?|wrote|write|developed?|designed?|deploy(?:ed)?|migrat(?:ed|ing)?|moved?|replaced?|switch(?:ed|ing)?|released?|published?|drop(?:ped)?|cut|reduced?|saved?|scal(?:ed)?|handled?|served?|processed?|r[au]n|used?|added?|removed?|introduced?|adopted?|tested?|verified?|maintained?|owned?|operated?|prototyped?)\b"#;
const ACCOUNT_MENTION_PATTERN: &str = r"(^|[^\w@])@[A-Za-z0-9_]{1,15}\b";

fn matches_any(patterns: &[&str], haystack: &str) -> bool {
    patterns.iter().any(|pattern| {
        Regex::new(pattern)
            .map(|regex| regex.is_match(haystack).unwrap_or(false))
            .unwrap_or(false)
    })
}

fn is_match(pattern: &str, haystack: &str) -> bool {
    Regex::new(pattern)
        .map(|regex| regex.is_match(haystack).unwrap_or(false))
        .unwrap_or(false)
}

/// `validateGeneratedPostQuality` from `quality.ts`: the static checks a
/// generated candidate must survive.
#[derive(Debug, Clone, PartialEq)]
pub struct PostQualityResult {
    pub ok: bool,
    pub reasons: Vec<String>,
    pub text: String,
}

/// `validateGeneratedPostQuality` — floor + formatting pass, no packet view.
pub fn validate_generated_post_quality(text: &str, quality_min: f64) -> PostQualityResult {
    let normalized = format_tweet_text(text);
    let mut reasons = Vec::new();
    if normalized.is_empty() {
        reasons.push("empty_post_text".to_string());
    }
    if !passes_tweet_quality_floor(&normalized, quality_min) {
        reasons.push("post_failed_quality_floor".to_string());
    }
    let ok = reasons.is_empty();
    PostQualityResult {
        ok,
        reasons,
        text: normalized,
    }
}

fn contains_url(text: &str) -> bool {
    is_match(r"(?i)https?://\S+", text)
}

fn source_is_external(packet: &SourcePacket) -> bool {
    packet.source_type != "x-feed"
}

/// Long-form company/blog sources carry their real link. ShareViaCopyLink is
/// the highest-weight organic action in the x-algorithm scoring, and the tweet
/// text stays link-free so the model never invents one; the link is attached
/// post-hoc.
fn source_needs_link(packet: &SourcePacket) -> bool {
    packet.source_type != "x-feed"
        && is_match(r"(?i)\b(blog|article|post|essay|guide)\b", &packet.title)
}

fn source_evidence(packet: &SourcePacket) -> String {
    format!(
        "{}\n{}\n{}",
        packet.title,
        packet.summary,
        packet.facts.join("\n")
    )
    .to_lowercase()
}

pub(crate) fn strip_urls(text: &str) -> String {
    format_tweet_text(&crate::packet_text::replace_all(
        r"(?i)\[([^\]]+)\]\(https?://[^)\s]+\)",
        text,
        "$1",
    ))
}

pub(crate) fn repair_quote_timeline(text: &str) -> String {
    let normalized = format_tweet_text(text);
    if normalized.contains('\n') {
        return normalized;
    }
    let quote_count = crate::packet_text::replace_all(r"\s>\s", &normalized, " ")
        .matches('>')
        .count();
    if quote_count < 2 {
        return normalized;
    }
    let repaired = crate::packet_text::replace_all(r"\s+>\s+", &normalized, "\n> ");
    let repaired = crate::packet_text::replace_all(r"^>\s*", &repaired, "> ");
    format_tweet_text(&repaired)
}

/// `stripTrailingSourceLabel` from `quality.ts` (`pub` in TS; internal here).
pub(crate) fn strip_trailing_source_label(text: &str) -> String {
    crate::packet_text::replace_first(r"(https?://\S+)\s+\[[^\]\n]{1,40}\]\s+.+$", text, "$1")
        .trim_end()
        .to_string()
}

fn normalize_for_title_match(value: &str) -> String {
    crate::packet_text::replace_all(r"[^a-z0-9]+", &value.to_lowercase(), " ")
        .trim()
        .to_string()
}

/// `stripTrailingTitleEcho` from `quality.ts` (`pub` in TS; internal here).
pub(crate) fn strip_trailing_title_echo(text: &str, title: &str) -> String {
    let Some(caps) = capture_groups(r"(https?://\S+)[\s,;:.-]+([^\n]+)$", text) else {
        return text.to_string();
    };
    let echo = normalize_for_title_match(caps.get(1).map(String::as_str).unwrap_or(""));
    let normalized_title = normalize_for_title_match(title);
    if echo.len() < 12 || normalized_title.len() < 12 {
        return text.to_string();
    }
    let title_contains_echo = normalized_title.contains(&echo);
    let echo_contains_title = echo.contains(&normalized_title);
    if !title_contains_echo && !echo_contains_title {
        return text.to_string();
    }
    let Some(url_len) = caps.first().map(|url| url.len()) else {
        return text.to_string();
    };
    text[..url_len]
        .trim_end_matches([' ', ',', ';', ':', '.', '-'])
        .to_string()
}

fn capture_groups(pattern: &str, haystack: &str) -> Option<Vec<String>> {
    Regex::new(pattern).ok().and_then(|regex| {
        regex.captures(haystack).ok().flatten().map(|caps| {
            (0..caps.len())
                .map(|index| {
                    caps.get(index)
                        .map(|found| found.as_str().to_string())
                        .unwrap_or_default()
                })
                .collect()
        })
    })
}

/// Feed all helpers into the required-URL normalization (URL echo removal,
/// source-label stripping, quote-timeline repair).
pub fn with_required_source_url(text: &str, packet: &SourcePacket) -> String {
    let repaired = strip_trailing_title_echo(
        &strip_trailing_source_label(&repair_quote_timeline(text)),
        &packet.title,
    );
    let body = strip_urls(&repaired);
    if !source_needs_link(packet) || packet.url.is_none() {
        return body;
    }
    let separator = if body.contains('\n') { "\n" } else { " " };
    let url = packet.url.as_deref().unwrap_or("");
    format_tweet_text(&format!(
        "{body}{}{url}",
        if body.is_empty() { "" } else { separator }
    ))
}

fn has_broken_quote_timeline(text: &str) -> bool {
    format_tweet_text(text)
        .split('\n')
        .any(|line| is_match(r"^> .*\s> ", line))
}

use crate::dates::parse_millis;

fn recent_same_packet_post(
    packet: &SourcePacket,
    history: &[PostHistory],
    now: DateTime<chrono::Utc>,
) -> bool {
    let now_millis = now.timestamp_millis();
    history
        .iter()
        .filter(|item| {
            item.account_id == packet.account_id
                && item.source_packet_id.as_deref() == Some(packet.id.as_str())
        })
        .any(|item| {
            let posted = parse_millis(&item.posted_at).unwrap_or(0);
            now_millis - posted < SAME_PACKET_COOLDOWN_MS
        })
}

/// `validateSourcePostQuality` — the full source-post gate. `now` is folded
/// in by the caller at the call site; the packet content and the post
/// history are all it needs.
pub fn validate_source_post_quality(
    text: &str,
    packet: &SourcePacket,
    history: &[PostHistory],
) -> PostQualityResult {
    validate_source_post_quality_at(text, packet, history, chrono::Utc::now())
}

/// Bare-world variant of the gate where the caller pins `now` (ingest pins
/// the run's clock for determinism inside a batch).
pub fn validate_source_post_quality_at(
    text: &str,
    packet: &SourcePacket,
    history: &[PostHistory],
    now: DateTime<chrono::Utc>,
) -> PostQualityResult {
    let text = with_required_source_url(text, packet);
    let mut reasons = Vec::new();
    let evidence = source_evidence(packet);

    if text.is_empty() {
        reasons.push("empty_post_text".to_string());
    }
    if source_needs_link(packet) && !contains_url(&text) {
        reasons.push("missing_required_source_url".to_string());
    }
    if is_low_signal_source_title(&packet.title) {
        reasons.push("low_signal_promotional_source".to_string());
    }
    if recent_same_packet_post(packet, history, now) {
        reasons.push("same_source_packet_cooldown".to_string());
    }
    if matches_any(RISKY_UNSUPPORTED_PATTERNS, &text)
        && !matches_any(RISKY_UNSUPPORTED_PATTERNS, &evidence)
    {
        reasons.push("risky_unsupported_absolute_claim".to_string());
    }
    if source_is_external(packet) && is_match(FIRST_PERSON_MISATTRIBUTION, &text) {
        reasons.push("first_person_misattribution".to_string());
    }
    if source_is_external(packet) && is_match(ACCOUNT_MENTION_PATTERN, &text) {
        reasons.push("account_mention_risk".to_string());
    }
    if has_broken_quote_timeline(&text) {
        reasons.push("broken_quote_timeline_format".to_string());
    }

    let lower_text = text.to_lowercase();
    for phrase in AI_SLOP_PHRASES {
        if lower_text.contains(phrase) {
            reasons.push(format!("ai_slop_phrase:{phrase}"));
            break;
        }
    }

    let ok = reasons.is_empty();
    PostQualityResult { ok, reasons, text }
}

/// Promotional/announcement title detector used by ingest to skip vendor
/// marketing before drafting.
pub fn is_low_signal_source_title(title: &str) -> bool {
    matches_any(LOW_SIGNAL_TITLE_PATTERNS, title)
}
