//! The desktop control surface (`/system/logs`, `/system/worker/pause`,
//! `/system/chrome/close`, `/system/stop-all`, `/system/quit`,
//! `/system/restart`) exists only when the Tauri shell injects a
//! [`zyquor_api::DesktopControlPlane`]. These tests pin both halves: the
//! standalone API keeps the TS behaviour of not registering the routes, and
//! the injected control gets the JSON shapes the web System panel reads.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use axum::body::Body;
use axum::http::{Request, StatusCode};
use futures::future::BoxFuture;
use serde_json::{Value, json};
use tower::ServiceExt;
use zyquor_api::{AppState, BuildAppOptions, DesktopControlPlane, build_app};

type TestResult = Result<(), Box<dyn std::error::Error>>;

struct FakeControl {
    paused: AtomicBool,
    chrome_closed: AtomicBool,
    log_calls: AtomicUsize,
    quit_requested: AtomicBool,
    restart_requested: AtomicBool,
}

impl FakeControl {
    fn new() -> Self {
        Self {
            paused: AtomicBool::new(false),
            chrome_closed: AtomicBool::new(false),
            log_calls: AtomicUsize::new(0),
            quit_requested: AtomicBool::new(false),
            restart_requested: AtomicBool::new(false),
        }
    }
}

impl DesktopControlPlane for FakeControl {
    fn status(&self) -> BoxFuture<'_, Value> {
        let paused = self.paused.load(Ordering::SeqCst);
        Box::pin(async move {
            json!({
                "appVersion": "test",
                "chromeConnected": false,
                "platform": "linux",
                "workerPaused": paused,
            })
        })
    }

    fn log_tail(&self, lines: usize) -> Vec<String> {
        self.log_calls.fetch_add(1, Ordering::SeqCst);
        vec![format!("tail-{lines}")]
    }

    fn worker_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    fn set_worker_paused(&self, paused: bool) -> bool {
        self.paused.store(paused, Ordering::SeqCst);
        paused
    }

    fn close_chrome(&self) -> BoxFuture<'_, Value> {
        self.chrome_closed.store(true, Ordering::SeqCst);
        Box::pin(async { json!({ "closed": true }) })
    }

    fn request_quit(&self) {
        self.quit_requested.store(true, Ordering::SeqCst);
    }

    fn request_restart(&self) {
        self.restart_requested.store(true, Ordering::SeqCst);
    }
}

fn state(label: &str) -> Result<AppState, Box<dyn std::error::Error>> {
    let path = std::env::temp_dir().join(format!(
        "zyquor-api-desktop-{label}-{}-{:?}.sqlite",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_file(&path);
    let repository = zyquor_storage::SqliteRepository::open(&path)?;
    let state = AppState::new(repository, path, &BuildAppOptions::default())
        .map_err(std::io::Error::other)?;
    Ok(state)
}

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

#[tokio::test]
async fn standalone_api_keeps_desktop_routes_unregistered() -> TestResult {
    let app = build_app(state("standalone")?);

    let (status, body) = send(app.clone(), "GET", "/system/logs", None).await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    let (status, body) = send(app.clone(), "POST", "/system/worker/pause", Some(json!({}))).await?;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    let (status, body) = send(app, "GET", "/system/status", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert!(body["desktop"].is_null(), "{body}");
    assert_eq!(body["worker"]["paused"], json!(false));
    Ok(())
}

#[tokio::test]
async fn injected_control_serves_the_web_panel_shapes() -> TestResult {
    let app_state = state("injected")?;
    let control = Arc::new(FakeControl::new());
    app_state.set_desktop_control(control.clone());
    let app = build_app(app_state);

    let (status, body) = send(app.clone(), "GET", "/system/status", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["desktop"]["appVersion"], json!("test"));
    assert_eq!(body["desktop"]["platform"], json!("linux"));
    assert_eq!(body["worker"]["paused"], json!(false));

    let (status, body) = send(app.clone(), "GET", "/system/logs?lines=7", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["lines"], json!(["tail-7"]));
    assert_eq!(control.log_calls.load(Ordering::SeqCst), 1);

    // Omitted `paused` means pause (TS `body.paused !== false`).
    let (status, body) = send(app.clone(), "POST", "/system/worker/pause", Some(json!({}))).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["paused"], json!(true));
    assert!(control.worker_paused());

    let (status, body) = send(
        app.clone(),
        "POST",
        "/system/worker/pause",
        Some(json!({ "paused": false })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["paused"], json!(false));
    assert!(!control.worker_paused());

    let (status, body) = send(app.clone(), "POST", "/system/stop-all", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["workerPaused"], json!(true));
    assert_eq!(body["enablePost"], json!(false));
    assert_eq!(body["enablePrepare"], json!(false));
    assert_eq!(body["chrome"]["closed"], json!(true));
    assert_eq!(body["runningJobIds"], json!([]));
    assert!(control.chrome_closed.load(Ordering::SeqCst));

    let (status, body) = send(app.clone(), "POST", "/system/chrome/close", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["closed"], json!(true));

    let (status, body) = send(app.clone(), "POST", "/system/quit", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["quitting"], json!(true));
    assert!(control.quit_requested.load(Ordering::SeqCst));

    let (status, body) = send(app, "POST", "/system/restart", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["restarting"], json!(true));
    assert!(control.restart_requested.load(Ordering::SeqCst));
    Ok(())
}

#[tokio::test]
async fn posting_flags_round_trip_through_the_settings_store() -> TestResult {
    let app = build_app(state("posting")?);

    let (status, body) = send(
        app.clone(),
        "POST",
        "/system/posting",
        Some(json!({ "enablePrepare": true, "autoApproveSourcePackets": true })),
    )
    .await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["enablePrepare"], json!(true));
    assert_eq!(body["enablePost"], json!(false));
    assert_eq!(body["autoApproveSourcePackets"], json!(true));

    let (status, body) = send(app, "GET", "/system/status", None).await?;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["posting"]["enablePrepare"], json!(true));
    assert_eq!(body["posting"]["autoApproveSourcePackets"], json!(true));
    Ok(())
}
