//! Lifecycle transitions, ported 1:1 from `packages/core/src/state.ts`.

use crate::types::{DraftStatus, PostJobStatus};

const fn draft_targets(from: DraftStatus) -> &'static [DraftStatus] {
    use DraftStatus::*;
    match from {
        Created => &[Generated, Approved, Archived],
        Generated => &[Selected, Archived],
        Selected => &[Approved, Archived],
        Approved => &[Archived],
        Archived => &[],
    }
}

const fn post_job_targets(from: PostJobStatus) -> &'static [PostJobStatus] {
    use PostJobStatus::*;
    match from {
        Created => &[Approved, Cancelled],
        Approved => &[Queued, Cancelled],
        Queued => &[Running, Cancelled],
        Running => &[Prepared, Posted, Failed],
        Prepared => &[Running, Posted, Failed, Cancelled],
        Posted => &[],
        // `approved` re-arms a verified-failed job for the verify-then-retry
        // path; the transition is only taken after the thread scan proves the
        // reply never reached X. `posted` retroactively marks the opposite
        // case: the scan found the reply on X, so the failure was cosmetic.
        Failed => &[Queued, Approved, Posted, Cancelled],
        Cancelled => &[],
    }
}

pub fn can_transition_draft(from: DraftStatus, to: DraftStatus) -> bool {
    draft_targets(from).contains(&to)
}

pub fn can_transition_post_job(from: PostJobStatus, to: PostJobStatus) -> bool {
    post_job_targets(from).contains(&to)
}
