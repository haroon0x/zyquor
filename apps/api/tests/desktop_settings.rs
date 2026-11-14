//! Live generation hot-swap, the injected desktop-settings plane, and the
//! `autoApproveSourcePackets` gate.
//!
//! Parity contract: `apps/api/src/routes/generation.ts`, `routes/settings.ts`,
//! `routes/system.ts` and `routes/source-packets.ts` in the retired TypeScript
//! tree (`git show 7ebbe9c^:<path>`). The API crate is exercised through its
//! real axum router with the desktop settings plane injected the same way the
//! Tauri shell injects it (`AppState::set_desktop_settings`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::{Map, Value, json};
use tower::ServiceExt;
use zyquor_api::{AppState, BuildAppOptions, DesktopSettingsPlane, build_app};
use zyquor_generation::providers::{DraftFuture, DraftGenerationProvider};
use zyquor_generation::types::{GenerateDraftCandidatesInput, GeneratedDraftCandidate};

type TestResult = Result<(), Box<dyn std::error::Error>>;

/// Candidate the fake provider returns: concrete, clean text that clears the
/// quality floor the automation deps are configured with below (`1`).
const PASSING_CANDIDATE: &str = "Shipped a 40-line change to the router that cut p95 latency from 900ms to 210ms because we stopped re-parsing the config.";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

struct FakeProvider;

impl DraftGenerationProvider for FakeProvider {
    fn name(&self) -> &str {
        "fake"
    }

    fn model(&self) -> &str {
        "fake-1"
    }

    fn generate_draft_candidates<'a>(
        &'a self,
        _input: &'a GenerateDraftCandidatesInput,
    ) -> DraftFuture<'a> {
        Box::pin(async move {
            Ok(vec![GeneratedDraftCandidate {
                text: PASSING_CANDIDATE.to_string(),
                quality: 9,
                provider: "fake".to_string(),
                model: "fake-1".to_string(),
                rank: 1,
            }])
        })
    }
}

/// Stand-in for the Tauri `desktopSettings` plane. `get`/`update` mirror the
/// TS semantics: `update` merges, empty strings delete, and the full settings
/// come back.
struct FakeSettings {
    current: Mutex<Map<String, Value>>,
    updates: AtomicUsize,
}

impl FakeSettings {
    fn new(initial: Value) -> Self {
        Self {
            current: Mutex::new(initial.as_object().cloned().unwrap_or_default()),
            updates: AtomicUsize::new(0),
        }
    }

    fn snapshot(&self) -> Map<String, Value> {
        match self.current.lock() {
            Ok(current) => current.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        }
    }

    fn update_count(&self) -> usize {
        self.updates.load(Ordering::SeqCst)
    }
}

impl DesktopSettingsPlane for FakeSettings {
    fn get(&self) -> Map<String, Value> {
        self.snapshot()
    }

    fn update(&self, patch: Map<String, Value>) -> Map<String, Value> {
        self.updates.fetch_add(1, Ordering::SeqCst);
        let mut current = match self.current.lock() {
            Ok(current) => current,
            Err(poisoned) => poisoned.into_inner(),
        };
        for (key, value) in patch {
            if matches!(&value, Value::String(text) if text.is_empty()) {
                current.remove(&key);
            } else {
                current.insert(key, value);
            }
        }
        current.clone()
    }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/// Paths for one test's scratch artifacts. A fresh directory per test id.
fn artifact_paths(label: &str) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!(
        "zyquor-api-settings-{label}-{}",
        std::process::id()
    ));
    (dir.join("app.sqlite"), dir.join("generation.json"))
}

fn state(label: &str, settings: Option<Arc<FakeSettings>>, enable_post: bool) -> TestResult2 {
    let (db_path, generation_path) = artifact_paths(label);
    if let Some(dir) = db_path.parent() {
        let _ = std::fs::remove_dir_all(dir);
        let _ = std::fs::create_dir_all(dir);
    }
    let repository = zyquor_storage::SqliteRepository::open(&db_path)?;

    // Keep generation offline: the fake provider answers every call.
    let mut settings_env = HashMap::new();
    settings_env.insert("ZYQUOR_LLM_PROVIDER".to_string(), "ollama".to_string());
    // The packet-draft auto-approve lane scores candidates against this floor.
    settings_env.insert("ZYQUOR_QUALITY_MIN".to_string(), "1".to_string());

    let options = BuildAppOptions {
        generation_config_path: Some(Some(generation_path.to_string_lossy().to_string())),
        generation_provider: Some(Arc::new(FakeProvider)),
        settings_env: Some(settings_env),
        enable_browser_post: enable_post,
        ..BuildAppOptions::default()
    };
    let app_state = AppState::new(repository, db_path, &options).map_err(std::io::Error::other)?;
    if let Some(settings) = settings {
        let plane: Arc<dyn DesktopSettingsPlane> = settings;
        app_state.set_desktop_settings(plane);
    }
    Ok(app_state)
}

type TestResult2 = Result<AppState, Box<dyn std::error::Error>>;

async fn send(
    app: axum::Router,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<(StatusCode, Value), Box<dyn std::error::Error>> {
    let request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    let request = match body {
        Some(body) => request.body(Body::from(body.to_string()))?,
        None => request.body(Body::empty())?,
    };
    let response = app.oneshot(request).await?;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024).await?;
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap_or(Value::Null)
    };
    Ok((status, value))
}

async fn create_account(state: &AppState) -> Result<String, Box<dyn std::error::Error>> {
    let account = state
        .repository()
        .create_account("tester", "Tester", "profiles/tester", "style_tester")
        .await?;
    Ok(account.id)
}

fn packet_body(account_id: &str, title: &str) -> Value {
    json!({
        "accountId": account_id,
        "sourceType": "x-feed",
        "title": title,
        "summary": "The router parses its config once per request instead of twice, which removes a full parse from the hot path.",
        "facts": [
            "Config parsing moved out of the request loop.",
            "The hot path now reuses the parsed config from the previous request."
        ],
        "tweetType": "feed_observation"
    })
}

// ---------------------------------------------------------------------------
// A1: live generation provider hot-swap
// ---------------------------------------------------------------------------

#[tokio::test]
async fn generation_patch_hot_swaps_between_opencode_models() -> TestResult {
    let app_state = state("generation-hot-swap", None, false)?;
    let app = build_app(app_state);

    let (status, body) = send(
        app.clone(),
        "PATCH",
        "/generation",
        Some(json!({
            "provider": "opencode",
            "model": "opencode/glm-5.3-flash-free"
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["generation"]["provider"], json!("opencode"));
    assert_eq!(
        body["generation"]["model"],
        json!("opencode/glm-5.3-flash-free")
    );

    let (status, health) = send(app.clone(), "GET", "/health", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["generation"]["provider"], json!("opencode"));
    assert_eq!(
        health["generation"]["model"],
        json!("opencode/glm-5.3-flash-free")
    );

    let (status, body) = send(
        app.clone(),
        "PATCH",
        "/generation",
        Some(json!({
            "provider": "opencode",
            "model": "opencode-go/glm-5.3-flash"
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");

    // GET /generation, /health and /system/status all reflect the live swap.
    let (status, body) = send(app.clone(), "GET", "/generation", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["generation"]["provider"], json!("opencode"));
    assert_eq!(
        body["generation"]["model"],
        json!("opencode-go/glm-5.3-flash")
    );

    let (status, health) = send(app.clone(), "GET", "/health", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        health["generation"]["model"],
        json!("opencode-go/glm-5.3-flash")
    );

    let (status, system) = send(app, "GET", "/system/status", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(system["generation"]["provider"], json!("opencode"));
    assert_eq!(
        system["generation"]["model"],
        json!("opencode-go/glm-5.3-flash")
    );

    // The saved generation config follows the swap (TS `writeSavedGenerationEnv`).
    let (_, generation_path) = artifact_paths("generation-hot-swap");
    let saved = std::fs::read_to_string(&generation_path)?;
    assert!(saved.contains("\"opencode-go/glm-5.3-flash\""), "{saved}");
    Ok(())
}

#[tokio::test]
async fn generation_patch_rejects_an_unknown_provider() -> TestResult {
    let app_state = state("generation-invalid", None, false)?;
    let app = build_app(app_state);

    let (status, _body) = send(
        app,
        "PATCH",
        "/generation",
        Some(json!({"provider": "not-a-provider", "model": "x"})),
    )
    .await?;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    Ok(())
}

// ---------------------------------------------------------------------------
// A2: injected desktop settings plane
// ---------------------------------------------------------------------------

#[tokio::test]
async fn settings_round_trip_masks_and_side_effects() -> TestResult {
    let settings = Arc::new(FakeSettings::new(json!({
        "geminiApiKey": "abcdefgh",
        "feedbackDir": "/tmp/feedback"
    })));
    let app_state = state("settings-round-trip", Some(settings.clone()), false)?;
    let app = build_app(app_state);

    // GET masks the API key (TS `maskSettings`).
    let (status, body) = send(app.clone(), "GET", "/settings", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["geminiApiKey"], json!("****efgh"));
    assert_eq!(body["feedbackDir"], json!("/tmp/feedback"));

    // Re-submitting the masked key means unchanged; browser/cdp effects apply.
    let (status, body) = send(
        app.clone(),
        "PATCH",
        "/settings",
        Some(json!({
            "geminiApiKey": "****efgh",
            "enableBrowserPrepare": false,
            "enableBrowserPost": true,
            "cdpPort": 9333
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["restartRequired"], json!(false));
    assert_eq!(body["geminiApiKey"], json!("****efgh"));
    assert_eq!(body["enableBrowserPrepare"], json!(false));
    assert_eq!(body["enableBrowserPost"], json!(true));

    // The injected plane owns the values (the key was not overwritten).
    let stored = settings.snapshot();
    assert_eq!(stored["geminiApiKey"], json!("abcdefgh"));
    assert_eq!(stored["enableBrowserPrepare"], json!(false));
    assert_eq!(stored["enableBrowserPost"], json!(true));
    assert_eq!(stored["cdpPort"], json!(9333));

    // Browser flag side effects are visible in /system/status.
    let (status, system) = send(app.clone(), "GET", "/system/status", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(system["posting"]["enablePrepare"], json!(false));
    assert_eq!(system["posting"]["enablePost"], json!(true));
    assert_eq!(system["posting"]["cdpUrl"], json!("http://127.0.0.1:9333"));

    // Empty strings are dropped from the route patch (TS route parity), so the
    // stored value is left untouched — not overwritten and not deleted.
    let (status, body) = send(
        app.clone(),
        "PATCH",
        "/settings",
        Some(json!({"feedbackDir": "", "llmProvider": ""})),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["feedbackDir"], json!("/tmp/feedback"), "{body}");
    assert_eq!(settings.snapshot()["feedbackDir"], json!("/tmp/feedback"));

    // A direct `desktopSettings.update` (the Tauri IPC path) does delete on an
    // empty string, like the TS `update`.
    let mut direct_patch = Map::new();
    direct_patch.insert("feedbackDir".to_string(), json!(""));
    let updated = DesktopSettingsPlane::update(settings.as_ref(), direct_patch);
    assert!(updated.get("feedbackDir").is_none(), "{updated:?}");
    assert!(!settings.snapshot().contains_key("feedbackDir"));

    // Every write went through the injected plane, never a local store.
    assert!(settings.update_count() >= 2);
    Ok(())
}

#[tokio::test]
async fn llm_provider_patch_swaps_the_live_provider() -> TestResult {
    let settings = Arc::new(FakeSettings::new(json!({})));
    let app_state = state("settings-generation", Some(settings.clone()), false)?;
    let app = build_app(app_state);

    let (status, body) = send(
        app.clone(),
        "PATCH",
        "/settings",
        Some(json!({"llmProvider": "opencode"})),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["restartRequired"], json!(false));
    assert_eq!(body["llmProvider"], json!("opencode"));

    // Live provider swapped: /generation and /health both report opencode.
    let (status, generation) = send(app.clone(), "GET", "/generation", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(generation["generation"]["provider"], json!("opencode"));
    let (status, health) = send(app.clone(), "GET", "/health", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["generation"]["provider"], json!("opencode"));
    assert_eq!(
        health["generation"]["model"],
        generation["generation"]["model"]
    );

    // The desktop settings panel stays in step (TS route also writes saved env).
    assert_eq!(settings.snapshot()["llmProvider"], json!("opencode"));
    let (_, generation_path) = artifact_paths("settings-generation");
    let saved = std::fs::read_to_string(&generation_path)?;
    assert!(saved.contains("\"opencode\""), "{saved}");

    // A provider that cannot be built reports restartRequired=true and leaves
    // the live provider unchanged (gemini requires ZYQUOR_GEMINI_API_KEY).
    let (status, body) = send(
        app.clone(),
        "PATCH",
        "/settings",
        Some(json!({"llmProvider": "gemini"})),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["restartRequired"], json!(true));
    let (status, health) = send(app, "GET", "/health", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(health["generation"]["provider"], json!("opencode"));
    Ok(())
}

#[tokio::test]
async fn system_posting_persists_through_the_injected_plane() -> TestResult {
    let settings = Arc::new(FakeSettings::new(json!({})));
    let app_state = state("system-posting", Some(settings.clone()), false)?;
    let app = build_app(app_state);

    let (status, body) = send(
        app.clone(),
        "POST",
        "/system/posting",
        Some(json!({
            "enablePost": true,
            "enablePrepare": true,
            "autoApproveSourcePackets": true
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enablePost"], json!(true));
    assert_eq!(body["enablePrepare"], json!(true));
    assert_eq!(body["autoApproveSourcePackets"], json!(true));
    assert_eq!(settings.snapshot()["enableBrowserPost"], json!(true));
    assert_eq!(settings.snapshot()["enableBrowserPrepare"], json!(true));
    assert_eq!(settings.snapshot()["autoApproveSourcePackets"], json!(true));

    let (status, body) = send(
        app.clone(),
        "POST",
        "/system/posting",
        Some(json!({"autoApproveSourcePackets": false})),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["autoApproveSourcePackets"], json!(false));

    let (status, system) = send(app, "GET", "/system/status", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(system["posting"]["autoApproveSourcePackets"], json!(false));
    assert_eq!(system["posting"]["enablePost"], json!(true));
    Ok(())
}

#[tokio::test]
async fn standalone_api_keeps_the_process_store_fallback() -> TestResult {
    // No injected plane: the routes stay available with the process-level
    // store (the documented deviation from the TS 404 behaviour).
    let app = build_app(state("settings-fallback", None, false)?);

    let (status, body) = send(
        app.clone(),
        "PATCH",
        "/settings",
        Some(json!({"enableBrowserPost": true, "autoApproveSourcePackets": true})),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["enableBrowserPost"], json!(true));

    let (status, body) = send(app.clone(), "GET", "/settings", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enableBrowserPost"], json!(true));

    // The generation hot-swap still works without a settings plane.
    let (status, body) = send(
        app,
        "PATCH",
        "/generation",
        Some(json!({
            "provider": "opencode",
            "model": "opencode/deepseek-v4.1-flash"
        })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    Ok(())
}

// ---------------------------------------------------------------------------
// A3: autoApproveSourcePackets gate
// ---------------------------------------------------------------------------

#[tokio::test]
async fn auto_approve_gate_honours_the_injected_setting() -> TestResult {
    let settings = Arc::new(FakeSettings::new(json!({
        "autoApproveSourcePackets": false
    })));
    // Posting is enabled, so the failure must come from the settings term.
    let app_state = state("auto-approve-gate", Some(settings.clone()), true)?;
    let app = build_app(app_state.clone());
    let account_id = create_account(&app_state).await?;

    let (status, body) = send(
        app.clone(),
        "POST",
        "/source-packets",
        Some(packet_body(&account_id, "Router config parsing")),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let packet_id = body["packet"]["id"]
        .as_str()
        .ok_or("packet id missing")?
        .to_string();

    // Gate off: the requested auto-approve is ignored and the draft waits for
    // review (TS: "automated posting is off; drafting for review").
    let (status, body) = send(
        app.clone(),
        "POST",
        &format!("/source-packets/{packet_id}/draft"),
        Some(json!({"autoApprove": true, "mode": "autopost"})),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(body["approved"].is_null(), "{body}");
    assert!(!body["draft"].is_null(), "{body}");

    // Turn the setting on through the injected plane, then a second packet
    // auto-approves into a queued job.
    let (status, body) = send(
        app.clone(),
        "POST",
        "/system/posting",
        Some(json!({"autoApproveSourcePackets": true})),
    )
    .await?;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["autoApproveSourcePackets"], json!(true));

    let (status, body) = send(
        app.clone(),
        "POST",
        "/source-packets",
        Some(packet_body(&account_id, "Config parser allocations")),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    let packet_id = body["packet"]["id"]
        .as_str()
        .ok_or("packet id missing")?
        .to_string();

    let (status, body) = send(
        app,
        "POST",
        &format!("/source-packets/{packet_id}/draft"),
        Some(json!({"autoApprove": true, "mode": "autopost"})),
    )
    .await?;
    assert_eq!(status, StatusCode::CREATED, "{body}");
    assert!(!body["approved"].is_null(), "{body}");
    assert_eq!(body["approved"]["job"]["mode"], json!("autopost"), "{body}");
    Ok(())
}
