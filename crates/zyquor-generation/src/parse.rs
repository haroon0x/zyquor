//! Turning raw model output into candidates, ported from the tail of
//! `packages/generation/src/quality.ts`.
//!
//! The model is asked for JSON, but a provider that ignores the instruction and
//! answers with a numbered list should still produce candidates rather than a
//! hard failure. Everything here is pure, so it is covered by unit tests and the
//! cross-stack parity harness.

use fancy_regex::Regex;
use serde_json::Value;

use crate::prompts::{system_prompt, user_prompt};
use crate::quality::{
    format_tweet_text, is_clean_tweet_text, normalize_count, post_process_tweet_text,
    score_tweet_quality,
};
use crate::types::{
    GenerateDraftCandidatesInput, GeneratedDraftCandidate, GenerationRequestError, GenerationResult,
};

const REASONING_LINE_PATTERNS: &[&str] = &[
    r"(?i)^(?:we|i) (?:must|should|need to|will|can|could)\b",
    r"(?i)^(?:let me|let's|first|next|now|okay|ok|so),?\b.{0,20}(?:write|draft|check|make|consider|think)\b",
    r"(?i)^(?:option|candidate|draft|version|variant)\s*\d*\s*[:.-]",
    r"(?i)^(?:here (?:are|is)|the following|these are)\b",
    r"(?i)\b(?:character count|char count|word count)\b",
    r"(?i)^(?:note|reasoning|analysis|plan|constraint)s?\s*[:-]",
];

/// Compile a constant pattern. A malformed literal yields `None`, which callers
/// treat as "did not match" so one bad pattern cannot abort a generation.
fn pattern(source: &str) -> Option<Regex> {
    Regex::new(source).ok()
}

fn replace_first(source: &str, text: &str, replacement: &str) -> String {
    let Some(regex) = pattern(source) else {
        return text.to_string();
    };
    match regex.try_replacen(text, 1, replacement) {
        Ok(replaced) => replaced.to_string(),
        Err(_) => text.to_string(),
    }
}

fn matches(source: &str, text: &str) -> bool {
    pattern(source).is_some_and(|regex| regex.is_match(text).unwrap_or(false))
}

fn replace_all(source: &str, text: &str, replacement: &str) -> String {
    let Some(regex) = pattern(source) else {
        return text.to_string();
    };
    match regex.try_replacen(text, 0, replacement) {
        Ok(replaced) => replaced.to_string(),
        Err(_) => text.to_string(),
    }
}

/// `asText` from TypeScript: a trimmed string, or empty for any other JSON type.
pub fn as_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.trim().to_string(),
        _ => String::new(),
    }
}

/// Parse a JSON answer into candidate strings. `None` means "not JSON we
/// understand", which makes the caller fall back to line parsing.
pub fn parse_json_candidate_texts(raw: &str, count: usize) -> Option<Vec<String>> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    let parsed: Value = serde_json::from_str(&raw[start..=end]).ok()?;
    let candidates = parsed.get("candidates")?.as_array()?;
    let texts: Vec<String> = candidates
        .iter()
        .map(|candidate| match candidate {
            Value::String(text) => text.trim().to_string(),
            other => as_text(other.get("text")),
        })
        .filter(|text| !text.is_empty())
        .take(count)
        .collect();
    Some(texts)
}

fn clean_line_candidate(line: &str) -> String {
    let without_bullet = replace_first(r#"^[-*\d.)\s"]+"#, line, "");
    let without_label = replace_first(r"(?i)^draft\s*\d+\s*:\s*", &without_bullet, "");
    without_label.trim_end_matches('"').trim().to_string()
}

fn looks_like_reasoning_line(line: &str) -> bool {
    REASONING_LINE_PATTERNS
        .iter()
        .any(|source| matches(source, line))
}

fn number_tokens_in(text: &str) -> Vec<String> {
    let without_urls = replace_all(r"(?i)https?://[^\s<>]+", text, "");
    match pattern(r"(?i)\b\d[\d,.]*(?:%|[a-z]+)?\b") {
        Some(regex) => regex
            .find_iter(&without_urls)
            .filter_map(|result| result.ok())
            .map(|found| found.as_str().to_lowercase())
            .collect(),
        None => Vec::new(),
    }
}

fn supplied_text(input: &GenerateDraftCandidatesInput) -> String {
    let mut parts: Vec<String> = vec![input.idea.clone()];
    if let Some(context) = input.context.as_ref() {
        for value in [
            context.title.as_ref(),
            context.url.as_ref(),
            context.author.as_ref(),
            context.source_name.as_ref(),
            context.summary.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            parts.push(value.clone());
        }
        parts.extend(context.facts.iter().cloned());
    }
    parts.join("\n")
}

/// A candidate may only use numbers that appear in the supplied material.
/// Invented statistics are the most common unsupported claim.
fn is_grounded_candidate(text: &str, input: &GenerateDraftCandidatesInput) -> bool {
    let supplied: Vec<String> = number_tokens_in(&supplied_text(input));
    number_tokens_in(text)
        .iter()
        .all(|token| supplied.contains(token))
}

fn strip_generated_urls(text: &str, preserve_case: bool) -> String {
    // Markdown links keep their label; bare URLs are removed outright.
    let without_links = replace_all(r"(?i)\[([^\]]+)\]\(https?://[^)\s]+\)", text, "$1");
    let without_urls = replace_all(r"(?i)https?://[^\s<>]+", &without_links, "");
    let tidied = replace_all(r"[ \t]+([,.!?;:])", &without_urls, "$1");
    if preserve_case {
        format_tweet_text(&tidied)
    } else {
        post_process_tweet_text(&tidied)
    }
}

/// Candidate strings from a raw model answer, JSON first, numbered lines second.
pub fn parse_candidate_texts(raw: &str, count: usize) -> Vec<String> {
    if let Some(parsed) = parse_json_candidate_texts(raw, count) {
        return parsed;
    }

    let Some(splitter) = pattern(r"\n+") else {
        return Vec::new();
    };
    splitter
        .split(raw)
        // `fancy-regex` yields `Result` per split chunk; an error is simply a
        // chunk we cannot split further, so it is skipped like an empty line.
        .filter_map(Result::ok)
        .filter_map(|chunk| {
            let line = clean_line_candidate(chunk);
            if line.is_empty() || looks_like_reasoning_line(&line) {
                None
            } else {
                Some(line)
            }
        })
        .take(count)
        .collect()
}

/// Post-process, deduplicate and score candidates, matching `candidatesFromText`.
pub fn candidates_from_text(
    raw: &str,
    input: &GenerateDraftCandidatesInput,
    provider_name: &str,
    model: &str,
) -> GenerationResult<Vec<GeneratedDraftCandidate>> {
    let count = normalize_count(input.count);
    let mut texts: Vec<String> = Vec::new();

    for text in parse_candidate_texts(raw, count * 2) {
        let normalized = strip_generated_urls(&text, input.preserve_case);
        if !is_clean_tweet_text(&normalized) || !is_grounded_candidate(&normalized, input) {
            continue;
        }
        let key = normalized
            .to_lowercase()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if texts.iter().any(|seen| {
            seen.to_lowercase()
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                == key
        }) {
            continue;
        }
        texts.push(normalized);
        if texts.len() == count * 2 {
            break;
        }
    }

    if texts.is_empty() {
        return Err(GenerationRequestError::invalid_response(format!(
            "{provider_name} returned no draft candidates"
        )));
    }

    Ok(texts
        .into_iter()
        .take(count)
        .enumerate()
        .map(|(index, text)| GeneratedDraftCandidate {
            quality: score_tweet_quality(&text),
            text,
            provider: provider_name.to_string(),
            model: model.to_string(),
            rank: index + 1,
        })
        .collect())
}

/// Whether an error means "the model answered, but with no usable candidates".
pub fn is_no_candidates_error(error: &GenerationRequestError, provider_name: &str) -> bool {
    error.message == format!("{provider_name} returned no draft candidates")
}

/// The full-prompt text both HTTP providers send as one message.
pub fn combined_prompt(input: &GenerateDraftCandidatesInput) -> String {
    format!("{}\n\n{}", system_prompt(input), user_prompt(input))
}
