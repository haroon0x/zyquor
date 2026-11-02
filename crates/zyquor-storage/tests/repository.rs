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
fn seeds_the_default_account_and_style_profile() {
    let repo = repo();
    let accounts = repo.list_accounts().unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].id, "account_personal");
    assert_eq!(accounts[0].handle, "personal-main");
    assert_eq!(accounts[0].daily_post_limit, Some(300));

    let style = repo.get_style_profile("style_default").unwrap().unwrap();
    assert_eq!(style.name, "Default");
    assert_eq!(style.banned_phrases, vec!["game changer", "unlock", "10x"]);
}

#[test]
fn creates_accounts_and_rejects_duplicate_handles() {
    let (repo, _) = seeded();
    assert_eq!(repo.list_accounts().unwrap().len(), 2);

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

// --- source packets, knowledge, ingest, measurements --------------------

use zyquor_storage::{
    IngestConfigUpdate, IngestRunStatus, IngestRunUpdate, KnowledgeUpdate, NewIngestConfig,
    NewKnowledgeEntry, NewSourcePacket, NewTweetMeasurement, SourcePacketStatus,
    StyleProfileUpdate,
};

fn account_id(repo: &SqliteRepository) -> String {
    repo.list_accounts().unwrap()[0].id.clone()
}

#[test]
fn source_packet_lifecycle_matches_the_typescript_flow() {
    let repo = repo();
    let account = account_id(&repo);

    let packet = repo
        .create_source_packet(&NewSourcePacket {
            account_id: account.clone(),
            source_type: "news".to_string(),
            title: "A title".to_string(),
            url: Some("https://example.com/a".to_string()),
            summary: "summary".to_string(),
            facts: vec!["fact one".to_string(), "fact two".to_string()],
            tweet_type: "useful_info".to_string(),
        })
        .unwrap();

    assert_eq!(packet.status, SourcePacketStatus::New);
    assert_eq!(packet.facts.len(), 2);
    assert_eq!(repo.count_source_packets(None).unwrap(), 1);

    let drafted = repo.mark_source_packet_drafted(&packet.id).unwrap();
    assert_eq!(drafted.status, SourcePacketStatus::Drafted);
    assert_eq!(
        repo.count_source_packets(Some(SourcePacketStatus::Drafted))
            .unwrap(),
        1
    );

    let reset = repo.reset_source_packet(&packet.id).unwrap();
    assert_eq!(reset.status, SourcePacketStatus::New);

    let with_feedback = repo
        .set_source_packet_feedback(&packet.id, Some("useful"))
        .unwrap();
    assert_eq!(with_feedback.feedback.as_deref(), Some("useful"));

    let by_url = repo
        .get_source_packet_by_url("https://example.com/a", Some(&account))
        .unwrap();
    assert_eq!(by_url.unwrap().id, packet.id);

    assert_eq!(
        repo.get_latest_source_packet().unwrap().unwrap().id,
        packet.id
    );
    repo.delete_source_packet(&packet.id).unwrap();
    assert_eq!(repo.count_source_packets(None).unwrap(), 0);
}

#[test]
fn knowledge_entries_are_scoped_per_account() {
    let repo = repo();
    let first = account_id(&repo);
    let other = repo
        .create_account("second", "Second", "profiles/second", "style_default")
        .unwrap();

    let entry = repo
        .create_knowledge_entry(&NewKnowledgeEntry {
            account_id: first.clone(),
            kind: "product_fact".to_string(),
            title: "Fact".to_string(),
            content: "Body".to_string(),
            source_url: None,
        })
        .unwrap();
    assert!(entry.enabled);

    let updated = repo
        .update_knowledge_entry(
            &entry.id,
            &KnowledgeUpdate {
                title: Some("Updated".to_string()),
                enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.title, "Updated");
    assert!(!updated.enabled);

    assert_eq!(repo.list_knowledge_entries(&first).unwrap().len(), 1);
    assert_eq!(repo.list_knowledge_entries(&other.id).unwrap().len(), 0);

    repo.delete_knowledge_entry(&entry.id).unwrap();
    assert!(repo.list_knowledge_entries(&first).unwrap().is_empty());
}

#[test]
fn ingest_configs_create_update_and_count() {
    let repo = repo();
    let account = account_id(&repo);

    let config = repo
        .create_ingest_config(&NewIngestConfig {
            account_id: account,
            source_type: "news".to_string(),
            max_packets_per_day: 2,
            metadata: Map::new(),
            tweet_type_mix: Map::new(),
            schedule_window_start: "08:00".to_string(),
            schedule_window_end: "22:00".to_string(),
            enabled: true,
        })
        .unwrap();

    assert_eq!(repo.count_ingest_configs(Some(true)).unwrap(), 1);
    assert_eq!(repo.count_ingest_configs(Some(false)).unwrap(), 0);

    let updated = repo
        .update_ingest_config(
            &config.id,
            &IngestConfigUpdate {
                max_packets_per_day: Some(4),
                enabled: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(updated.max_packets_per_day, 4);
    assert!(!updated.enabled);

    repo.delete_ingest_config(&config.id).unwrap();
    assert_eq!(repo.count_ingest_configs(None).unwrap(), 0);
}

#[test]
fn ingest_runs_transition_and_recover() {
    let repo = repo();
    let account = account_id(&repo);

    let run = repo.create_ingest_run("config_1", &account).unwrap();
    assert_eq!(run.status, IngestRunStatus::Running);

    let finished = repo
        .update_ingest_run(
            &run.id,
            &IngestRunUpdate {
                status: IngestRunStatus::Succeeded,
                error: None,
                packets_created: Some(3),
            },
        )
        .unwrap();
    assert_eq!(finished.packets_created, 3);
    assert_eq!(finished.status, IngestRunStatus::Succeeded);
    assert!(finished.finished_at.is_some());

    let stuck = repo.create_ingest_run("config_2", &account).unwrap();
    assert_eq!(repo.recover_running_ingest_runs().unwrap(), 1);

    let recovered = repo
        .list_ingest_runs(Some(&account), 50)
        .unwrap()
        .into_iter()
        .find(|item| item.id == stuck.id)
        .unwrap();
    assert_eq!(recovered.status, IngestRunStatus::Failed);
    assert_eq!(recovered.error.as_deref(), Some("interrupted"));
}

#[test]
fn tweet_measurements_upsert_one_row_per_tweet() {
    let repo = repo();
    let account = account_id(&repo);

    let base = NewTweetMeasurement {
        account_id: account.clone(),
        tweet_id: "42".to_string(),
        origin: "posted".to_string(),
        posted_at: Some("2026-01-01T00:00:00.000Z".to_string()),
        text: Some("hello".to_string()),
        has_link: Some(false),
        source_type: Some("news".to_string()),
        tweet_type: Some("useful_info".to_string()),
        views: Some(10),
        likes: None,
        replies: None,
        reposts: None,
        bookmarks: None,
    };

    let first = repo.upsert_tweet_measurement(&base).unwrap();
    assert_eq!(first.views, Some(10));
    let first_id = first.id.clone();

    let second = repo
        .upsert_tweet_measurement(&NewTweetMeasurement {
            views: Some(25),
            likes: Some(4),
            ..base
        })
        .unwrap();

    assert_eq!(second.id, first_id, "upsert must reuse the existing row");
    assert_eq!(second.views, Some(25));
    assert_eq!(second.likes, Some(4));
    assert_eq!(
        repo.list_tweet_measurements(Some(&account)).unwrap().len(),
        1
    );
}

#[test]
fn updates_the_style_profile_in_place() {
    let repo = repo();

    let updated = repo
        .update_style_profile(
            "style_default",
            &StyleProfileUpdate {
                tone: Some(Some("direct".to_string())),
                banned_phrases: Some(vec!["synergy".to_string()]),
                ..Default::default()
            },
        )
        .unwrap();

    assert_eq!(updated.tone.as_deref(), Some("direct"));
    assert_eq!(updated.banned_phrases, vec!["synergy".to_string()]);
    assert_eq!(updated.name, "Default", "untouched fields are preserved");
}

#[test]
fn system_feedback_adds_lists_and_deletes() {
    let repo = repo();
    let account = account_id(&repo);

    let item = repo.add_system_feedback(&account, "be shorter").unwrap();
    assert_eq!(repo.list_system_feedback(&account).unwrap().len(), 1);

    repo.delete_system_feedback(&item.id).unwrap();
    assert!(repo.list_system_feedback(&account).unwrap().is_empty());
}

#[test]
fn account_deletion_is_blocked_by_non_terminal_jobs_including_failed() {
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

    // `failed` is not terminal for account deletion; only posted/cancelled are.
    repo.update_job_status(&job.id, PostJobStatus::Failed)
        .unwrap();
    let error = repo.delete_account(&account_id).unwrap_err();
    assert!(
        error
            .to_string()
            .starts_with("Cannot delete account with non-terminal job")
    );

    repo.update_job_status(&job.id, PostJobStatus::Cancelled)
        .unwrap();
    assert!(repo.delete_account(&account_id).is_ok());
}

#[test]
fn duplicate_text_lookup_uses_the_approved_fingerprint() {
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
    repo.approve_draft(&ApproveDraft {
        draft_id: draft.draft.id,
        edited_text: "Hello   World".to_string(),
        mode: None,
        scheduled_for: None,
        reply_to: None,
        reply_to_url: None,
    })
    .unwrap();

    let normalized = normalize_post_text("hello world");
    let hash = hash_post_text("hello world");
    assert!(
        repo.has_post_history_text_hash(&account_id, &hash, &normalized)
            .unwrap()
    );
    assert!(
        !repo
            .has_post_history_text_hash(&account_id, &hash_post_text("other"), "other")
            .unwrap()
    );
}
