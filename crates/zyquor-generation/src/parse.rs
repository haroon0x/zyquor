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

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    //! Fixtures derived from the retired TypeScript parser. `parse.test.ts`
    //! never existed: the functions live at the tail of
    //! `packages/generation/src/quality.ts`, so each expectation below is read
    //! off that implementation (`git show 7ebbe9c^:packages/generation/src/quality.ts`).

    use serde_json::json;

    use super::*;

    fn input(idea: &str) -> GenerateDraftCandidatesInput {
        GenerateDraftCandidatesInput::from_idea(idea)
    }

    // --- parse_candidate_texts: JSON shapes ---------------------------

    #[test]
    fn parses_a_json_object_with_text_and_string_candidates() {
        let raw = r#"{"candidates":[{"text":"Queue drains in batches, so tail latency tracks the batch boundary."},"A cluster keeps one write path because the catalog format changed."]}"#;

        assert_eq!(
            parse_json_candidate_texts(raw, 2).unwrap(),
            vec![
                "Queue drains in batches, so tail latency tracks the batch boundary.".to_string(),
                "A cluster keeps one write path because the catalog format changed.".to_string(),
            ]
        );
        // `count` truncates after filtering empty candidates.
        assert_eq!(parse_candidate_texts(raw, 1).len(), 1);
    }

    #[test]
    fn parses_a_fenced_json_block_wrapped_in_prose() {
        let raw = "Sure, here is the payload:\n```json\n{\"candidates\":[{\"text\":\"Queue drains in batches, so tail latency tracks the batch boundary.\"},{\"text\":\"A cluster keeps one write path because the catalog format changed.\"}]}\n```\n";

        let parsed = parse_candidate_texts(raw, 2);
        assert_eq!(parsed.len(), 2);
        assert_eq!(
            parsed[0],
            "Queue drains in batches, so tail latency tracks the batch boundary."
        );
        assert_eq!(
            parsed[1],
            "A cluster keeps one write path because the catalog format changed."
        );
    }

    #[test]
    fn a_bare_json_array_is_not_a_candidates_payload() {
        // TypeScript slices from the first `{` to the last `}`, so a bare array
        // never reaches JSON.parse; it falls through to line parsing as raw text.
        let raw = r#"["one", "two"]"#;
        assert!(parse_json_candidate_texts(raw, 2).is_none());
        assert_eq!(
            parse_candidate_texts(raw, 2),
            vec![r#"["one", "two"]"#.to_string()]
        );
    }

    #[test]
    fn a_json_object_without_candidates_falls_back_to_line_parsing() {
        assert!(parse_json_candidate_texts(r#"{"text":"not a candidates payload"}"#, 2).is_none());
        assert_eq!(
            parse_candidate_texts(r#"{"text":"not a candidates payload"}"#, 2),
            vec![r#"{"text":"not a candidates payload"}"#.to_string()]
        );
    }

    // --- parse_candidate_texts: plain-text fallback ------------------

    #[test]
    fn parses_numbered_and_bulleted_plain_text_candidates() {
        let raw = "Here are three options:\n1. Queue drains in batches, so tail latency tracks the batch boundary.\n2. A cluster keeps one write path because the catalog format changed.\n- Draft 2: The upgrade stops at the version gate because the catalog format changed.";

        assert_eq!(
            parse_candidate_texts(raw, 5),
            vec![
                "Queue drains in batches, so tail latency tracks the batch boundary.".to_string(),
                "A cluster keeps one write path because the catalog format changed.".to_string(),
                // The leading bullet and the `Draft 2:` label are both stripped.
                "The upgrade stops at the version gate because the catalog format changed."
                    .to_string(),
            ]
        );
    }

    #[test]
    fn filters_reasoning_lines_from_the_plain_text_fallback() {
        // Each line matches one of the TS `REASONING_LINE_PATTERNS`; only the
        // real candidate survives.
        let raw = "Let me write a few options for you.\nOption 2: shorter and more concrete.\nNote: keep it under 280 characters.\nQueue drains in batches, so tail latency tracks the batch boundary.";

        assert_eq!(
            parse_candidate_texts(raw, 5),
            vec!["Queue drains in batches, so tail latency tracks the batch boundary.".to_string()]
        );
    }

    // --- as_text ------------------------------------------------------

    #[test]
    fn as_text_trims_strings_and_empties_other_json_types() {
        assert_eq!(as_text(Some(&json!("  trimmed  "))), "trimmed");
        assert_eq!(as_text(None), "");
        assert_eq!(as_text(Some(&Value::Null)), "");
        assert_eq!(as_text(Some(&json!(42))), "");
        assert_eq!(as_text(Some(&json!(false))), "");
        assert_eq!(as_text(Some(&json!(["a"]))), "");
        assert_eq!(as_text(Some(&json!({"text":"nested"}))), "");
    }

    // --- grounding and URL handling ----------------------------------

    #[test]
    fn grounding_requires_numbers_to_appear_in_the_input() {
        let request = input(
            "Our router cut p95 latency from 900ms to 210ms after removing the config parse.",
        );

        assert!(is_grounded_candidate(
            "The router cut p95 latency from 900ms to 210ms because the config parse was removed.",
            &request
        ));
        assert!(!is_grounded_candidate(
            "The router cut p95 latency by 42% because the config parse was removed.",
            &request
        ));
    }

    #[test]
    fn strip_generated_urls_keeps_markdown_labels_and_removes_bare_urls() {
        assert_eq!(
            strip_generated_urls("Read [the benchmark](https://example.com/a) now", true),
            "Read the benchmark now"
        );
        assert_eq!(
            strip_generated_urls(
                "Read the benchmark at https://example.com/a before changing the queue",
                true
            ),
            "Read the benchmark at before changing the queue"
        );
        // Space before punctuation is tidied after the URL is removed.
        assert_eq!(
            strip_generated_urls("See https://example.com/a , then decide", true),
            "See, then decide"
        );
        // `preserve_case = false` runs the normal lowercase post-processing.
        assert_eq!(
            strip_generated_urls("Read [The Benchmark](https://example.com/a) Now", false),
            "read the benchmark now"
        );
    }

    // --- candidates_from_text ----------------------------------------

    #[test]
    fn candidates_from_text_strips_urls_before_screening() {
        let request = input("Read the benchmark before changing the queue depth.");
        let raw = r#"{"candidates":[{"text":"Read [the benchmark](https://example.com/latency) before changing the queue depth."}]}"#;

        let candidates = candidates_from_text(raw, &request, "opencode", "glm-5.3-flash-free")
            .expect("a stripped candidate is still usable");
        assert_eq!(
            candidates[0].text,
            "read the benchmark before changing the queue depth."
        );
        assert!(!candidates[0].text.contains("http"));
    }

    #[test]
    fn candidates_from_text_scores_ranks_and_dedupes() {
        let request = GenerateDraftCandidatesInput {
            count: Some(2),
            ..input("A queue drains in batches and the tail latency tracks the batch boundary.")
        };
        let raw = r#"{"candidates":[
            {"text":"Queue drains in batches, so tail latency tracks the batch boundary."},
            {"text":"Queue drains in batches, so tail latency tracks the batch boundary."},
            {"text":"The batch boundary moves the tail latency because every drain waits."}
        ]}"#;

        let candidates = candidates_from_text(raw, &request, "opencode", "glm-5.3-flash-free")
            .expect("two clean candidates survive");
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].rank, 1);
        assert_eq!(candidates[1].rank, 2);
        assert_eq!(candidates[0].provider, "opencode");
        assert_eq!(candidates[0].model, "glm-5.3-flash-free");
        assert_eq!(
            candidates[0].quality,
            score_tweet_quality(&candidates[0].text)
        );
        assert_eq!(
            candidates[0].text,
            "queue drains in batches, so tail latency tracks the batch boundary."
        );
        assert_eq!(
            candidates[1].text,
            "the batch boundary moves the tail latency because every drain waits."
        );
    }

    #[test]
    fn candidates_from_text_with_no_clean_candidates_reports_the_ts_error() {
        let request = input("A queue drains in batches.");
        // Every line is a reasoning line, so the fallback yields nothing.
        let raw = "I should draft a few options, but the provider returned nothing usable.";

        let error = candidates_from_text(raw, &request, "opencode", "glm-5.3-flash-free")
            .expect_err("no candidates must be an error");
        assert_eq!(error.message, "opencode returned no draft candidates");
        assert!(is_no_candidates_error(&error, "opencode"));
        assert!(!is_no_candidates_error(&error, "gemini"));
    }

    #[test]
    fn candidates_from_text_rejects_ungrounded_numbers() {
        let request = input("Our router cut p95 latency from 900ms to 210ms.");
        let raw = r#"{"candidates":[{"text":"Our router cut p95 latency by 42% after the config parse was removed."}]}"#;

        let error = candidates_from_text(raw, &request, "opencode", "glm-5.3-flash-free")
            .expect_err("an invented number must be filtered");
        assert!(is_no_candidates_error(&error, "opencode"));
    }
}
