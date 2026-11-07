//! Automation: the decisions that turn sources into drafts.
//!
//! The crate is a Rust port of `packages/automation`. Modules are organized
//! as deep components: `packet` derives draft inputs from an item, `routing`
//! picks its tweet type, `quality` gates it, `performance` measures the loop,
//! `draft` builds the draft record, and `ingest` drives the whole machine.

pub mod account_context;
pub mod dates;
pub mod deps;
pub mod draft;
pub mod ingest;
pub mod packet;
pub(crate) mod packet_text;
pub mod performance;
pub mod quality;
pub mod routing;
pub mod topic;

pub use account_context::{AccountGenerationContext, account_generation_context};
pub use deps::AutomationDeps;
pub use draft::{
    PacketDraftOptions, PacketDraftResult, TopicDraftExistsError, draft_from_source_packet,
    generate_candidates_for_packet,
};
pub use ingest::{
    IngestError, IngestProgress, IngestResult, IngestSkipped, RunAutomaticIngestOptions,
    run_automatic_ingest,
};
pub use packet::{
    has_enough_source_context, packet_fields_from_feed_digest, packet_fields_from_item,
    source_tweet_input,
};
pub use performance::{
    PostFeatures, SourcePerformance, analyze_post_features, engagement_per_post_of,
    source_performance_by_type,
};
pub use quality::{
    PostQualityResult, is_low_signal_source_title, validate_generated_post_quality,
    validate_source_post_quality, validate_source_post_quality_at, with_required_source_url,
};
pub use routing::{RecentPostType, RoutingContext, normalize_tweet_type, route_tweet_type};
pub use topic::{has_topic_overlap, topic_words};

use zyquor_generation::types::GenerationRequestError;
use zyquor_storage::StorageError;

/// Failures draft building and ingest orchestration can report.
#[derive(Debug)]
pub enum AutomationError {
    Storage(StorageError),
    Provider(GenerationRequestError),
    TopicDraftExists {
        topic_title: String,
        existing_title: String,
        account_id: String,
    },
    NoCandidates {
        provider: String,
    },
}

impl From<StorageError> for AutomationError {
    fn from(error: StorageError) -> Self {
        Self::Storage(error)
    }
}

impl From<GenerationRequestError> for AutomationError {
    fn from(error: GenerationRequestError) -> Self {
        Self::Provider(error)
    }
}

impl std::fmt::Display for AutomationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Storage(error) => write!(formatter, "storage error: {error}"),
            Self::Provider(error) => {
                write!(formatter, "generation error: {error}")
            }
            Self::TopicDraftExists { topic_title, .. } => write!(
                formatter,
                "Draft already exists for this topic ({topic_title})"
            ),
            Self::NoCandidates { provider } => {
                write!(formatter, "{provider} returned no draft candidates")
            }
        }
    }
}

impl std::error::Error for AutomationError {}
