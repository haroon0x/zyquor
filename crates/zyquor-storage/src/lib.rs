//! Persistence for Zyquor: SQLite repositories, schema, and helpers.
//!
//! Rust port of `packages/storage`. See `docs/rust-migration.md` for the parts
//! that are not ported yet.

pub mod firstrun;
pub mod model;
pub mod schema;
pub mod sqlite;
pub mod utils;

pub use firstrun::ensure_first_run;
pub use model::{
    AccountUpdate, ApproveDraft, Draft, DraftCandidate, DraftWithCandidates, IngestConfig,
    IngestConfigUpdate, IngestRun, IngestRunStatus, IngestRunUpdate, KnowledgeEntry,
    KnowledgeUpdate, NewAttempt, NewCandidate, NewDraft, NewIngestConfig, NewKnowledgeEntry,
    NewPostHistory, NewSourcePacket, NewTweetMeasurement, PostAttempt, PostHistory, PostJob,
    SourcePacket, SourcePacketStatus, StyleProfile, StyleProfileUpdate, SystemFeedback,
    TweetMeasurement,
};
pub use sqlite::{SqliteRepository, StorageError};
pub use utils::{hash_post_text, new_id, normalize_post_text};

/// Convenience alias matching the TypeScript `ZyquorRepository` surface.
pub type ZyquorRepository = SqliteRepository;
