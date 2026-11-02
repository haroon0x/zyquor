//! Domain enums and constant lists, ported from `packages/core/src/index.ts`.
//!
//! Wire values are the snake_case strings the TypeScript implementation and
//! the persisted data already use.

use serde::{Deserialize, Serialize};

macro_rules! string_enum {
    ($name:ident, $($variant:ident => $value:literal),+ $(,)?) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        pub enum $name {
            $(
                #[serde(rename = $value)]
                $variant,
            )+
        }

        impl $name {
            pub const ALL: &'static [Self] = &[$(Self::$variant),+];

            pub const fn as_str(self) -> &'static str {
                match self {
                    $(Self::$variant => $value,)+
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl std::str::FromStr for $name {
            type Err = String;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                match value {
                    $($value => Ok(Self::$variant),)+
                    other => Err(format!(
                        "invalid {} value: {other}",
                        stringify!($name)
                    )),
                }
            }
        }
    };
}

string_enum!(PostingMode,
    DraftOnly => "draft_only",
    PrepareOnly => "prepare_only",
    ReviewRequired => "review_required",
    Scheduled => "scheduled",
    Autopost => "autopost",
);

string_enum!(TweetType,
    UsefulInfo => "useful_info",
    Guide => "guide",
    Opinion => "opinion",
    Reply => "reply",
    NarrativeHistory => "narrative_history",
    FeedObservation => "feed_observation",
    NewsContext => "news_context",
    Lesson => "lesson",
    Tool => "tool",
    ArticleSummary => "article_summary",
    Hiring => "hiring",
);

string_enum!(SourceType,
    Manual => "manual",
    News => "news",
    Feed => "feed",
    Bookmark => "bookmark",
    Note => "note",
    Guide => "guide",
    Job => "job",
    ModelReleases => "model-releases",
    XFeed => "x-feed",
    DeepseekUpdates => "deepseek-updates",
    CursorChangelog => "cursor-changelog",
    XaiNews => "xai-news",
    AnthropicReleaseNotes => "anthropic-release-notes",
    A16z => "a16z",
    Goldfish => "goldfish",
);

string_enum!(LlmProvider,
    CommandCode => "command-code",
    Opencode => "opencode",
    Gemini => "gemini",
    Ollama => "ollama",
);

string_enum!(DraftStatus,
    Created => "created",
    Generated => "generated",
    Selected => "selected",
    Approved => "approved",
    Archived => "archived",
);

string_enum!(PostJobStatus,
    Created => "created",
    Approved => "approved",
    Queued => "queued",
    Running => "running",
    Prepared => "prepared",
    Posted => "posted",
    Failed => "failed",
    Cancelled => "cancelled",
);

string_enum!(AttemptStatus,
    Started => "started",
    ComposeOpened => "compose_opened",
    TextInserted => "text_inserted",
    PostClicked => "post_clicked",
    Verified => "verified",
    RetryScheduled => "retry_scheduled",
    Failed => "failed",
);

/// The six current tweet types. Legacy types stay parseable (see [`TweetType`]).
pub const TWEET_TYPES: &[TweetType] = &[
    TweetType::UsefulInfo,
    TweetType::Guide,
    TweetType::Opinion,
    TweetType::Reply,
    TweetType::NarrativeHistory,
    TweetType::FeedObservation,
];

pub const LEGACY_TWEET_TYPES: &[TweetType] = &[
    TweetType::NewsContext,
    TweetType::Lesson,
    TweetType::Tool,
    TweetType::ArticleSummary,
    TweetType::Hiring,
];

pub const ALL_TWEET_TYPES: &[TweetType] = &[
    TweetType::UsefulInfo,
    TweetType::Guide,
    TweetType::Opinion,
    TweetType::Reply,
    TweetType::NarrativeHistory,
    TweetType::FeedObservation,
    TweetType::NewsContext,
    TweetType::Lesson,
    TweetType::Tool,
    TweetType::ArticleSummary,
    TweetType::Hiring,
];

pub const POSTING_MODES: &[PostingMode] = PostingMode::ALL;
pub const SOURCE_TYPES: &[SourceType] = SourceType::ALL;
pub const LLM_PROVIDERS: &[LlmProvider] = LlmProvider::ALL;
pub const POST_JOB_STATUSES: &[PostJobStatus] = PostJobStatus::ALL;
pub const ATTEMPT_STATUSES: &[AttemptStatus] = AttemptStatus::ALL;

/// Phrases the quality scorer rejects outright. Mirrors
/// `AI_SLOP_PHRASES` in `packages/core/src/index.ts`.
pub const AI_SLOP_PHRASES: &[&str] = &[
    "let's dive in",
    "let us dive in",
    "dive in",
    "delve",
    "delve into",
    "tapestry",
    "it's important to note",
    "in conclusion",
    "in today's",
    "in this day and age",
    "embark",
    "navigate the landscape",
    "navigate the complexities",
    "navigate the world",
    "game-changer",
    "game changer",
    "unlock the power",
    "unlock your",
    "robust solution",
    "leverage",
    "leverages",
    "synergy",
    "synergies",
    "cutting-edge",
    "cutting edge",
    "revolutionize",
    "revolutionary",
    "streamline",
    "streamlines",
    "holistic",
    "paradigm",
    "paradigm shift",
    "unleash the power",
    "unleash",
    "world-class",
    "world class",
    "seamless",
    "seamlessly",
    "elevate your",
    "empower",
    "harness the power",
    "harness the",
    "foster",
    "propel",
    "redefine",
    "in essence",
    "firstly",
    "secondly",
    "thirdly",
    "lastly",
    "moving forward",
    "at the end of the day",
    "when it comes to",
    "in the realm of",
    "in the world of",
    "a myriad of",
    "myriad of",
    "plethora of",
    "in this article",
    "this article will",
    "this guide will",
    "hope this helps",
    "as an ai",
    "as a language model",
    "as a large language model",
    "i cannot",
    "i'm sorry",
    "i am sorry",
    "i don't have",
    "feel free to",
    "don't hesitate to",
    "in summary",
    "to summarize",
    "ultimately",
    "ensure",
    "in order to",
    "in order for",
];
