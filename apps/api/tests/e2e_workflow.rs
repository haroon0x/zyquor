//! End-to-end API workflow tests: build the real axum router in process over a
//! per-test temp SQLite database and drive it with real HTTP requests through
//! `tower::ServiceExt::oneshot`.
//!
//! Nothing here touches the network, an LLM provider, a browser, or the live
//! dev API: generation is never invoked, `GET /generation` only resolves the
//! configured provider, and drafts/jobs/history are seeded through the same
//! repository the handlers use. Every test owns its temp data root and removes
//! it on drop, so the tests are deterministic and parallel-safe.
//!
//! Deliberate limits of the in-process harness, documented rather than faked:
//! - `POST /source-packets/{id}/feedback` resolves its notebook directory from
//!   the process cwd (`<cwd>/feedback`) and ignores the `feedbackDir` desktop
//!   setting, so that one write lands outside the temp root. The directory is
//!   gitignored (`feedback/`); the assertions check the database effect.
//! - `PATCH /generation` is not exercised: it rewrites the saved provider file
//!   under the process data root, outside this test's temp directory, and the
//!   live provider in `AppState` is immutable anyway.

use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Map, Value, json};
use tower::ServiceExt;
use zyquor_api::{AppState, BuildAppOptions, build_app};
use zyquor_core::types::AttemptStatus;
use zyquor_storage::{
    DraftWithCandidates, NewAttempt, NewCandidate, NewDraft, NewPostHistory, SqliteRepository,
};

type TestError = Box<dyn std::error::Error>;
type TestResult = Result<(), TestError>;

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

/// One in-process API instance: temp data root, real SQLite schema, real
/// router. Dropping the harness removes the temp directory.
struct Harness {
    app: Router,
    state: AppState,
    root: PathBuf,
}

impl Harness {
    fn new(label: &str) -> Result<Self, TestError> {
        let seq = NEXT_DIR.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!(
            "zyquor-api-e2e-{label}-{}-{seq}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root)?;
        let db_path = root.join("app.sqlite");
        let repository = SqliteRepository::open(&db_path)?;
        let state = AppState::new(repository, db_path, &BuildAppOptions::default())
            .map_err(std::io::Error::other)?;
        let app = build_app(state.clone());
        Ok(Self { app, state, root })
    }

    /// Issue one real HTTP request against the in-process router.
    async fn send(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
    ) -> Result<(StatusCode, Value), TestError> {
        let request = Request::builder()
            .method(method)
            .uri(path)
            .header("content-type", "application/json");
        let request = match body {
            Some(body) => request.body(Body::from(body.to_string()))?,
            None => request.body(Body::empty())?,
        };
        let response = self.app.clone().oneshot(request).await?;
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024).await?;
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes)?
        };
        Ok((status, value))
    }

    /// Create an account through the same repository the handlers use. The
    /// HTTP create route is covered by its own test.
    async fn seed_account(&self, handle: &str) -> Result<zyquor_accounts::Account, TestError> {
        let account = self
            .state
            .repository()
            .create_account(
                handle,
                handle,
                &format!("profiles/{handle}"),
                "style_default",
            )
            .await?;
        Ok(account)
    }

    /// Seed a draft (and optional candidates) exactly as generation would
    /// leave it, without ever calling the LLM.
    async fn seed_draft(
        &self,
        account_id: &str,
        candidates: Vec<NewCandidate>,
        metadata: Value,
    ) -> Result<DraftWithCandidates, TestError> {
        let draft = self
            .state
            .repository()
            .create_draft(NewDraft {
                account_id: account_id.to_string(),
                source_input: "e2e seeded idea".to_string(),
                candidates,
                reply_to: None,
                reply_to_url: None,
                metadata: object(metadata),
            })
            .await?;
        Ok(draft)
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// Read a required string field out of a JSON body.
fn text(value: &Value, key: &str) -> Result<String, TestError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("expected string field `{key}` in {value}").into())
}

fn new_candidate(text: &str, quality: i64) -> NewCandidate {
    NewCandidate {
        text: text.to_string(),
        score: object(json!({"quality": quality})),
    }
}

#[tokio::test]
async fn health_system_and_worker_status_shapes() -> TestResult {
    let harness = Harness::new("health")?;

    let (status, body) = harness.send("GET", "/health", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["browserLoaded"], json!(false));
    assert!(!text(&body["generation"], "provider")?.is_empty());
    assert!(!text(&body["generation"], "model")?.is_empty());

    let (status, body) = harness.send("GET", "/system/status", None).await?;
    assert_eq!(status, StatusCode::OK);
    let started_at = text(&body["api"], "startedAt")?;
    assert!(
        chrono::DateTime::parse_from_rfc3339(&started_at).is_ok(),
        "startedAt must be RFC3339: {started_at}"
    );
    assert_eq!(body["api"]["browserLoaded"], json!(false));
    assert_eq!(body["counts"]["drafts"], json!(0));
    assert_eq!(body["counts"]["ingestConfigsEnabled"], json!(0));
    assert_eq!(body["counts"]["jobs"], json!(0));
    assert_eq!(body["counts"]["jobsByStatus"], json!({}));
    assert_eq!(body["counts"]["sourcePackets"], json!(0));
    assert_eq!(body["desktop"], Value::Null);
    assert_eq!(body["runningJobs"], json!([]));
    assert_eq!(body["posting"]["enablePost"], json!(false));
    assert_eq!(body["posting"]["enablePrepare"], json!(false));
    assert_eq!(body["worker"]["paused"], json!(false));
    assert_eq!(body["worker"]["running"], json!(false));
    assert_eq!(body["ingestRun"]["running"], json!(false));
    assert_eq!(body["ingestRun"]["processed"], json!(0));
    assert_eq!(body["ingestRun"]["errors"], json!([]));

    let (status, body) = harness.send("GET", "/worker/status", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(true));
    assert_eq!(body["enabledIngestConfigCount"], json!(0));
    assert_eq!(body["hasEnabledIngestConfigs"], json!(false));
    assert_eq!(body["lastHeartbeatAt"], Value::Null);
    assert_eq!(body["workerRunning"], json!(false));
    assert_eq!(body["ingestRun"]["running"], json!(false));

    let (status, body) = harness
        .send(
            "POST",
            "/worker/heartbeat",
            Some(json!({"lastError": "e2e-simulated"})),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ok"], json!(true));
    assert!(text(&body["worker"], "lastHeartbeatAt")?.contains('T'));

    let (status, body) = harness.send("GET", "/worker/status", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["workerRunning"], json!(true));
    assert_eq!(body["lastError"], json!("e2e-simulated"));
    assert!(body["nextIngestRunAt"].is_string());
    assert!(text(&body, "lastHeartbeatAt")?.contains('T'));
    Ok(())
}

#[tokio::test]
async fn accounts_create_patch_delete_round_trip() -> TestResult {
    let harness = Harness::new("accounts")?;

    let (status, body) = harness
        .send(
            "POST",
            "/accounts",
            Some(json!({"handle": "e2e_acct", "displayName": "E2E Account"})),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let account = body.get("account").ok_or("missing account object")?.clone();
    let account_id = text(&account, "id")?;
    assert!(account_id.starts_with("account_"), "{account}");
    assert_eq!(text(&account, "handle")?, "e2e_acct");
    assert_eq!(text(&account, "displayName")?, "E2E Account");
    assert_eq!(text(&account, "profileDir")?, "profiles/e2e_acct");
    assert_eq!(text(&account, "styleProfileId")?, "style_default");
    assert_eq!(text(&account, "postingMode")?, "draft_only");
    assert_eq!(account["enabled"], json!(true));
    assert_eq!(account["dailyPostLimit"], json!(5));
    assert_eq!(account["quietHoursStart"], Value::Null);
    assert_eq!(account["quietHoursEnd"], Value::Null);
    assert!(text(&account, "createdAt")?.contains('T'));

    // The database seed creates the default style profile the account points at.
    let (status, body) = harness
        .send("GET", "/style-profiles/style_default", None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(text(&body["profile"], "id")?, "style_default");
    assert!(body["profile"]["rules"].is_object());
    assert!(body["profile"]["bannedPhrases"].is_array());

    // The seeded database ships one default account (`account_personal`).
    let (status, body) = harness.send("GET", "/accounts", None).await?;
    assert_eq!(status, StatusCode::OK);
    let accounts = body["accounts"].as_array().ok_or("accounts array")?;
    assert_eq!(accounts.len(), 2);
    let listed = accounts
        .iter()
        .find(|item| item["id"] == json!(account_id))
        .ok_or("created account missing from list")?;
    assert_eq!(text(listed, "handle")?, "e2e_acct");
    assert!(
        accounts
            .iter()
            .any(|item| item["id"] == json!("account_personal")),
        "{body}"
    );

    let account_path = format!("/accounts/{account_id}");
    let (status, body) = harness
        .send(
            "PATCH",
            &account_path,
            Some(json!({
                "displayName": "Renamed Account",
                "dailyPostLimit": 9,
                "quietHoursStart": "22:00",
                "quietHoursEnd": "06:00",
                "profileDir": "profiles/e2e_alt",
                "postingMode": "prepare_only",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    let account = body.get("account").ok_or("missing account object")?.clone();
    assert_eq!(text(&account, "displayName")?, "Renamed Account");
    assert_eq!(account["dailyPostLimit"], json!(9));
    assert_eq!(text(&account, "quietHoursStart")?, "22:00");
    assert_eq!(text(&account, "quietHoursEnd")?, "06:00");
    assert_eq!(text(&account, "profileDir")?, "profiles/e2e_alt");
    assert_eq!(text(&account, "postingMode")?, "prepare_only");

    // An invalid handle is rejected before touching the database.
    let (status, body) = harness
        .send("POST", "/accounts", Some(json!({"handle": "Bad-Handle"})))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], json!("Invalid request"));

    let (status, body) = harness
        .send("POST", "/accounts", Some(json!({"handle": "e2e_second"})))
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let second_id = text(&body["account"], "id")?;
    assert_eq!(text(&body["account"], "displayName")?, "e2e_second");

    let (status, body) = harness.send("DELETE", &account_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["account"]["id"], json!(account_id));

    let (status, body) = harness
        .send("DELETE", &format!("/accounts/{second_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["account"]["id"], json!(second_id));

    // The seeded default account is the last one left; it cannot be deleted.
    let (status, body) = harness.send("GET", "/accounts", None).await?;
    assert_eq!(status, StatusCode::OK);
    let accounts = body["accounts"].as_array().ok_or("accounts array")?;
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0]["id"], json!("account_personal"));
    let (status, body) = harness
        .send("DELETE", "/accounts/account_personal", None)
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(text(&body, "error")?.contains("last remaining account"));
    Ok(())
}

#[tokio::test]
async fn draft_select_approve_creates_job_with_schedule_and_attempts() -> TestResult {
    let harness = Harness::new("draft-lifecycle")?;
    let account = harness.seed_account("e2e_draft").await?;
    let seeded = harness
        .seed_draft(
            &account.id,
            vec![
                new_candidate("first seeded candidate", 8),
                new_candidate("second seeded candidate", 7),
            ],
            json!({"tweetType": "opinion", "count": 2}),
        )
        .await?;
    let draft_id = seeded.draft.id.clone();
    let second_candidate_id = seeded
        .candidates
        .get(1)
        .ok_or("expected two seeded candidates")?
        .id
        .clone();

    let draft_path = format!("/drafts/{draft_id}");
    let (status, body) = harness.send("GET", &draft_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(text(&body["draft"], "id")?, draft_id);
    assert_eq!(text(&body["draft"], "status")?, "selected");
    let candidates = body["candidates"].as_array().ok_or("candidates array")?;
    assert_eq!(candidates.len(), 2);
    assert_eq!(text(&candidates[0], "draftId")?, draft_id);
    assert_eq!(text(&candidates[0], "text")?, "first seeded candidate");
    assert_eq!(candidates[0]["selected"], json!(true));
    assert_eq!(candidates[1]["selected"], json!(false));

    // Select the second candidate with an edit; the lowercase text passes
    // through the same post-processor the UI does.
    let edited = "small deterministic tests catch regressions that mocked calls quietly hide";
    let (status, body) = harness
        .send(
            "POST",
            &format!("/drafts/{draft_id}/select"),
            Some(json!({"candidateId": second_candidate_id, "editedText": edited})),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(text(&body["draft"], "editedText")?, edited);
    assert_eq!(text(&body["draft"], "status")?, "selected");
    let candidates = body["candidates"].as_array().ok_or("candidates array")?;
    assert_eq!(candidates[0]["selected"], json!(false));
    assert_eq!(candidates[1]["selected"], json!(true));

    // Unscreened approval creates the job (the screen is covered separately).
    let (status, body) = harness
        .send(
            "POST",
            &format!("/drafts/{draft_id}/approve"),
            Some(json!({"editedText": edited})),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(text(&body["draft"], "status")?, "approved");
    assert_eq!(text(&body["draft"], "editedText")?, edited);
    let job = body.get("job").ok_or("missing job object")?.clone();
    let job_id = text(&job, "id")?;
    assert!(job_id.starts_with("job_"), "{job}");
    assert_eq!(text(&job, "accountId")?, account.id);
    assert_eq!(text(&job, "draftId")?, draft_id);
    assert_eq!(text(&job, "status")?, "approved");
    assert_eq!(text(&job, "mode")?, "prepare_only");
    assert_eq!(job["scheduledFor"], Value::Null);
    assert!(text(&job, "approvedAt")?.contains('T'));

    let jobs_path = format!("/jobs?accountId={}", account.id);
    let (status, body) = harness.send("GET", &jobs_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    let jobs = body["jobs"].as_array().ok_or("jobs array")?;
    assert_eq!(jobs.len(), 1);
    assert_eq!(jobs[0]["id"], json!(job_id));
    assert_eq!(jobs[0]["accountId"], json!(account.id));

    // Schedule set and clear.
    let job_path = format!("/jobs/{job_id}");
    let schedule = "2026-12-01T10:00:00.000Z";
    let (status, body) = harness
        .send("PATCH", &job_path, Some(json!({"scheduledFor": schedule})))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(text(&body["job"], "scheduledFor")?, schedule);
    let (status, body) = harness
        .send("PATCH", &job_path, Some(json!({"scheduledFor": null})))
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["job"]["scheduledFor"], Value::Null);
    let (status, body) = harness
        .send("PATCH", &job_path, Some(json!({"mode": "autopost"})))
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], json!("Invalid request"));

    // Attempts shape, seeded through the repository.
    let attempts_path = format!("/jobs/{job_id}/attempts");
    let (status, body) = harness.send("GET", &attempts_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["attempts"], json!([]));
    harness
        .state
        .repository()
        .create_attempt(NewAttempt {
            job_id: job_id.clone(),
            status: AttemptStatus::Failed,
            error_code: Some("E2E_FAIL".to_string()),
            error_message: Some("simulated browser failure".to_string()),
            screenshot_path: None,
            trace_path: None,
        })
        .await?;
    let (status, body) = harness.send("GET", &attempts_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    let attempts = body["attempts"].as_array().ok_or("attempts array")?;
    assert_eq!(attempts.len(), 1);
    assert!(text(&attempts[0], "id")?.starts_with("attempt_"));
    assert_eq!(text(&attempts[0], "jobId")?, job_id);
    assert_eq!(text(&attempts[0], "status")?, "failed");
    assert_eq!(text(&attempts[0], "errorCode")?, "E2E_FAIL");
    assert_eq!(
        text(&attempts[0], "errorMessage")?,
        "simulated browser failure"
    );
    assert!(text(&attempts[0], "startedAt")?.contains('T'));
    assert_eq!(attempts[0]["finishedAt"], Value::Null);

    // Delete the job, then the same id is gone.
    let (status, body) = harness.send("DELETE", &job_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["job"]["id"], json!(job_id));
    let (status, body) = harness.send("GET", &jobs_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["jobs"], json!([]));
    let (status, _body) = harness.send("DELETE", &job_path, None).await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    Ok(())
}

#[tokio::test]
async fn screened_approval_rejects_slop_and_lists_quality_gate_failures() -> TestResult {
    let harness = Harness::new("quality-gate")?;
    let account = harness.seed_account("e2e_gate").await?;
    let seeded = harness
        .seed_draft(
            &account.id,
            vec![new_candidate("a seeded candidate for the gate test", 8)],
            json!({"tweetType": "opinion"}),
        )
        .await?;
    let draft_id = seeded.draft.id.clone();

    let (status, body) = harness
        .send(
            "POST",
            &format!("/drafts/{draft_id}/approve"),
            Some(json!({"editedText": "this changes everything", "screened": true})),
        )
        .await?;
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(text(&body, "error")?.contains("Approval screen failed"));
    let reasons = body["screenFailed"]
        .as_array()
        .ok_or("screenFailed array")?;
    assert!(!reasons.is_empty(), "{body}");
    assert!(reasons.iter().all(|reason| reason.is_string()), "{body}");

    // A rejected screen must not create a job or approve the draft.
    let (status, body) = harness
        .send("GET", &format!("/jobs?accountId={}", account.id), None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["jobs"], json!([]));
    let (status, body) = harness
        .send("GET", &format!("/drafts/{draft_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(text(&body["draft"], "status")?, "selected");

    // The failures panel lists drafts generation marked with a failed gate.
    let gated = harness
        .seed_draft(
            &account.id,
            Vec::new(),
            json!({"qualityGate": {"passed": false, "reasons": ["too_short"]}}),
        )
        .await?;
    let (status, body) = harness
        .send("GET", "/drafts/quality-gate-failures", None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    let items = body["drafts"]
        .as_array()
        .ok_or("quality gate drafts array")?;
    assert_eq!(items.len(), 1, "{body}");
    assert_eq!(text(&items[0]["draft"], "id")?, gated.draft.id);
    assert_eq!(text(&items[0]["draft"], "status")?, "created");
    assert_eq!(
        items[0]["draft"]["metadata"]["qualityGate"]["passed"],
        json!(false)
    );
    assert_eq!(items[0]["qualityGate"]["reasons"][0], json!("too_short"));
    assert_eq!(items[0]["candidates"], json!([]));
    Ok(())
}

#[tokio::test]
async fn source_packet_create_list_feedback_delete_cascade() -> TestResult {
    let harness = Harness::new("packets")?;
    let account = harness.seed_account("e2e_packets").await?;

    let (status, body) = harness
        .send(
            "POST",
            "/source-packets",
            Some(json!({
                "accountId": account.id,
                "sourceType": "news",
                "title": "E2E packet title",
                "summary": "A deterministic summary written by the end to end test.",
                "facts": ["first fact", "second fact"],
                "url": "https://example.com/e2e-source",
                "tweetType": "opinion",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let packet = body.get("packet").ok_or("missing packet object")?.clone();
    let packet_id = text(&packet, "id")?;
    assert!(packet_id.starts_with("packet_"), "{packet}");
    assert_eq!(text(&packet, "accountId")?, account.id);
    assert_eq!(text(&packet, "sourceType")?, "news");
    assert_eq!(text(&packet, "title")?, "E2E packet title");
    assert_eq!(
        text(&packet, "summary")?,
        "A deterministic summary written by the end to end test."
    );
    assert_eq!(packet["facts"], json!(["first fact", "second fact"]));
    assert_eq!(text(&packet, "url")?, "https://example.com/e2e-source");
    assert_eq!(text(&packet, "tweetType")?, "opinion");
    assert_eq!(text(&packet, "status")?, "new");
    assert_eq!(packet["feedback"], Value::Null);

    let list_path = format!("/source-packets?accountId={}", account.id);
    let (status, body) = harness.send("GET", &list_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    let packets = body["packets"].as_array().ok_or("packets array")?;
    assert_eq!(packets.len(), 1);
    assert_eq!(packets[0]["id"], json!(packet_id));

    // Feedback is trimmed and persisted on the packet.
    let (status, body) = harness
        .send(
            "POST",
            &format!("/source-packets/{packet_id}/feedback"),
            Some(json!({"feedback": "  tighten the hook  "})),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(text(&body["packet"], "feedback")?, "tighten the hook");

    // Cascade delete reports the (absent) draft and removes the packet.
    let packet_path = format!("/source-packets/{packet_id}");
    let (status, body) = harness.send("DELETE", &packet_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deleted"], json!(true));
    assert_eq!(body["draftId"], Value::Null);
    assert_eq!(body["packet"]["id"], json!(packet_id));
    let (status, body) = harness.send("GET", &list_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["packets"], json!([]));
    let (status, body) = harness.send("DELETE", &packet_path, None).await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(text(&body, "error")?.contains("not found"));

    // Validation: accountId is required.
    let (status, body) = harness
        .send(
            "POST",
            "/source-packets",
            Some(json!({"sourceType": "news", "title": "x", "summary": "y"})),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], json!("Invalid request"));
    Ok(())
}

#[tokio::test]
async fn ingest_configs_crud_default_news_and_sources() -> TestResult {
    let harness = Harness::new("ingest")?;
    let account = harness.seed_account("e2e_ingest").await?;

    let (status, body) = harness.send("GET", "/ingest-configs", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["configs"], json!([]));

    // Default-news seeding is a database insert, no adapter or network call.
    let (status, body) = harness
        .send("POST", "/ingest-configs/default-news", None)
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(body["created"], json!(true));
    let default_config = body.get("config").ok_or("missing config object")?.clone();
    let default_id = text(&default_config, "id")?;
    assert!(default_id.starts_with("ingest_"), "{default_config}");
    // Default-news attaches to the first enabled account; the seeded
    // `account_personal` comes before the account created in this test.
    assert_eq!(text(&default_config, "accountId")?, "account_personal");
    assert_eq!(text(&default_config, "sourceType")?, "news");
    assert_eq!(default_config["maxPacketsPerDay"], json!(4));
    assert_eq!(text(&default_config, "scheduleWindowStart")?, "00:00");
    assert_eq!(text(&default_config, "scheduleWindowEnd")?, "23:59");
    assert_eq!(default_config["tweetTypeMix"], json!({"useful_info": 100}));
    assert_eq!(default_config["enabled"], json!(true));

    // A second call reuses the enabled news config instead of duplicating it.
    let (status, body) = harness
        .send("POST", "/ingest-configs/default-news", None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["created"], json!(false));
    assert_eq!(body["config"]["id"], json!(default_id));

    let (status, body) = harness
        .send(
            "POST",
            "/ingest-configs",
            Some(json!({
                "accountId": account.id,
                "sourceType": "feed",
                "maxPacketsPerDay": 3,
                "metadata": {"includeReddit": true},
                "tweetTypeMix": {"guide": 50, "useful_info": 50},
                "scheduleWindowStart": "08:00",
                "scheduleWindowEnd": "20:00",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let config = body.get("config").ok_or("missing config object")?.clone();
    let config_id = text(&config, "id")?;
    assert_eq!(text(&config, "sourceType")?, "feed");
    assert_eq!(config["maxPacketsPerDay"], json!(3));
    assert_eq!(config["metadata"]["includeReddit"], json!(true));
    assert_eq!(config["tweetTypeMix"]["guide"], json!(50));
    assert_eq!(text(&config, "scheduleWindowStart")?, "08:00");
    assert_eq!(text(&config, "scheduleWindowEnd")?, "20:00");

    let config_path = format!("/ingest-configs/{config_id}");
    let (status, body) = harness
        .send(
            "PATCH",
            &config_path,
            Some(json!({"enabled": false, "maxPacketsPerDay": 7})),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["config"]["enabled"], json!(false));
    assert_eq!(body["config"]["maxPacketsPerDay"], json!(7));
    assert_eq!(text(&body["config"], "sourceType")?, "feed");

    let (status, body) = harness.send("GET", "/ingest-sources", None).await?;
    assert_eq!(status, StatusCode::OK);
    let sources = body["sources"].as_array().ok_or("sources array")?;
    assert!(sources.len() >= 5, "{body}");
    let names: Vec<&str> = sources
        .iter()
        .filter_map(|source| source["name"].as_str())
        .collect();
    assert_eq!(names.len(), sources.len(), "{body}");
    assert!(names.contains(&"aggregated-news"), "{names:?}");
    assert!(
        sources.iter().all(|source| source["sourceType"]
            .as_str()
            .is_some_and(|kind| !kind.is_empty())),
        "{body}"
    );
    let aggregated = sources
        .iter()
        .find(|source| source["name"] == json!("aggregated-news"))
        .ok_or("aggregated-news source")?;
    assert!(aggregated["health"].is_array(), "{aggregated}");
    assert!(
        sources.iter().any(|source| source["health"].is_null()),
        "non-aggregated adapters report null health"
    );
    let mut sorted = names.clone();
    sorted.sort_unstable();
    assert_eq!(names, sorted, "sources must be sorted by name");

    let (status, body) = harness.send("DELETE", &config_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["config"]["id"], json!(config_id));
    let (status, _body) = harness.send("DELETE", &config_path, None).await?;
    assert_eq!(status, StatusCode::NOT_FOUND);
    Ok(())
}

#[tokio::test]
async fn system_feedback_round_trip_writes_notebook_inside_temp_root() -> TestResult {
    let harness = Harness::new("system-feedback")?;
    let account = harness.seed_account("e2e_feedback").await?;

    // Point the notebook writer at this test's temp root so nothing escapes it.
    let feedback_dir = harness.root.join("feedback-notebook");
    let feedback_dir_text = feedback_dir.to_string_lossy().to_string();
    let (status, body) = harness
        .send(
            "PATCH",
            "/settings",
            Some(json!({"feedbackDir": feedback_dir_text})),
        )
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(text(&body, "feedbackDir")?, feedback_dir_text);
    assert_eq!(body["restartRequired"], json!(false));

    let (status, body) = harness
        .send(
            "POST",
            "/system-feedback",
            Some(json!({
                "accountId": account.id,
                "text": "no em dashes in generated posts",
            })),
        )
        .await?;
    assert_eq!(status, StatusCode::CREATED);
    let item = body.get("item").ok_or("missing item object")?.clone();
    let item_id = text(&item, "id")?;
    assert!(item_id.starts_with("feedback_"), "{item}");
    assert_eq!(text(&item, "accountId")?, account.id);
    assert_eq!(text(&item, "text")?, "no em dashes in generated posts");
    assert!(text(&item, "createdAt")?.contains('T'));

    let notebook = std::fs::read_to_string(feedback_dir.join("notebook.md"))?;
    assert!(notebook.contains("[standing]"), "{notebook}");
    assert!(
        notebook.contains("no em dashes in generated posts"),
        "{notebook}"
    );

    let list_path = format!("/system-feedback?accountId={}", account.id);
    let (status, body) = harness.send("GET", &list_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    let items = body["items"].as_array().ok_or("items array")?;
    assert_eq!(items.len(), 1);
    assert_eq!(items[0]["id"], json!(item_id));

    // Empty text is rejected by the route validation.
    let (status, body) = harness
        .send(
            "POST",
            "/system-feedback",
            Some(json!({"accountId": account.id, "text": ""})),
        )
        .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["error"], json!("Invalid request"));

    let (status, body) = harness
        .send("DELETE", &format!("/system-feedback/{item_id}"), None)
        .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["deleted"], json!(true));
    let (status, body) = harness.send("GET", &list_path, None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["items"], json!([]));
    Ok(())
}

#[tokio::test]
async fn history_and_generation_reads_without_provider_calls() -> TestResult {
    let harness = Harness::new("history-generation")?;
    let account = harness.seed_account("e2e_history").await?;

    let (status, body) = harness.send("GET", "/history", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["history"], json!([]));

    let seeded = harness
        .seed_draft(&account.id, Vec::new(), json!({}))
        .await?;
    harness
        .state
        .repository()
        .create_post_history(NewPostHistory {
            account_id: account.id.clone(),
            draft_id: seeded.draft.id.clone(),
            posted_text: "a posted sentence for the history route".to_string(),
            post_url: Some("https://x.com/e2e/status/1".to_string()),
            source_packet_id: None,
            source_type: Some("news".to_string()),
            source_title: Some("E2E source".to_string()),
            source_url: None,
            tweet_type: Some("opinion".to_string()),
            metadata: Map::new(),
        })
        .await?;

    let (status, body) = harness.send("GET", "/history", None).await?;
    assert_eq!(status, StatusCode::OK);
    let history = body["history"].as_array().ok_or("history array")?;
    assert_eq!(history.len(), 1);
    assert!(text(&history[0], "id")?.starts_with("history_"));
    assert_eq!(text(&history[0], "accountId")?, account.id);
    assert_eq!(text(&history[0], "draftId")?, seeded.draft.id);
    assert_eq!(
        text(&history[0], "postedText")?,
        "a posted sentence for the history route"
    );
    assert_eq!(text(&history[0], "postUrl")?, "https://x.com/e2e/status/1");
    assert_eq!(text(&history[0], "sourceType")?, "news");
    assert_eq!(text(&history[0], "tweetType")?, "opinion");
    assert!(text(&history[0], "postedAt")?.contains('T'));

    // GET /generation resolves the configured provider from env/config only;
    // it never calls the provider.
    let (status, body) = harness.send("GET", "/generation", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert!(!text(&body["generation"], "provider")?.is_empty());
    assert!(!text(&body["generation"], "model")?.is_empty());
    assert!(body["generation"]["configured"].is_boolean());
    let providers = body["providers"].as_object().ok_or("providers object")?;
    for provider in ["command-code", "gemini", "ollama", "opencode"] {
        assert!(providers.contains_key(provider), "{body}");
    }
    let opencode = providers
        .get("opencode")
        .and_then(Value::as_array)
        .ok_or("opencode model list")?;
    assert!(
        opencode
            .iter()
            .any(|model| model == "opencode/glm-5.3-flash-free"),
        "{opencode:?}"
    );
    Ok(())
}
