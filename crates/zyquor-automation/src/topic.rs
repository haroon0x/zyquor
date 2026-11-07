//! Topic identity for deduplication, ported from
//! `packages/automation/src/topic.ts`.

use std::collections::HashSet;

const GENERIC_TOPIC_WORDS: &[&str] = &[
    "about", "after", "agent", "agents", "built", "code", "data", "from", "github", "guide",
    "into", "model", "news", "open", "platform", "repo", "show", "source", "system", "that",
    "this", "tool", "using", "with",
];

/// Distinctive word set of a title, in first-seen order (a `Set` in JS).
pub fn topic_words(value: &str) -> Vec<String> {
    let lowered = value.to_lowercase();
    let cleaned = lowered
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect::<String>();
    let generic: HashSet<&str> = GENERIC_TOPIC_WORDS.iter().copied().collect();
    let mut words: Vec<String> = Vec::new();
    for word in cleaned
        .split_whitespace()
        .map(|word| word.trim_matches('-'))
        .filter(|word| word.len() >= 4 && !generic.contains(word))
        .take(12)
    {
        let owned = word.to_string();
        if !words.contains(&owned) {
            words.push(owned);
        }
    }
    words
}

/// Whether `title` overlaps any of `recent_titles` on 3+ distinctive words.
pub fn has_topic_overlap(title: &str, recent_titles: &[String]) -> bool {
    let current = topic_words(title);
    if current.is_empty() {
        return false;
    }
    recent_titles.iter().any(|recent| {
        let recent_words = topic_words(recent);
        current
            .iter()
            .filter(|word| recent_words.contains(word))
            .count()
            >= 3
    })
}
