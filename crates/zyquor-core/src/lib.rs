//! Domain contracts for Zyquor: constants, lifecycle transitions, path rules,
//! post spacing, and reply-target parsing.
//!
//! This crate is the Rust port of `packages/core`.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod paths;
pub mod reply;
pub mod spacing;
pub mod state;
pub mod types;

pub use reply::{ReplyTarget, ReplyTargetError, parse_reply_target_url};
pub use state::{can_transition_draft, can_transition_post_job};
pub use types::{
    ALL_TWEET_TYPES, ATTEMPT_STATUSES, AttemptStatus, DraftStatus, LEGACY_TWEET_TYPES,
    LLM_PROVIDERS, LlmProvider, POST_JOB_STATUSES, POSTING_MODES, PostJobStatus, PostingMode,
    SOURCE_TYPES, SourceType, TWEET_TYPES, TweetType,
};
