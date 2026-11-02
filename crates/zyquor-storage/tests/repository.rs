#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Ported from the scenarios covered by `packages/storage/src/index.test.ts`.

use serde_json::{Map, Value};

use zyquor_core::ReplyTarget;
use zyquor_core::types::{AttemptStatus, DraftStatus, PostJobStatus, PostingMode};
use zyquor_storage::{
    ApproveDraft, NewAttempt, NewCandidate, NewDraft, NewPostHistory, SqliteRepository,
    hash_post_text, normalize_post_text,
};

const NOW: &str = "2026-01-01T12:00:00.000Z";

fn repo() -> SqliteRepository {
    SqliteRepository::open_in_memory_with_now(|| NOW.to_string()).unwrap()
}

fn seeded() -> (SqliteRepository, String) {
    let repo = repo();
    let account = repo
        .create_account("someone", "Someone", "profiles/someone", "style_default")
        .unwrap();
    (repo, account.id)
}

fn metadata(pairs: &[(&str, Value)]) -> Map<String, Value> {
    let mut map = Map::new();
    for (key, value) in pairs {
        map.insert((*key).to_string(), value.clone());
    }
    map
}

#[test]
fn creates_accounts_and_rejects_duplicate_handles() {
    let (repo, _) = seeded();
    assert_eq!(repo.list_accounts().unwrap().len(), 1);

    let error = repo
        .create_account("someone", "Again", "profiles/someone2", "style_default")
        .unwrap_err();
    assert_eq!(error.to_string(), "Duplicate account handle: someone");
}

#[test]
fn creates_a_draft_with_candidates_and_selects_the_first() {
    let (repo, account_id) = seeded();
    let draft = repo
        .create_draft(&NewDraft {
            account_id: account_id.clone(),
            source_input: "an idea".to_string(),
            candidates: vec![
                NewCandidate {
                    text: "first".to_string(),
                    score: metadata(&[("score", Value::from(8))]),
                },
                NewCandidate {
                    text: "second".to_string(),
                    score: Map::new(),
                },
            ],
            reply_to: None,
            reply_to_url: None,
            metadata: Map::new(),
        })
        .unwrap();

    assert_eq!(draft.draft.status, DraftStatus::Selected);
    assert_eq!(draft.draft.generated_text.as_deref(), Some("first"));
    assert_eq!(draft.candidates.len(), 2);
    assert!(draft.candidates[0].selected);
    assert!(!draft.candidates[1].selected);
    assert_eq!(
        draft.candidates[1].score.get("index"),
        Some(&Value::from(1))
    );
}

#[test]
fn approves_a_draft_and_creates_an_approved_job() {
    let (repo, account_id) = seeded();
    let draft = repo
        .create_draft(&NewDraft {
            account_id,
            source_input: "an idea".to_string(),
            candidates: vec![NewCandidate {
                text: "draft text".to_string(),
                score: Map::new(),
            }],
            reply_to: None,
            reply_to_url: None,
            metadata: Map::new(),
        })
        .unwrap();

    let (approved, job) = repo
        .approve_draft(&ApproveDraft {
            draft_id: draft.draft.id.clone(),
            edited_text: "approved text".to_string(),
            mode: Some(PostingMode::PrepareOnly),
            scheduled_for: None,
            reply_to: None,
            reply_to_url: None,
        })
        .unwrap();

    assert_eq!(approved.status, DraftStatus::Approved);
    assert_eq!(approved.edited_text.as_deref(), Some("approved text"));
    assert_eq!(job.status, PostJobStatus::Approved);
    assert_eq!(job.mode, PostingMode::PrepareOnly);
    assert_eq!(job.approved_at.as_deref(), Some(NOW));
}

#[test]
fn defaults_the_job_mode_to_scheduled_when_a_time_is_given() {
    let (repo, account_id) = seeded();
    let draft = repo
        .create_draft(&NewDraft {
            account_id,
            source_input: "an idea".to_string(),
            candidates: vec![],
            reply_to: None,
            reply_to_url: None,
            metadata: Map::new(),
        })
        .unwrap();

    let (_, job) = repo
        .approve_draft(&ApproveDraft {
            draft_id: draft.draft.id,
            edited_text: "text".to_string(),
            mode: None,
            scheduled_for: Some("2026-01-02T09:00:00.000Z".to_string()),
            reply_to: None,
            reply_to_url: None,
        })
        .unwrap();

    assert_eq!(job.mode, PostingMode::Scheduled);
    assert_eq!(
        job.scheduled_for.as_deref(),
        Some("2026-01-02T09:00:00.000Z")
    );
}

#[test]
fn rejects_duplicate_approved_text_for_the_same_account() {
    let (repo, account_id) = seeded();

    let first = repo
        .create_draft(&NewDraft {
            account_id: account_id.clone(),
            source_input: "one".to_string(),
            candidates: vec![],
            reply_to: None,
            reply_to_url: None,
            metadata: Map::new(),
        })
        .unwrap();
    repo.approve_draft(&ApproveDraft {
        draft_id: first.draft.id,
        edited_text: "Same   Text".to_string(),
        mode: None,
        scheduled_for: None,
        reply_to: None,
        reply_to_url: None,
    })
    .unwrap();

    let second = repo
        .create_draft(&NewDraft {
            account_id,
            source_input: "two".to_string(),
            candidates: vec![],
            reply_to: None,
            reply_to_url: None,
            metadata: Map::new(),
        })
        .unwrap();
    let error = repo
        .approve_draft(&ApproveDraft {
            draft_id: second.draft.id,
            edited_text: "same text".to_string(),
            mode: None,
            scheduled_for: None,
            reply_to: None,
            reply_to_url: None,
        })
        .unwrap_err();

    assert_eq!(error.to_string(), "Duplicate post text for this account");
}

#[test]
fn claims_only_one_browser_job_per_account() {
    let (repo, account_id) = seeded();

    let make_job = |text: &str| {
        let draft = repo
            .create_draft(&NewDraft {
                account_id: account_id.clone(),
                source_input: text.to_string(),
                candidates: vec![],
                reply_to: None,
                reply_to_url: None,
                metadata: Map::new(),
            })
            .unwrap();
        let (_, job) = repo
            .approve_draft(&ApproveDraft {
                draft_id: draft.draft.id,
                edited_text: text.to_string(),
                mode: None,
                scheduled_for: None,
                reply_to: None,
                reply_to_url: None,
            })
            .unwrap();
        job
    };

    let first = make_job("first post");
    let second = make_job("second post");

    let claimed = repo
        .claim_job_for_browser_run(&first.id, &[PostJobStatus::Approved])
        .unwrap();
    assert!(claimed.is_some());
    assert_eq!(claimed.unwrap().status, PostJobStatus::Queued);

    let blocked = repo
        .claim_job_for_browser_run(&second.id, &[PostJobStatus::Approved])
        .unwrap();
    assert!(
        blocked.is_none(),
        "second job must not claim while one is queued"
    );
}

#[test]
fn refuses_to_delete_a_draft_with_post_history() {
    let (repo, account_id) = seeded();
    let draft = repo
        .create_draft(&NewDraft {
            account_id: account_id.clone(),
            source_input: "idea".to_string(),
            candidates: vec![],
            reply_to: None,
            reply_to_url: None,
            metadata: Map::new(),
        })
        .unwrap();

    repo.create_post_history(&NewPostHistory {
        account_id,
        draft_id: draft.draft.id.clone(),
        posted_text: "posted".to_string(),
        post_url: Some("https://x.com/someone/status/1".to_string()),
        source_packet_id: None,
        source_type: None,
        source_title: None,
        source_url: None,
        tweet_type: None,
        metadata: Map::new(),
    })
    .unwrap();

    let error = repo.delete_draft(&draft.draft.id).unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("Cannot delete draft with post history")
    );
}

#[test]
fn deletes_a_draft_with_only_terminal_jobs() {
    let (repo, account_id) = seeded();
    let draft = repo
        .create_draft(&NewDraft {
            account_id,
            source_input: "idea".to_string(),
            candidates: vec![],
            reply_to: None,
            reply_to_url: None,
            metadata: Map::new(),
        })
        .unwrap();
    repo.approve_draft(&ApproveDraft {
        draft_id: draft.draft.id.clone(),
        edited_text: "text".to_string(),
        mode: None,
        scheduled_for: None,
        reply_to: None,
        reply_to_url: None,
    })
    .unwrap();

    let removed = repo.delete_draft(&draft.draft.id).unwrap();
    assert_eq!(removed.draft.id, draft.draft.id);
    assert!(repo.get_draft(&draft.draft.id).unwrap().is_none());
}

#[test]
fn roundtrips_reply_targets() {
    let (repo, account_id) = seeded();
    let target = ReplyTarget {
        tweet_id: "123".to_string(),
        author_handle: "someone".to_string(),
        url: "https://x.com/someone/status/123".to_string(),
        author_name: None,
        text: None,
    };

    let draft = repo
        .create_draft(&NewDraft {
            account_id,
            source_input: "reply".to_string(),
            candidates: vec![],
            reply_to: Some(target.clone()),
            reply_to_url: Some(target.url.clone()),
            metadata: Map::new(),
        })
        .unwrap();

    let loaded = repo.get_draft(&draft.draft.id).unwrap().unwrap();
    assert_eq!(loaded.draft.reply_to.as_ref(), Some(&target));
}

#[test]
fn derives_the_reply_target_from_a_legacy_url() {
    let (repo, account_id) = seeded();
    let draft = repo
        .create_draft(&NewDraft {
            account_id,
            source_input: "reply".to_string(),
            candidates: vec![],
            reply_to: None,
            reply_to_url: Some("https://x.com/someone/status/999".to_string()),
            metadata: Map::new(),
        })
        .unwrap();

    let loaded = repo.get_draft(&draft.draft.id).unwrap().unwrap();
    let target = loaded.draft.reply_to.expect("reply target");
    assert_eq!(target.tweet_id, "999");
    assert_eq!(target.author_handle, "someone");
}

#[test]
fn records_attempts_in_order() {
    let (repo, account_id) = seeded();
    let draft = repo
        .create_draft(&NewDraft {
            account_id,
            source_input: "idea".to_string(),
            candidates: vec![],
            reply_to: None,
            reply_to_url: None,
            metadata: Map::new(),
        })
        .unwrap();
    let (_, job) = repo
        .approve_draft(&ApproveDraft {
            draft_id: draft.draft.id,
            edited_text: "text".to_string(),
            mode: None,
            scheduled_for: None,
            reply_to: None,
            reply_to_url: None,
        })
        .unwrap();

    repo.create_attempt(&NewAttempt {
        job_id: job.id.clone(),
        status: AttemptStatus::Started,
        error_code: None,
        error_message: None,
        screenshot_path: None,
        trace_path: None,
    })
    .unwrap();

    let attempts = repo.list_attempts(&job.id).unwrap();
    assert_eq!(attempts.len(), 1);
    assert_eq!(attempts[0].status, AttemptStatus::Started);
}

#[test]
fn purges_post_history_older_than_a_cutoff() {
    let (repo, account_id) = seeded();
    let draft = repo
        .create_draft(&NewDraft {
            account_id: account_id.clone(),
            source_input: "idea".to_string(),
            candidates: vec![],
            reply_to: None,
            reply_to_url: None,
            metadata: Map::new(),
        })
        .unwrap();

    repo.create_post_history(&NewPostHistory {
        account_id,
        draft_id: draft.draft.id,
        posted_text: "posted".to_string(),
        post_url: None,
        source_packet_id: None,
        source_type: None,
        source_title: None,
        source_url: None,
        tweet_type: None,
        metadata: Map::new(),
    })
    .unwrap();

    assert_eq!(repo.list_post_history().unwrap().len(), 1);
    // The fixed clock writes 2026-01-01; a later cutoff removes it.
    let purged = repo
        .purge_post_history_older_than("2026-02-01T00:00:00.000Z")
        .unwrap();
    assert_eq!(purged, 1);
    assert!(repo.list_post_history().unwrap().is_empty());
}

#[test]
fn post_text_normalisation_and_hashing_match_the_typescript_rules() {
    assert_eq!(normalize_post_text("  Hello   WORLD  "), "hello world");

    // SHA-256("hello world"), i.e. the hash of the normalised form.
    assert_eq!(
        hash_post_text("Hello   WORLD"),
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
    );

    // Same normalised text produces the same hash regardless of spacing/case.
    assert_eq!(
        hash_post_text("Hello   WORLD"),
        hash_post_text("hello world")
    );
    assert_eq!(hash_post_text("a").len(), 64);
}
