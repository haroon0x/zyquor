//! Source performance + post-feature attribution, ported from
//! `packages/automation/src/performance.ts` and `analyzePostFeatures` from
//! `quality.ts`.

use std::collections::HashMap;

use zyquor_core::post_performance_from_metadata;
use zyquor_storage::{PostHistory, SqliteRepository, StorageError};

#[derive(Debug, Clone, Default)]
pub struct SourcePerformance {
    pub source_type: String,
    pub posts: usize,
    pub engagement_per_post: f64,
    pub views_avg: f64,
}

const REPLY_WEIGHT: f64 = 10.0;
const REPOST_WEIGHT: f64 = 2.0;

/// Engagement-per-post over the performance triple; `entities` counted as
/// units (reply 10×, repost 2×, like 1×) normalized by post count.
pub fn engagement_per_post_of(likes: f64, replies: f64, reposts: f64, posts: usize) -> f64 {
    if posts == 0 {
        return 0.0;
    }
    let units = likes + REPLY_WEIGHT * replies + REPOST_WEIGHT * reposts;
    units / posts as f64
}

/// Per-source-type engagement aggregates over the post history with
/// performance metadata.
pub fn source_performance_by_type(
    repository: &SqliteRepository,
) -> Result<HashMap<String, SourcePerformance>, StorageError> {
    let history = repository.list_post_history()?;
    Ok(source_performance_from_history(&history))
}

pub(crate) fn source_performance_from_history(
    history: &[PostHistory],
) -> HashMap<String, SourcePerformance> {
    #[derive(Default)]
    struct Totals {
        posts: usize,
        likes: i64,
        replies: i64,
        reposts: i64,
        views: i64,
    }

    let mut totals: HashMap<String, Totals> = HashMap::new();
    for item in history {
        let Some(source_type) = item.source_type.as_deref() else {
            continue;
        };
        let Some(performance) = post_performance_from_metadata(&item.metadata) else {
            continue;
        };
        let total = totals.entry(source_type.to_string()).or_default();
        total.posts += 1;
        total.likes += performance.likes.unwrap_or(0);
        total.replies += performance.replies.unwrap_or(0);
        total.reposts += performance.reposts.unwrap_or(0);
        total.views += performance.views.unwrap_or(0);
    }

    totals
        .into_iter()
        .map(|(source_type, total)| {
            let engagement_per_post = engagement_per_post_of(
                total.likes as f64,
                total.replies as f64,
                total.reposts as f64,
                total.posts,
            );
            let views_avg = if total.posts > 0 {
                total.views as f64 / total.posts as f64
            } else {
                0.0
            };
            (
                source_type.clone(),
                SourcePerformance {
                    source_type,
                    posts: total.posts,
                    engagement_per_post,
                    views_avg,
                },
            )
        })
        .collect()
}

/// Stylistic and structural features of a post, recorded on every approval
/// so later performance analysis compares FEATURES against outcomes.
#[derive(Debug, Clone, Default)]
pub struct PostFeatures {
    pub chars: usize,
    pub words: usize,
    pub has_digits: bool,
    pub ends_with_question: bool,
    pub link_count: usize,
    pub hashtag_count: usize,
    pub opener: String,
}

pub fn analyze_post_features(text: &str) -> PostFeatures {
    let trimmed = text.trim();
    let words: Vec<&str> = trimmed.split_whitespace().collect();
    PostFeatures {
        chars: trimmed.chars().count(),
        words: words.len(),
        has_digits: trimmed.chars().any(|c| c.is_ascii_digit()),
        ends_with_question: trimmed.ends_with('?'),
        link_count: trimmed.match_indices("http://").count()
            + trimmed.match_indices("https://").count(),
        hashtag_count: {
            // `/#\w+/g` — block matches, not whitespace-delimited words.
            let mut count = 0_usize;
            let bytes = trimmed.as_bytes();
            let mut index = 0_usize;
            while index < bytes.len() {
                let c = bytes[index] as char;
                if c == '#' && index + 1 < bytes.len() {
                    let mut end = index + 1;
                    while end < bytes.len() {
                        let b = bytes[end];
                        if b.is_ascii_alphanumeric() || b == b'_' {
                            end += 1;
                        } else {
                            break;
                        }
                    }
                    if end > index + 1 {
                        count += 1;
                    }
                    index = end;
                } else {
                    index += 1;
                }
            }
            count
        },
        opener: words
            .iter()
            .take(3)
            .map(|word| word.to_lowercase())
            .collect::<Vec<_>>()
            .join(" "),
    }
}
