//! Source context rendering, ported from `packages/generation/src/harness.ts`.
//!
//! These are the strings the prompt is built from, so they are tested against
//! the TypeScript output rather than eyeballed.

use crate::types::TweetSourceContext;

/// Collapse internal whitespace the way the TypeScript `compact` helper does.
pub fn compact(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Take at most `max` UTF-16 code units, matching JavaScript's `slice`.
///
/// A cut through a surrogate pair degrades to the replacement character, which
/// only differs from JS for astral-plane input at an exact boundary.
fn slice_utf16(value: &str, max: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().take(max).collect();
    String::from_utf16_lossy(&units)
}

/// Render the context block used inside the prompt, matching
/// `renderSourceContext`.
///
/// `include_metadata = false` produces the compact form the prompt builder
/// embeds; the full form lists provenance and is used by harnesses and logs.
pub fn render_source_context(
    source: Option<&TweetSourceContext>,
    include_metadata: bool,
) -> String {
    let Some(source) = source else {
        return String::new();
    };

    let mut lines: Vec<String> = Vec::new();

    if include_metadata {
        if let Some(name) = source.source_name.as_deref() {
            lines.push(format!("Source name: {name}"));
        }
        if let Some(kind) = source.source_type.as_deref() {
            lines.push(format!("Source type: {kind}"));
        }
        if let Some(title) = source.title.as_deref() {
            lines.push(format!("Source title: {title}"));
        }
        if let Some(url) = source.url.as_deref() {
            lines.push(format!("Source URL: {url}"));
        }
        if let Some(author) = source.author.as_deref() {
            lines.push(format!("Author: {author}"));
        }
        if let Some(published) = source.published_at.as_deref() {
            lines.push(format!("Published: {published}"));
        }
        if !source.is_x_feed()
            && let Some(summary) = source.summary.as_deref()
        {
            lines.push(format!("Source summary: {summary}"));
        }
        if let Some(engagement) = source.engagement {
            lines.push(format!("Observed engagement score: {engagement}"));
        }
        if !source.topic_tags.is_empty() {
            lines.push(format!("Topic tags: {}", source.topic_tags.join(", ")));
        }
        if !source.facts.is_empty() {
            // Feed facts are numbered (one per post); packet facts are bullets.
            let rendered = source
                .facts
                .iter()
                .enumerate()
                .map(|(index, fact)| {
                    if source.is_x_feed() {
                        format!("{}. {fact}", index + 1)
                    } else {
                        format!("- {fact}")
                    }
                })
                .collect::<Vec<_>>()
                .join("\n");
            lines.push(format!("Grounded facts:\n{rendered}"));
        }
        return if lines.is_empty() {
            String::new()
        } else {
            format!("\n\nSource context:\n{}", lines.join("\n"))
        };
    }

    if let Some(title) = source.title.as_deref() {
        lines.push(format!("Title: {}", slice_utf16(&compact(title), 240)));
    }
    if let Some(url) = source.url.as_deref() {
        lines.push(format!("URL: {url}"));
    }
    if !source.is_x_feed()
        && let Some(summary) = source.summary.as_deref()
    {
        lines.push(format!("Summary: {}", slice_utf16(&compact(summary), 1200)));
    }
    if !source.facts.is_empty() {
        let rendered = source
            .facts
            .iter()
            .take(5)
            .map(|fact| format!("- {}", slice_utf16(&compact(fact), 400)))
            .collect::<Vec<_>>()
            .join("\n");
        lines.push(format!("Facts:\n{rendered}"));
    }

    if lines.is_empty() {
        String::new()
    } else {
        format!("\n\nContext:\n{}", lines.join("\n"))
    }
}

/// Build prompt input from a bare idea, matching `buildIdeaTweetInput`.
pub fn build_idea_tweet_input(idea: &str) -> String {
    compact(idea)
}

/// The raw fields a source packet contributes to a draft request.
#[derive(Debug, Clone, Default)]
pub struct SourceTweetInput<'a> {
    pub summary: &'a str,
    pub title: &'a str,
    pub url: Option<&'a str>,
    pub source_name: Option<&'a str>,
    pub published_at: Option<&'a str>,
    pub engagement: Option<i64>,
    pub topic_tags: &'a [String],
    pub facts: &'a [String],
    pub source_type: Option<&'a str>,
}

/// Build prompt input from a source packet, matching `buildSourceTweetInput`.
///
/// Returns the prompt idea text plus the context the prompt renders.
pub fn build_source_tweet_input(input: &SourceTweetInput<'_>) -> (String, TweetSourceContext) {
    let summary = input.summary;
    let title = input.title;
    let url = input.url;
    let source_name = input.source_name;
    let published_at = input.published_at;
    let engagement = input.engagement;
    let topic_tags = input.topic_tags;
    let facts = input.facts;
    let source_type = input.source_type;

    let compact_title = compact(title);
    let title_key = compact_title.to_lowercase();
    let is_x_feed = source_type == Some("x-feed");
    let limit = if is_x_feed { 20 } else { 5 };

    let mut kept_facts: Vec<String> = Vec::new();
    for fact in facts {
        let fact = compact(fact);
        if fact.is_empty() {
            continue;
        }
        // The title is already shown separately, so repeating it as a fact
        // wastes context. Feed posts are exempt: the title *is* the post.
        if !is_x_feed && fact.to_lowercase() == title_key {
            continue;
        }
        if !kept_facts.contains(&fact) {
            kept_facts.push(fact);
        }
        if kept_facts.len() == limit {
            break;
        }
    }

    let mut parts: Vec<String> = Vec::new();
    if is_x_feed {
        let numbered = kept_facts
            .iter()
            .enumerate()
            .map(|(index, fact)| format!("{}. {fact}", index + 1))
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(format!(
            "Recent posts from the X home feed. Each numbered line is a separate post:\n{numbered}"
        ));
    } else if source_type == Some("job") {
        parts.push(format!("Hiring post: {compact_title}"));
    } else {
        parts.push(format!("Source title: {compact_title}"));
    }

    if !is_x_feed && let Some(url) = url {
        parts.push(format!(
            "Required source link: <source-url>{url}</source-url>"
        ));
    }
    if !is_x_feed {
        parts.push(format!("Known summary: {}", compact(summary)));
    }
    if !is_x_feed && !kept_facts.is_empty() {
        let rendered = kept_facts
            .iter()
            .map(|fact| format!("- {fact}"))
            .collect::<Vec<_>>()
            .join("\n");
        parts.push(format!("Verified facts:\n{rendered}"));
    }
    parts.push(
        if is_x_feed {
            "Write a clean standalone observation based on these posts. Do not quote, name, or link any specific post or author; the post must make sense on its own with no reference at all."
        } else {
            "Write a clean standalone tweet from this context. Do not include the source link in the post body; the system appends the exact link at the end; reference at least one concrete fact above. Never paste the source title into the post."
        }
        .to_string(),
    );

    let context = TweetSourceContext {
        engagement,
        facts: kept_facts,
        published_at: published_at.map(str::to_string),
        source_name: source_name.map(str::to_string),
        source_type: source_type.map(str::to_string),
        summary: Some(compact(summary)),
        title: Some(compact_title),
        topic_tags: topic_tags.to_vec(),
        url: if is_x_feed {
            None
        } else {
            url.map(str::to_string)
        },
        ..TweetSourceContext::default()
    };

    (parts.join("\n"), context)
}
