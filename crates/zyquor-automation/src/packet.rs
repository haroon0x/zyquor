//! Deriving draft inputs from a source packet, ported from
//! `packages/automation/src/context.ts` (minus `inferTweetTypeFromText`,
//! which lives in `routing.rs`).

use zyquor_adapters::SourceItem;
use zyquor_generation::harness::{SourceTweetInput, build_source_tweet_input};
use zyquor_generation::types::TweetSourceContext;
use zyquor_storage::SourcePacket;

use crate::packet_text::{clean_sentence, truncate_text};

/// The fields drafting needs, derived from an adapter item.
#[derive(Debug, Clone, Default)]
pub struct PacketFields {
    pub title: String,
    pub summary: String,
    pub facts: Vec<String>,
}

/// Split content into sentence chunks, mirroring `.split(/(?<=[.!?])\s+/)`:
/// the whitespace run after sentence-ending punctuation is the joiner.
fn split_sentences(content: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    let mut chars = content.chars().peekable();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            let last = current.chars().last();
            if matches!(last, Some('.') | Some('!') | Some('?')) {
                sentences.push(current);
                current = String::new();
                while chars.peek().is_some_and(|c| c.is_whitespace()) {
                    chars.next();
                }
                continue;
            }
        }
        current.push(c);
    }
    if !current.is_empty() {
        sentences.push(current);
    }
    sentences
}

fn dedupe_keep_first(items: Vec<String>) -> Vec<String> {
    let mut unique: Vec<String> = Vec::new();
    for item in items {
        if !unique.contains(&item) {
            unique.push(item);
        }
    }
    unique
}

/// `packetFieldsFromItem` from `context.ts`.
pub fn packet_fields_from_item(item: &SourceItem) -> PacketFields {
    let sentences: Vec<String> = split_sentences(&item.content)
        .into_iter()
        .map(|sentence| clean_sentence(&sentence))
        .filter(|sentence| sentence.len() >= 20 && !is_url_prefix(sentence))
        .collect();
    let unique_facts: Vec<String> = dedupe_keep_first(
        std::iter::once(item.title.clone())
            .chain(sentences.clone())
            .collect(),
    )
    .into_iter()
    .map(|fact| truncate_text(&fact, 500))
    .collect();

    PacketFields {
        title: truncate_text(&item.title, 240),
        summary: truncate_text(
            sentences
                .first()
                .cloned()
                .unwrap_or_else(|| item.content.clone())
                .as_str(),
            600,
        ),
        facts: unique_facts.into_iter().take(5).collect(),
    }
}

fn is_url_prefix(sentence: &str) -> bool {
    // `/^https?:\/\//i`
    let lower = sentence.to_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

/// `packetFieldsFromFeedDigest` from `context.ts`.
pub fn packet_fields_from_feed_digest(item: &SourceItem) -> PacketFields {
    let lines: Vec<String> = item
        .content
        .split('\n')
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();
    let unique_lines = dedupe_keep_first(lines);

    PacketFields {
        title: truncate_text(&item.title, 240),
        summary: truncate_text(&unique_lines.join(" · "), 2000),
        facts: unique_lines
            .into_iter()
            .take(20)
            .map(|line| truncate_text(&line, 500))
            .collect(),
    }
}

/// Whether the packet carries enough material to draft.
pub fn has_enough_source_context(title: &str, summary: &str, facts: &[String]) -> bool {
    let title_key = clean_sentence(title).to_lowercase();
    let facts: Vec<String> = dedupe_keep_first(
        facts
            .iter()
            .map(|fact| clean_sentence(fact).to_lowercase())
            .collect(),
    )
    .into_iter()
    .filter(|fact| fact != &title_key)
    .collect();
    let summary_key = clean_sentence(summary).to_lowercase();
    facts.len() >= 2 || (summary_key.len() >= 90 && summary_key != title_key)
}

/// `articleTweetIdea` from `context.ts` — the source input a created draft
/// records for a packet.
pub(crate) fn article_tweet_idea(packet: &SourcePacket) -> String {
    let title = clean_sentence(&packet.title)
        .chars()
        .take(240)
        .collect::<String>();
    let facts: Vec<String> = dedupe_keep_first(
        packet
            .facts
            .iter()
            .map(|fact| clean_sentence(fact))
            .collect(),
    )
    .into_iter()
    .filter(|fact| !fact.is_empty() && fact.to_lowercase() != title.to_lowercase())
    .take(5)
    .map(|fact| fact.chars().take(400).collect::<String>())
    .collect();

    [
        if title.is_empty() {
            None
        } else {
            Some(format!("Title: {title}"))
        },
        packet.url.as_deref().map(|url| format!("URL: {url}")),
        Some(format!(
            "Summary: {}",
            clean_sentence(&packet.summary)
                .chars()
                .take(1200)
                .collect::<String>()
        )),
        if facts.is_empty() {
            None
        } else {
            Some(format!(
                "Facts:\n{}",
                facts
                    .iter()
                    .map(|fact| format!("- {fact}"))
                    .collect::<Vec<_>>()
                    .join("\n")
            ))
        },
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join("\n")
}

/// `sourceTweetInput` from `context.ts`: the harness context for a packet's
/// draft request. The idea it also builds is unused here — call sites use
/// the packet title directly (and the API route uses `""` with this
/// context), so only the context leaves.
pub fn source_tweet_input(packet: &SourcePacket) -> TweetSourceContext {
    let facts = packet.facts.clone();
    let topic_tags = Vec::new();
    let (_, context) = build_source_tweet_input(&SourceTweetInput {
        summary: &packet.summary,
        title: &packet.title,
        url: packet.url.as_deref(),
        source_name: None,
        published_at: None,
        engagement: None,
        topic_tags: &topic_tags,
        facts: &facts,
        source_type: Some(&packet.source_type),
    });
    context
}
