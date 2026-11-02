//! Deterministic tweet quality scoring and text post-processing, ported from
//! `packages/generation/src/quality.ts`.
//!
//! Patterns are compiled on each call. That is a deliberate trade for
//! readability during the migration; hoisting them into `OnceLock` statics is
//! a follow-up optimisation once the parity harness confirms the port.

use fancy_regex::Regex;
use zyquor_core::AI_SLOP_PHRASES;
use zyquor_core::paths::EnvLookup;

/// Clamp a requested candidate count. The cap is a request-size guard, not a
/// quality decision.
pub fn normalize_count(count: Option<usize>) -> usize {
    count.unwrap_or(1).clamp(1, 50)
}

pub const DEFAULT_QUALITY_MIN: f64 = 7.0;
pub const DEFAULT_REPLY_QUALITY_MIN: f64 = 5.0;

/// Patterns are compile-time constants, covered by `all_patterns_compile`.
#[allow(clippy::panic)]
fn compile(pattern: &str) -> Regex {
    match Regex::new(pattern) {
        Ok(regex) => regex,
        // A malformed constant is a programming error, and silently skipping
        // the check would let slop through, so fail loudly instead.
        Err(error) => panic!("quality pattern failed to compile: {pattern} ({error})"),
    }
}

fn is_match(pattern: &str, text: &str) -> bool {
    compile(pattern).is_match(text).unwrap_or(false)
}

fn any_match(patterns: &[&str], text: &str) -> bool {
    patterns.iter().any(|pattern| is_match(pattern, text))
}

fn bounded_quality(value: Option<String>, fallback: f64) -> f64 {
    let parsed = value
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| raw.parse::<f64>().ok());
    match parsed {
        Some(value) if value.is_finite() => value.clamp(0.0, 10.0),
        _ => fallback,
    }
}

pub fn quality_minimum(env: EnvLookup<'_>) -> f64 {
    bounded_quality(env("ZYQUOR_QUALITY_MIN"), DEFAULT_QUALITY_MIN)
}

/// Reply floor for the approval screen. `score_tweet_quality`'s payoff and
/// specific-noun checks were calibrated on full-length posts; one-line replies
/// rarely reach the post floor even when they are clean.
pub fn reply_quality_minimum(env: EnvLookup<'_>) -> f64 {
    bounded_quality(env("ZYQUOR_REPLY_QUALITY_MIN"), DEFAULT_REPLY_QUALITY_MIN)
}

// --- pattern tables -----------------------------------------------------

const INTERNAL_LEAK_PATTERNS: &[&str] = &[
    r"(?i)\bSourcePackets?\b",
    r"(?i)\bsource packets?\b",
    r"(?i)\bCompact input\b",
    r"(?i)\bcandidate tweet\b",
    r"(?i)\bdraft candidate\b",
    r"(?i)\bstrict JSON\b",
    r"(?i)\b(?:candidate|draft|source) metadata\b",
    r"(?i)\bgrounded facts?\b",
    r"(?i)\bsource context\b",
    r"(?i)\bzyquor\b",
    r"(?i)</?source-(?:title|url)",
    r"(?i)\bI distilled\b",
    r"(?i)\bdistill(ed|ing)?\b.*\b(article|announcement|content)\b",
];

const INCOMPLETE_PATTERNS: &[&str] = &[
    r"\.\.\.$",
    "…$",
    r"(?i)\b(read more|continue reading|more below)\b",
    r"[:;,]\s*$",
];

const GENERIC_SLOP_PATTERNS: &[&str] = &[
    r"(?i)\bgame[- ]chang(er|ing)\b",
    r"(?i)\bunlock\b",
    r"(?i)\bleverage\b",
    r"(?i)\bsynergy\b",
    r"(?i)\bin today's (fast-paced )?world\b",
    r"(?i)\bnow more than ever\b",
    r"(?i)\bas an ai\b",
    r"(?i)\blet that sink in\b",
    r"(?i)\bread that again\b",
    r"(?i)\bhere'?s the (thing|kicker)\b",
    r"(?i)\bthe best part\?",
    r"(?i)\bhot take:",
    r"(?i)\bunpopular opinion\b",
    r"(?i)\b(nobody|no one) talks about\b",
    r"(?i)\bdelve\b",
    r"(?i)\bmind.blowing\b",
    r"(?i)\bthis changes everything\b",
    r"(?i)\bthe future is here\b",
    r"(?i)\bhere'?s why\b",
    r"(?i)\bwhy this matters\b",
    r"(?i)\b(?:more possibilities|new possibilities)\b",
    r"(?i)\bit'?s not [^.!?\n]{1,60}, it'?s\b",
    r"(?i)\b(?:is|are|was|were)n'?t just [^.!?\n]{1,60}, (?:it|they)'?(?:s|re)\b",
    r"(?i)\b(wild|huge|insane)\.$",
];

const WEAK_OPENER_PATTERN: &str = r"(?i)^(interesting|(?:a|quick|friendly) reminder|this shows|fun fact|breaking\b|just in|did you know|imagine|picture this|in a world)";

const ADJECTIVE_BLOAT_PATTERNS: &[&str] = &[
    r"(?i)\b(exciting|thrilling|groundbreaking|revolutionary|disruptive|innovative|cutting-edge|state-of-the-art|powerful|robust|seamless|effortless|comprehensive|holistic|impactful|strategic|dynamic|scalable)\b",
];

const LINKEDIN_VOICE_PATTERNS: &[&str] = &[
    r"(?i)\b(thrilled|excited|honored|humbled|proud|grateful|blessed|journey|exciting news|big news|i'?m excited to announce|we are pleased to announce)\b",
    r"(?i)\bleverage\b",
    r"(?i)\bunlocking\b",
    r"(?i)\bthought leadership\b",
    r"(?i)\bkey takeaways\b",
];

const WEAK_ENDING_PATTERN: &str = r"(?i)(?:\b(?:etc\.?|so|and|but|or|thoughts\??|agree\??|what do you think\??|does this resonate\??|let me know(?: what you think)?[.!?]?)|\.\.\.|…)\s*$";
const EM_DASH_OVERUSE_PATTERN: &str = r"(?:[—–][^—–]*){2,}";

const PAYOFF_PATTERNS: &[&str] = &[
    r"(?i)\b(?:if|unless|until|whenever)\b",
    r"(?i)\bwhen\b(?! it comes to)",
    r"(?i)\b(?:which|that) means\b",
    r"(?i)\bbecause\b",
    r"(?i)\bbut\b",
    r"(?i)\bso (?:you|they|we|i|the|it)\b",
    r"(?i)\bstopped? \w+ing\b",
    r"(?i)\b(?:instead of|rather than|not worth|only|by removing|the (?:cost|tradeoff|catch|limit|constraint|difference|point|question) is)\b",
    r"(?i)\btrade[- ]?offs?\b",
    r"(?i)\b(?:gave up|replaced|after removing|without)\b",
    r"(?i)\bturns? .{3,40} into\b",
    r"(?i)\bmatters (?:most )?(?:to|when|because)\b",
];

const APHORISM_PATTERNS: &[&str] = &[
    r"(?i)\bproperty of\b",
    r"(?i)\bis the one that\b",
    r"(?i)\bthe one that cannot\b",
    r"(?i)\b(?:is|are) exactly the (?:part|thing|one)\b",
    r"(?i)\bdivergent\b",
    r"(?i)\bnot [a-z][\w ']{0,20}, it[ ']s\b",
    r"(?i)\b(?:different|divergent|moral) (?:principles or readings|grounds for|readings of the situation)\b",
    r"(?i)\bis (?:not |never )?[a-z][\w '-]{0,20}, (?:and )?[a-z][\w '-]{0,30} is (?:not |never )?[a-z]",
];

const RECAP_OPENERS: &[&str] = &[
    r"(?i)^(?:a |an )?new\b",
    r"(?i)^(?:researchers|the team|the paper|the post|the article|the release|the project|the company)\b",
    r"(?i)^\w[\w .'-]{0,60}\b(?:released|announced|published|launched|shipped|introduced|arrives?|is here|has arrived|hits (?:v?\d|stable)|reaches stable|is now (?:a )?stable)\b",
    r"(?i)\bafter years of\b",
];

const SOURCE_ARTIFACT_PATTERNS: &[&str] = &[
    r"(?i)\bverified (?:facts?|part)\b",
    r"(?i)\bknown summary\b",
    r"(?i)\bsource (?:title|name)\b",
    r"(?i)\bthis milestone\b",
    r"(?i)\b(?:workflow )?impact is\b",
];

const CODE_TOKEN_PATTERNS: &[&str] = &[
    r"\b[a-zA-Z_][\w$]*\([^()\n]*\)",
    r"\b[a-z]+(?:_[a-z0-9]+){1,}\b",
    r"\bself\.\w+\b",
];

const CHANGELOG_VERSION_PATTERN: &str = r"\bv?\d+\.\d+(?:\.\d+)?\b";
const FIRST_PERSON_PATTERN: &str = r"(?i)\b(i|we|my|our|i'm|i've)\b";

const TECHNICAL_NOUNS: &str = r"(?i)\b(model|database|API|kernel|compiler|chip|GPU|CPU|LLM|agent|router|index|cache|queue|token|protocol|framework|library|repo|repository|commit|release|version|patch|benchmark|latency|throughput|dataset|embedding|vector|cluster|node|pod|container|function|service|endpoint|query|transaction|inference|training|fine-tuning|distillation|quantization|attention|transformer|diffusion|RAG|SLM|MoE|dense|sparse|search|symbol|definition|mention|text)\b";

/// Demand-style opener that reads like a lazy agent prompt.
pub const REPLY_DODGE_REASON: &str = "interrogation_dodge";

const REPLY_DODGE_PATTERN: &str = r#"(?i)^(?:explain|describe|tell\s+me|show\s+me|walk\s+me|can\s+you|could\s+you|would\s+you|please\s+(?:explain|describe|show|make|write|do)|what\s+(?:is|are|does)|what\s+kind\s+of|how\s+(?:do|does|would|to)|why\s+(?:do|does|is|are)|which\s+(?:one|part|api|class|tool|module)|make\s+me|write\s+me)\b"#;

// --- text processing ----------------------------------------------------

const SOURCE_TAG_RE: &str = r"(?i)</?source-(?:title|url)\s*>";
const URL_RE: &str = r"(?i)https?://[^\s]+";
const DASH_RE: &str = r"\s*[\u{2013}\u{2014}]\s*";
const WHITESPACE_RE: &str = r"[^\S\n]+";
const SPACE_BEFORE_PUNCT_RE: &str = r"\s+([,.!?;:])";
const TRAILING_COLON_RE: &str = r":\s*$";
const REPEATED_PUNCT_RE: &str = r"([,.!?;:]){2,}";
const BLANK_LINES_RE: &str = r"\n{3,}";
const URL_TOKEN_RE: &str = r"\u{E000}(\d+)\u{E001}";

fn process_tweet_text(text: &str, preserve_case: bool) -> String {
    let untagged = compile(SOURCE_TAG_RE).replace_all(text, "").into_owned();

    let mut urls: Vec<String> = Vec::new();
    let mut protected = String::with_capacity(untagged.len());
    let mut last = 0;
    for found in compile(URL_RE).find_iter(&untagged).flatten() {
        protected.push_str(&untagged[last..found.start()]);
        protected.push_str(&format!("\u{E000}{}\u{E001}", urls.len()));
        urls.push(found.as_str().to_string());
        last = found.end();
    }
    protected.push_str(&untagged[last..]);

    let dashes = compile(DASH_RE).replace_all(&protected, ", ").into_owned();
    let unified = dashes.replace("\r\n", "\n").replace('\r', "\n");

    let cleaned: Vec<String> = unified
        .split('\n')
        .map(|line| {
            let step = compile(WHITESPACE_RE).replace_all(line, " ").into_owned();
            let step = compile(SPACE_BEFORE_PUNCT_RE)
                .replace_all(&step, "$1")
                .into_owned();
            let step = compile(TRAILING_COLON_RE)
                .replace_all(&step, ".")
                .into_owned();
            let step = compile(REPEATED_PUNCT_RE)
                .replace_all(&step, "$1")
                .into_owned();
            step.trim().to_string()
        })
        .collect();

    let joined = compile(BLANK_LINES_RE)
        .replace_all(&cleaned.join("\n"), "\n\n")
        .into_owned();
    let trimmed = joined.trim().to_string();

    let cased = if preserve_case {
        trimmed
    } else {
        trimmed.to_lowercase()
    };

    restore_urls(&cased, &urls)
}

fn restore_urls(text: &str, urls: &[String]) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for found in compile(URL_TOKEN_RE).find_iter(text).flatten() {
        out.push_str(&text[last..found.start()]);
        let index = found
            .as_str()
            .trim_start_matches('\u{E000}')
            .trim_end_matches('\u{E001}')
            .parse::<usize>()
            .ok();
        if let Some(url) = index.and_then(|index| urls.get(index)) {
            out.push_str(url);
        }
        last = found.end();
    }
    out.push_str(&text[last..]);
    out
}

pub fn format_tweet_text(text: &str) -> String {
    process_tweet_text(text, true)
}

pub fn post_process_tweet_text(text: &str) -> String {
    process_tweet_text(text, false)
}

// --- scoring ------------------------------------------------------------

fn escape_regex(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        if ".*+?^${}()|[]\\".contains(ch) {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

fn contains_generic_slop(text: &str) -> bool {
    let slop = AI_SLOP_PHRASES.iter().any(|phrase| {
        let pattern = format!(r"(?i)\b{}\b", escape_regex(phrase));
        is_match(&pattern, text)
    });
    slop || any_match(GENERIC_SLOP_PATTERNS, text)
}

fn contains_aphorism(text: &str) -> bool {
    any_match(APHORISM_PATTERNS, text)
}

fn count_payoff_signals(text: &str) -> usize {
    PAYOFF_PATTERNS
        .iter()
        .filter(|pattern| is_match(pattern, text))
        .count()
}

fn looks_like_source_recap(text: &str) -> bool {
    // First-person-led posts carry the author's own stake, so release verbs
    // describe personal work rather than a third-party recap.
    let trimmed = text.trim();
    if is_match(r"(?i)^(i|we|my|our)\b", trimmed) {
        return false;
    }
    any_match(RECAP_OPENERS, trimmed)
}

fn looks_like_third_party_changelog(text: &str) -> bool {
    if is_match(FIRST_PERSON_PATTERN, text) {
        return false;
    }
    if !is_match(CHANGELOG_VERSION_PATTERN, text) {
        return false;
    }
    any_match(CODE_TOKEN_PATTERNS, text)
}

fn count_specific_nouns(text: &str) -> usize {
    compile(TECHNICAL_NOUNS).find_iter(text).flatten().count()
}

pub fn score_tweet_quality(text: &str) -> i64 {
    let trimmed = text.trim();
    let payoff_signals = count_payoff_signals(trimmed);
    let mut score: i64 = 3;

    if is_match(r"[0-9]", trimmed) {
        score += 1; // concrete number
    }
    if is_match(r"https?://", trimmed) {
        score += 1; // source link
    }
    score += count_specific_nouns(trimmed).min(3) as i64; // specific vocabulary
    if payoff_signals > 0 {
        score += 2; // real consequence/tradeoff/decision
    }
    if any_match(SOURCE_ARTIFACT_PATTERNS, trimmed) {
        score -= 3;
    }
    if looks_like_source_recap(trimmed) {
        score -= 3;
    }
    if looks_like_third_party_changelog(trimmed) {
        score -= 4;
    }
    if is_match(WEAK_OPENER_PATTERN, trimmed) {
        score -= 2;
    }
    if any_match(ADJECTIVE_BLOAT_PATTERNS, trimmed) {
        score -= 2;
    }
    if contains_aphorism(trimmed) {
        score -= 3;
    }
    score
}

pub fn is_clean_tweet_text(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty()
        && !any_match(INTERNAL_LEAK_PATTERNS, trimmed)
        && !any_match(INCOMPLETE_PATTERNS, trimmed)
        && !contains_generic_slop(trimmed)
        && !any_match(LINKEDIN_VOICE_PATTERNS, trimmed)
        && !is_match(WEAK_ENDING_PATTERN, trimmed)
        && !is_match(EM_DASH_OVERUSE_PATTERN, trimmed)
        && !is_match(r"^[-*\[\{]", trimmed)
        && !trimmed.contains('\u{FFFD}')
}

pub fn is_interrogation_dodge_reply(text: &str) -> bool {
    let unquoted = text
        .trim()
        .trim_start_matches(['"', '\'', '\u{201c}', '\u{201d}']);
    is_match(REPLY_DODGE_PATTERN, unquoted)
}

pub fn passes_tweet_quality_floor(text: &str, minimum: f64) -> bool {
    is_clean_tweet_text(text)
        && !looks_like_source_recap(text)
        && (score_tweet_quality(text) as f64) >= minimum
}
