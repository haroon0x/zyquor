//! Prompt parity harness: rebuilds the same nine requests as
//! `scripts/prompt-parity.ts` and prints the prompts the Rust port produces.
//!
//! Run both and diff the JSON:
//!   node --experimental-strip-types scripts/prompt-parity.ts > /tmp/ts.json
//!   cargo run -p zyquor-generation --example prompt_parity > /tmp/rs.json
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use zyquor_generation::prompts::{line_prompt, revision_prompt, system_prompt, user_prompt};
use zyquor_generation::types::{
    AccountKnowledgeEntry, GenerateDraftCandidatesInput, ReplyContext, TweetSourceContext,
};

#[allow(clippy::too_many_arguments)]
fn context(
    title: &str,
    url: Option<&str>,
    summary: &str,
    facts: &[&str],
    source_name: Option<&str>,
    source_type: Option<&str>,
    published_at: Option<&str>,
    engagement: Option<i64>,
    topic_tags: &[&str],
) -> TweetSourceContext {
    TweetSourceContext {
        author: None,
        engagement,
        facts: facts.iter().map(|fact| (*fact).to_string()).collect(),
        published_at: published_at.map(str::to_string),
        source_name: source_name.map(str::to_string),
        source_type: source_type.map(str::to_string),
        summary: Some(summary.to_string()),
        title: Some(title.to_string()),
        topic_tags: topic_tags.iter().map(|tag| (*tag).to_string()).collect(),
        url: url.map(str::to_string),
    }
}

fn cases() -> Vec<(&'static str, GenerateDraftCandidatesInput)> {
    vec![
        (
            "plain_idea",
            GenerateDraftCandidatesInput {
                idea: "  local   inference changes the cost curve  ".to_string(),
                count: Some(2),
                ..GenerateDraftCandidatesInput::default()
            },
        ),
        (
            "packet_useful_info",
            GenerateDraftCandidatesInput {
                idea: "Source title: ExampleCo ships faster inference".to_string(),
                count: Some(3),
                context: Some(context(
                    "ExampleCo ships faster inference",
                    Some("https://example.com/blog/inference"),
                    "ExampleCo cut inference latency by batching across requests.",
                    &[
                        "ExampleCo ships a faster inference runtime.",
                        "Batching across requests cut p99 latency 40%.",
                        "ExampleCo ships a faster inference runtime.",
                    ],
                    Some("company-rss"),
                    Some("news"),
                    Some("2026-10-01T10:00:00.000Z"),
                    Some(42),
                    &["inference", "latency"],
                )),
                tweet_type: Some("useful_info".to_string()),
                ..GenerateDraftCandidatesInput::default()
            },
        ),
        (
            "reply_with_target",
            GenerateDraftCandidatesInput {
                idea: "Reply to the thread".to_string(),
                count: Some(1),
                tweet_type: Some("reply".to_string()),
                reply_context: Some(ReplyContext {
                    author_handle: "someone".to_string(),
                    url: "https://x.com/someone/status/1".to_string(),
                    author_name: Some("Some One".to_string()),
                    text: Some("Most teams tune the model before the queue.".to_string()),
                    other_replies: vec![
                        "Agreed, the queue dominates.".to_string(),
                        "This matches our load tests.".to_string(),
                    ],
                }),
                ..GenerateDraftCandidatesInput::default()
            },
        ),
        (
            "full_voice",
            GenerateDraftCandidatesInput {
                idea: "Ship smaller defaults".to_string(),
                count: Some(4),
                tweet_type: Some("opinion".to_string()),
                example_posts: vec![
                    "One real post about caching.\nSecond line.".to_string(),
                    "Another example post.".to_string(),
                ],
                system_prompt_extra: Some(
                    "Examples:\nWrite like a tired infra engineer.".to_string(),
                ),
                tone: Some("dry, practical".to_string()),
                objective: Some("Make operators question their default timeouts".to_string()),
                recent_post_history: vec![
                    "A post about connection pools that went long enough to be truncated here"
                        .to_string(),
                    "Short one".to_string(),
                ],
                system_feedback: vec![
                    "Never open with a question.".to_string(),
                    "Cut adverbs.".to_string(),
                ],
                banned_phrases: vec![
                    "game changer".to_string(),
                    "  ".to_string(),
                    "unlock".to_string(),
                ],
                ..GenerateDraftCandidatesInput::default()
            },
        ),
        (
            "knowledge_and_memory",
            GenerateDraftCandidatesInput {
                idea: "Why we moved off the queue".to_string(),
                count: Some(2),
                memory_context: Some(
                    "I ran a 3-node cluster in 2021 and lost a week to fsync.".to_string(),
                ),
                feedback: Some("Too long last time; keep it under 240.".to_string()),
                account_knowledge: vec![
                    AccountKnowledgeEntry {
                        kind: "project".to_string(),
                        title: "Queue".to_string(),
                        content: "We replaced RabbitMQ with NATS in 2024.".to_string(),
                    },
                    AccountKnowledgeEntry {
                        kind: "role".to_string(),
                        title: "Owner".to_string(),
                        content: "Runs the ingestion pipeline.".to_string(),
                    },
                ],
                ..GenerateDraftCandidatesInput::default()
            },
        ),
        (
            "x_feed",
            GenerateDraftCandidatesInput {
                idea: "Recent posts from the X home feed.".to_string(),
                count: Some(2),
                tweet_type: Some("feed_observation".to_string()),
                context: Some(context(
                    "Feed",
                    None,
                    "",
                    &[
                        "post about quantization",
                        "post about local runners",
                        "post about quantization",
                    ],
                    None,
                    Some("x-feed"),
                    None,
                    None,
                    &[],
                )),
                ..GenerateDraftCandidatesInput::default()
            },
        ),
        (
            "job_packet",
            GenerateDraftCandidatesInput {
                idea: "Hiring post".to_string(),
                count: Some(1),
                context: Some(context(
                    "ExampleCo is hiring infra engineers",
                    Some("https://example.com/jobs"),
                    "Remote infra role.",
                    &["Remote", "Go and Rust"],
                    None,
                    Some("job"),
                    None,
                    None,
                    &[],
                )),
                ..GenerateDraftCandidatesInput::default()
            },
        ),
        (
            "single_count",
            GenerateDraftCandidatesInput {
                idea: "One thought only".to_string(),
                tweet_type: Some("guide".to_string()),
                count: Some(1),
                ..GenerateDraftCandidatesInput::default()
            },
        ),
    ]
}

fn main() {
    let drafts = [
        "first draft text".to_string(),
        "second draft text".to_string(),
    ];
    let mut out = serde_json::Map::new();
    for (name, input) in cases() {
        let mut entry = serde_json::Map::new();
        entry.insert("system".into(), system_prompt(&input).into());
        entry.insert("user".into(), user_prompt(&input).into());
        entry.insert("line".into(), line_prompt(&input).into());
        entry.insert("revision".into(), revision_prompt(&input, &drafts).into());
        out.insert(name.into(), serde_json::Value::Object(entry));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::Value::Object(out)).unwrap()
    );
}
