//! Input types for draft generation, mirroring `packages/generation/src/types.ts`
//! and `packages/generation/src/harness.ts`.
//!
//! TypeScript models every field as optional. Rust keeps the distinction that
//! matters to the prompt builder: absent versus present-but-empty lists are the
//! same thing there, because every renderer filters empty strings.

use std::fmt;

/// Source material a draft can be grounded in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TweetSourceContext {
    pub author: Option<String>,
    pub engagement: Option<i64>,
    pub facts: Vec<String>,
    pub published_at: Option<String>,
    pub source_name: Option<String>,
    pub source_type: Option<String>,
    pub summary: Option<String>,
    pub title: Option<String>,
    pub topic_tags: Vec<String>,
    pub url: Option<String>,
}

impl TweetSourceContext {
    /// Whether the context came from the X home feed.
    pub fn is_x_feed(&self) -> bool {
        self.source_type.as_deref() == Some("x-feed")
    }
}

/// The post a reply is aimed at.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ReplyContext {
    pub author_handle: String,
    pub url: String,
    pub author_name: Option<String>,
    pub text: Option<String>,
    pub other_replies: Vec<String>,
}

/// A verified fact about the account, injected as background material.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccountKnowledgeEntry {
    pub kind: String,
    pub title: String,
    pub content: String,
}

/// Everything the prompt builders and providers need for one draft request.
#[derive(Debug, Clone, Default)]
pub struct GenerateDraftCandidatesInput {
    pub banned_phrases: Vec<String>,
    pub context: Option<TweetSourceContext>,
    pub example_posts: Vec<String>,
    pub feedback: Option<String>,
    pub idea: String,
    pub count: Option<usize>,
    pub memory_context: Option<String>,
    pub objective: Option<String>,
    pub preserve_case: bool,
    pub recent_post_history: Vec<String>,
    pub reply_context: Option<ReplyContext>,
    pub system_prompt_extra: Option<String>,
    pub system_feedback: Vec<String>,
    pub tone: Option<String>,
    pub tweet_type: Option<String>,
    pub account_knowledge: Vec<AccountKnowledgeEntry>,
}

impl GenerateDraftCandidatesInput {
    /// A request for a plain idea, the shape `build_idea_tweet_input` returns.
    pub fn from_idea(idea: impl Into<String>) -> Self {
        Self {
            idea: idea.into(),
            ..Self::default()
        }
    }
}

/// One generated candidate with its quality report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedDraftCandidate {
    pub text: String,
    pub quality: i64,
    pub provider: String,
    pub model: String,
    /// 1-based position in the returned list.
    pub rank: usize,
}

/// Errors a generation provider can report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenerationErrorKind {
    /// The provider was asked for something it cannot do (missing key, binary).
    Configuration,
    /// Transport or HTTP failure.
    Transport,
    /// The model replied, but not with usable JSON.
    InvalidResponse,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GenerationRequestError {
    pub kind: GenerationErrorKind,
    pub message: String,
}

impl GenerationRequestError {
    pub fn configuration(message: impl Into<String>) -> Self {
        Self {
            kind: GenerationErrorKind::Configuration,
            message: message.into(),
        }
    }

    pub fn transport(message: impl Into<String>) -> Self {
        Self {
            kind: GenerationErrorKind::Transport,
            message: message.into(),
        }
    }

    pub fn invalid_response(message: impl Into<String>) -> Self {
        Self {
            kind: GenerationErrorKind::InvalidResponse,
            message: message.into(),
        }
    }
}

impl fmt::Display for GenerationRequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GenerationRequestError {}

pub type GenerationResult<T> = Result<T, GenerationRequestError>;
