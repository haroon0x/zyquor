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
    Openrouter => "openrouter",
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
