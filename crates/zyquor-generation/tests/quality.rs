#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Behavioural tests for the quality port. Values were cross-checked against
//! the TypeScript implementation with the parity harness.

use std::collections::HashMap;

use zyquor_generation::{
    DEFAULT_QUALITY_MIN, DEFAULT_REPLY_QUALITY_MIN, format_tweet_text, is_clean_tweet_text,
    is_interrogation_dodge_reply, passes_tweet_quality_floor, post_process_tweet_text,
    quality_minimum, reply_quality_minimum, score_tweet_quality,
};

#[test]
fn rewards_concrete_technical_posts() {
    let text = "Shipped a 40-line change to the router that cut p95 latency from 900ms to 210ms because we stopped re-parsing the config.";
    assert!(
        score_tweet_quality(text) >= 8,
        "score {}",
        score_tweet_quality(text)
    );
    assert!(is_clean_tweet_text(text));
}

#[test]
fn punishes_recaps_and_slop() {
    let recap = "Researchers released a new database today. The impact is huge.";
    assert!(score_tweet_quality(recap) < 0);
    assert!(!is_clean_tweet_text(recap));

    assert!(!is_clean_tweet_text(
        "Let's dive in! This is a game changer that will unlock the power of AI."
    ));
}

#[test]
fn rejects_internal_leaks_and_incomplete_text() {
    assert!(!is_clean_tweet_text(
        "Derived from the source context, the model is great."
    ));
    assert!(!is_clean_tweet_text(
        "The compiler now emits fewer instructions..."
    ));
    assert!(!is_clean_tweet_text("This one ends with a colon:"));
}

#[test]
fn detects_third_party_changelog_dumps_but_not_first_person_work() {
    let third_party = "The 2.0.3 release adds embed_multi() and self.key which changes the index.";
    assert!(score_tweet_quality(third_party) <= 2);

    let first_person =
        "v2.4 of my agent framework ships a new endpoint, but I only tested 3 of them.";
    assert!(score_tweet_quality(first_person) >= 8);
}

#[test]
fn detects_interrogation_dodge_replies() {
    assert!(is_interrogation_dodge_reply(
        "Explain how the router picks a shard."
    ));
    assert!(is_interrogation_dodge_reply(
        "\"Show me the benchmark numbers."
    ));
    assert!(!is_interrogation_dodge_reply(
        "The router picks a shard by hashing the key."
    ));
}

#[test]
fn formatting_preserves_urls_and_normalises_dashes() {
    let input = "Read more at https://example.com/a — it explains the 5% regression.";
    let formatted = format_tweet_text(input);
    assert!(formatted.contains("https://example.com/a"));
    assert!(formatted.contains(", it explains"));
    assert!(!formatted.contains('—'));
}

#[test]
fn post_processing_lowercases_and_strips_source_tags() {
    let input = "<source-title>Breaking</source-title> The API Now Returns 204.";
    let processed = post_process_tweet_text(input);
    assert!(!processed.contains("source-title"));
    assert_eq!(processed, "breaking the api now returns 204.");

    let formatted = format_tweet_text("The API Now Returns 204.");
    assert_eq!(formatted, "The API Now Returns 204.");
}

#[test]
fn quality_floor_combines_cleanliness_and_score() {
    let good = "We replaced the whole queue with a single mutex because the throughput was 4x better under load.";
    assert!(passes_tweet_quality_floor(good, DEFAULT_QUALITY_MIN));

    let slop = "We are thrilled to announce our journey to leverage synergy across teams.";
    assert!(!passes_tweet_quality_floor(slop, DEFAULT_QUALITY_MIN));
}

#[test]
fn minimums_read_from_the_environment_and_clamp_to_zero_ten() {
    assert_eq!(quality_minimum(&|_| None), DEFAULT_QUALITY_MIN);
    assert_eq!(reply_quality_minimum(&|_| None), DEFAULT_REPLY_QUALITY_MIN);

    let high = HashMap::from([("ZYQUOR_QUALITY_MIN", "42")]);
    let lookup = |key: &str| high.get(key).map(|value| (*value).to_string());
    assert_eq!(quality_minimum(&lookup), 10.0);

    let negative = HashMap::from([("ZYQUOR_REPLY_QUALITY_MIN", "-3")]);
    let lookup = |key: &str| negative.get(key).map(|value| (*value).to_string());
    assert_eq!(reply_quality_minimum(&lookup), 0.0);

    let garbage = HashMap::from([("ZYQUOR_QUALITY_MIN", "not-a-number")]);
    let lookup = |key: &str| garbage.get(key).map(|value| (*value).to_string());
    assert_eq!(quality_minimum(&lookup), DEFAULT_QUALITY_MIN);
}
