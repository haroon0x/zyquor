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
    AccountUpdate, ApproveDraft, Draft, DraftCandidate, DraftWithCandidates, NewAttempt,
    NewCandidate, NewDraft, NewPostHistory, PostAttempt, PostHistory, PostJob,
};
pub use sqlite::{SqliteRepository, StorageError};
pub use utils::{hash_post_text, new_id, normalize_post_text};
