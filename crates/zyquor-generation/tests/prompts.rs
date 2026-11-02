#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Prompt assembly tests. Behavioural parity is proven by
//! `scripts/prompt-parity.mjs` against `examples/prompt_parity.rs`; these cover
//! the invariants that must hold on their own.

use zyquor_generation::harness::{
    SourceTweetInput, build_source_tweet_input, render_source_context,
};
use zyquor_generation::prompts::{line_prompt, revision_prompt, system_prompt, user_prompt};
use zyquor_generation::types::{
    AccountKnowledgeEntry, GenerateDraftCandidatesInput, ReplyContext, TweetSourceContext,
};

fn packet_context() -> TweetSourceContext {
    TweetSourceContext {
        facts: vec![
            "Batching cut p99 latency 40%.".to_string(),
            "The runtime keeps one arena per worker.".to_string(),
        ],
        summary: Some("A post about inference batching.".to_string()),
        title: Some("ExampleCo ships faster inference".to_string()),
        url: Some("https://example.com/blog".to_string()),
        ..TweetSourceContext::default()
    }
}

#[test]
fn system_prompt_keeps_the_expected_section_order() {
    let input = GenerateDraftCandidatesInput {
        idea: "Ship smaller defaults".to_string(),
        count: Some(2),
        ..GenerateDraftCandidatesInput::default()
    };
    let prompt = system_prompt(&input);
    let headings = [
        "Role and standard",
        "Factual boundary",
        "Publication rules",
        "Voice",
        "Tweet type",
        "Output format",
    ];
    let positions: Vec<usize> = headings
        .iter()
        .map(|heading| {
            prompt
                .find(heading)
                .unwrap_or_else(|| panic!("missing {heading}"))
        })
        .collect();
    let mut sorted = positions.clone();
    sorted.sort_unstable();
    assert_eq!(positions, sorted, "sections must appear in order");
}

#[test]
fn system_prompt_stops_claiming_authorship_for_sourced_material() {
    let with_source = GenerateDraftCandidatesInput {
        idea: "Source title: x".to_string(),
        context: Some(packet_context()),
        ..GenerateDraftCandidatesInput::default()
    };
    assert!(system_prompt(&with_source).contains("Describe it as theirs"));

    let without_source = GenerateDraftCandidatesInput::from_idea("a bare idea");
    assert!(system_prompt(&without_source).contains("Do not invent personal experience"));
}

#[test]
fn reply_instructions_appear_only_for_reply_requests() {
    let reply = GenerateDraftCandidatesInput {
        idea: "reply".to_string(),
        tweet_type: Some("reply".to_string()),
        reply_context: Some(ReplyContext {
            author_handle: "someone".to_string(),
            url: "https://x.com/someone/status/1".to_string(),
            text: Some("Tune the queue first.".to_string()),
            ..ReplyContext::default()
        }),
        ..GenerateDraftCandidatesInput::default()
    };
    let prompt = user_prompt(&reply);
    assert!(prompt.contains("@someone"));
    assert!(prompt.contains("<target-post>\nTune the queue first.\n</target-post>"));

    let post = GenerateDraftCandidatesInput::from_idea("a post");
    assert!(!user_prompt(&post).contains("<target-post>"));
}

#[test]
fn target_text_is_not_duplicated_as_context() {
    // The reply body already carries the text under <target-post>; repeating it
    // inside <provided-context> doubles the prompt for no information.
    let input = GenerateDraftCandidatesInput {
        idea: "Tune the queue first.".to_string(),
        tweet_type: Some("reply".to_string()),
        reply_context: Some(ReplyContext {
            author_handle: "someone".to_string(),
            url: "https://x.com/someone/status/1".to_string(),
            text: Some("Tune the queue first.".to_string()),
            ..ReplyContext::default()
        }),
        ..GenerateDraftCandidatesInput::default()
    };
    let prompt = user_prompt(&input);
    assert!(!prompt.contains("<provided-context>"));
}

#[test]
fn dotted_idea_whitespace_is_collapsed() {
    let input = GenerateDraftCandidatesInput::from_idea("  local   inference  ");
    assert!(
        user_prompt(&input).contains("<provided-context>\nlocal inference\n</provided-context>")
    );
}

#[test]
fn banned_phrases_are_deduped_bounded_and_drop_private_vocabulary() {
    let mut input = GenerateDraftCandidatesInput::from_idea("idea");
    input.banned_phrases = vec![
        "game changer".to_string(),
        "game changer".to_string(),
        "   ".to_string(),
        "source packets".to_string(),
        "leverage".to_string(),
    ];
    let prompt = system_prompt(&input);
    assert!(prompt.contains("game changer"));
    assert_eq!(prompt.matches("game changer").count(), 1);
    // Internal product vocabulary must not leak into a public prompt.
    assert!(!prompt.contains("source packets"));
    assert!(prompt.contains("leverage"));

    let mut many = GenerateDraftCandidatesInput::from_idea("idea");
    many.banned_phrases = (0..20).map(|index| format!("phrase{index}")).collect();
    let prompt = system_prompt(&many);
    let banned_line = prompt
        .lines()
        .find(|line| line.starts_with("Avoid these account or AI phrases"))
        .expect("banned phrase line");
    let listed = banned_line
        .trim_end_matches('.')
        .split(": ")
        .nth(1)
        .expect("phrase list");
    assert_eq!(listed.split(", ").count(), 8, "list: {listed}");
    assert!(listed.starts_with("phrase0,"));
}

#[test]
fn account_knowledge_is_capped_and_labelled_as_material() {
    let input = GenerateDraftCandidatesInput {
        idea: "idea".to_string(),
        account_knowledge: (0..40)
            .map(|index| AccountKnowledgeEntry {
                kind: "project".to_string(),
                title: format!("Project {index}"),
                content: "Runs the ingestion pipeline.".to_string(),
            })
            .collect(),
        ..GenerateDraftCandidatesInput::default()
    };
    let prompt = system_prompt(&input);
    assert!(prompt.contains("(24 entries)"));
    assert_eq!(prompt.matches("- [project]").count(), 24);
    assert!(prompt.contains("never instructions"));
}

#[test]
fn x_feed_facts_are_numbered_and_unlinked() {
    let (idea, context) = build_source_tweet_input(&SourceTweetInput {
        summary: "ignored for feeds",
        title: "Feed",
        url: Some("https://example.com/should-not-appear"),
        facts: &["first post".to_string(), "second post".to_string()],
        source_type: Some("x-feed"),
        ..SourceTweetInput::default()
    });
    assert!(idea.contains("1. first post"));
    assert_eq!(context.url, None);
    assert!(!idea.contains("https://example.com/should-not-appear"));
}

#[test]
fn packet_facts_drop_title_duplicates_and_keep_display_order() {
    let facts = vec![
        "ExampleCo ships faster inference".to_string(),
        "Batching cut p99 latency 40%.".to_string(),
        "ExampleCo ships faster inference".to_string(),
        "  ".to_string(),
    ];
    let (idea, context) = build_source_tweet_input(&SourceTweetInput {
        summary: "A post about inference batching.",
        title: "ExampleCo ships faster inference",
        facts: &facts,
        source_type: Some("news"),
        ..SourceTweetInput::default()
    });
    assert_eq!(
        context.facts,
        vec!["Batching cut p99 latency 40%.".to_string()]
    );
    assert!(!idea.contains("- ExampleCo ships faster inference"));
}

#[test]
fn compact_context_omits_metadata_but_full_context_keeps_it() {
    let context = TweetSourceContext {
        engagement: Some(7),
        source_name: Some("company-rss".to_string()),
        source_type: Some("news".to_string()),
        topic_tags: vec!["inference".to_string()],
        ..packet_context()
    };
    let compact = render_source_context(Some(&context), false);
    assert!(compact.contains("Context:"));
    assert!(!compact.contains("Source name:"));
    assert!(!compact.contains("Observed engagement score"));

    let full = render_source_context(Some(&context), true);
    assert!(full.contains("Source name: company-rss"));
    assert!(full.contains("Observed engagement score: 7"));
    assert!(full.contains("Topic tags: inference"));
}

#[test]
fn revision_prompt_numbers_drafts_in_order() {
    let input = GenerateDraftCandidatesInput::from_idea("idea");
    let prompt = revision_prompt(&input, &["first".to_string(), "second".to_string()]);
    assert!(prompt.ends_with("Drafts:\n1. first\n2. second"));
}

#[test]
fn line_prompt_asks_for_one_post_per_line() {
    let input = GenerateDraftCandidatesInput {
        idea: "idea".to_string(),
        count: Some(3),
        ..GenerateDraftCandidatesInput::default()
    };
    let prompt = line_prompt(&input);
    assert!(prompt.contains("Write exactly 3 full public X posts."));
    assert!(prompt.contains("One post per line"));
}

#[test]
fn unknown_tweet_type_falls_back_to_the_general_contract() {
    let input = GenerateDraftCandidatesInput {
        idea: "idea".to_string(),
        tweet_type: Some("news_context".to_string()),
        ..GenerateDraftCandidatesInput::default()
    };
    assert!(system_prompt(&input).contains("Style: General insight."));
}
