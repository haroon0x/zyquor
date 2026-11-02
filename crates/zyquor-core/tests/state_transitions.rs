#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Ported from `packages/core/src/state.test.ts`.

use zyquor_core::types::{DraftStatus, PostJobStatus};
use zyquor_core::{can_transition_draft, can_transition_post_job};

#[test]
fn allows_draft_approval_from_created_or_selected() {
    assert!(can_transition_draft(
        DraftStatus::Selected,
        DraftStatus::Approved
    ));
    assert!(can_transition_draft(
        DraftStatus::Created,
        DraftStatus::Approved
    ));
}

#[test]
fn keeps_posted_and_cancelled_jobs_terminal() {
    assert!(!can_transition_post_job(
        PostJobStatus::Posted,
        PostJobStatus::Failed
    ));
    assert!(!can_transition_post_job(
        PostJobStatus::Cancelled,
        PostJobStatus::Queued
    ));
}

#[test]
fn allows_failed_jobs_to_be_explicitly_requeued() {
    assert!(can_transition_post_job(
        PostJobStatus::Failed,
        PostJobStatus::Queued
    ));
    assert!(can_transition_post_job(
        PostJobStatus::Failed,
        PostJobStatus::Approved
    ));
    assert!(can_transition_post_job(
        PostJobStatus::Failed,
        PostJobStatus::Posted
    ));
}

#[test]
fn draft_lifecycle_matches_typescript_graph() {
    assert!(can_transition_draft(
        DraftStatus::Created,
        DraftStatus::Generated
    ));
    assert!(can_transition_draft(
        DraftStatus::Generated,
        DraftStatus::Selected
    ));
    assert!(can_transition_draft(
        DraftStatus::Approved,
        DraftStatus::Archived
    ));
    assert!(!can_transition_draft(
        DraftStatus::Archived,
        DraftStatus::Created
    ));
    assert!(!can_transition_draft(
        DraftStatus::Approved,
        DraftStatus::Selected
    ));
}
