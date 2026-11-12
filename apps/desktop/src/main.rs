//! Zyquor desktop shell (Tauri v2), ported from the Electron main in
//! `apps/desktop/src/main.ts`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod chrome;
mod controls;
mod log;
mod settings;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(windows)]
use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;
use tauri_plugin_opener::OpenerExt;
use zyquor_api::{AppState, BuildAppOptions};
use zyquor_worker::{WorkerHandle, WorkerOptions};

use controls::{ApiDesktopControl, ApiServerHandle, AppRuntime, DesktopControl, DesktopStatus};
use log::{flush_log_sync, init_file_log, log_line};
use settings::{
    DesktopSettings, apply_desktop_env_defaults, apply_settings_to_env, load_settings,
    settings_env_value,
};

const MENU_OPEN: &str = "open";
const MENU_RESTART_TO_UPDATE: &str = "restart-to-update";
const MENU_LAUNCH_POSTING_CHROME: &str = "launch-posting-chrome";
const MENU_STOP_EVERYTHING: &str = "stop-everything";
const MENU_QUIT: &str = "quit";
const WINDOW_LABEL: &str = "main";
const FAILURE_POLL_INTERVAL: Duration = Duration::from_secs(60);
const SETTLE_MS: u64 = 500;

/// Update status payload (`zyquor:update-status:get`), stubbed to `null`
/// at runtime — there is no Tauri updater equivalent to electron-updater
/// yet (see the module docs of the TS port rationale).
#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    pub state: String,
    pub version: Option<String>,
}

static UPDATE_STATUS: OnceLock<Mutex<Option<UpdateStatus>>> = OnceLock::new();
static UPDATE_READY_VERSION: OnceLock<Mutex<Option<String>>> = OnceLock::new();
static STOP_POLLING: AtomicBool = AtomicBool::new(false);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

fn update_status_store() -> &'static Mutex<Option<UpdateStatus>> {
    UPDATE_STATUS.get_or_init(|| Mutex::new(None))
}

fn update_ready_version() -> Option<String> {
    UPDATE_READY_VERSION
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Record a downloaded update (drives the "Restart to update" tray item).
/// Never called in this port: updater polling is stubbed (no Tauri
/// updater equivalent to electron-updater yet).
#[allow(dead_code)]
fn mark_update_ready(version: String) {
    if let Ok(mut guard) = UPDATE_READY_VERSION.get_or_init(|| Mutex::new(None)).lock() {
        *guard = Some(version);
        log_line("info", "updater update-downloaded");
    }
}

/// Publish an update status: keep the stored value for the
/// `zyquor:update-status:get` command, emit the
/// `zyquor:update-status` event and update the window's
/// `window.zyquor.updates` state (best-effort event wiring).
fn publish_update_status(app: &tauri::AppHandle, status: Option<UpdateStatus>) {
    if let Ok(mut guard) = update_status_store().lock() {
        *guard = status.clone();
    }
    use tauri::Emitter;
    let _ = app.emit("zyquor:update-status", &status);
    if status.is_some() {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let json = serde_json::to_string(&status).unwrap_or_else(|_| "null".to_string());
            let _ = window.eval(format!(
                "window.__zyquorDispatchUpdate && window.__zyquorDispatchUpdate({json});"
            ));
        }
    }
}

#[tauri::command]
fn update_status_get() -> Option<UpdateStatus> {
    update_status_store()
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
}

/// Status of the app (`desktopControl.status`), mirroring the TS IPC shape.
#[tauri::command]
async fn desktop_status(state: tauri::State<'_, AppRuntime>) -> Result<DesktopStatus, String> {
    Ok(DesktopControl::chrome_status(&state, &controls::base_cdp_url()).await)
}

/// Launch outcome for the `launch_posting_chrome` command
/// ({ launched, reason }), matching `launchPostingChrome`.
#[derive(Debug, Clone, Serialize)]
pub struct ChromeLaunchOutcome {
    pub launched: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaunchPostingChromeInput {
    account_id: String,
}

#[tauri::command]
async fn launch_posting_chrome(
    state: tauri::State<'_, AppRuntime>,
    input: LaunchPostingChromeInput,
) -> Result<ChromeLaunchOutcome, String> {
    let result =
        DesktopControl::launch_posting_chrome(&state, &input.account_id, &controls::base_cdp_url())
            .await;
    Ok(ChromeLaunchOutcome {
        launched: result.launched,
        reason: result.reason,
    })
}

/// Outcome of a `closeChrome` call ({ closed, reason }).
#[derive(Debug, Clone, Serialize)]
pub struct ChromeCloseOutcome {
    pub closed: bool,
    pub reason: Option<String>,
}

#[tauri::command]
async fn desktop_close_chrome(
    state: tauri::State<'_, AppRuntime>,
) -> Result<ChromeCloseOutcome, String> {
    let result = DesktopControl::close_chrome(&state, &controls::base_cdp_url()).await;
    Ok(ChromeCloseOutcome {
        closed: result.closed,
        reason: result.reason,
    })
}

#[tauri::command]
fn desktop_log_tail(lines: usize) -> Vec<String> {
    DesktopControl::log_tail(lines)
}

#[tauri::command]
async fn desktop_quit(state: tauri::State<'_, AppRuntime>) -> Result<(), String> {
    DesktopControl::quit(&state).await
}

#[tauri::command]
async fn desktop_restart(state: tauri::State<'_, AppRuntime>) -> Result<(), String> {
    DesktopControl::restart(&state).await
}

#[tauri::command]
fn desktop_set_worker_paused(state: tauri::State<'_, AppRuntime>, paused: bool) -> bool {
    DesktopControl::set_worker_paused(&state, paused)
}

/// Patch applied by `desktopSettings.update` (mirrors the TS semantics:
/// fields are replaced, empty strings delete the key, then the settings
/// are saved, applied to the env snapshot and the login item re-wired).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSettingsPatch {
    enable_browser_prepare: Option<bool>,
    enable_browser_post: Option<bool>,
    close_chrome_after_post: Option<bool>,
    headless: Option<bool>,
    command_code_path: Option<String>,
    opencode_path: Option<String>,
    opencode_variant: Option<String>,
    llm_provider: Option<String>,
    gemini_api_key: Option<String>,
    chrome_path: Option<String>,
    cdp_port: Option<u32>,
    start_with_windows: Option<bool>,
    feedback_dir: Option<String>,
    auto_approve_source_packets: Option<bool>,
}

fn set_string_setting(target: &mut Option<String>, patch: Option<String>) {
    if let Some(value) = patch {
        if value.is_empty() {
            *target = None;
        } else {
            *target = Some(value);
        }
    }
}

#[tauri::command]
fn desktop_settings_update(app: tauri::AppHandle, patch: DesktopSettingsPatch) -> DesktopSettings {
    let data_root = app.state::<AppRuntime>().data_root.clone();
    let mut current = load_settings(&data_root);
    if let Some(value) = patch.enable_browser_prepare {
        current.enable_browser_prepare = Some(value);
    }
    if let Some(value) = patch.enable_browser_post {
        current.enable_browser_post = Some(value);
    }
    if let Some(value) = patch.close_chrome_after_post {
        current.close_chrome_after_post = Some(value);
    }
    if let Some(value) = patch.headless {
        current.headless = Some(value);
    }
    set_string_setting(&mut current.command_code_path, patch.command_code_path);
    set_string_setting(&mut current.opencode_path, patch.opencode_path);
    set_string_setting(&mut current.opencode_variant, patch.opencode_variant);
    set_string_setting(&mut current.llm_provider, patch.llm_provider);
    set_string_setting(&mut current.gemini_api_key, patch.gemini_api_key);
    set_string_setting(&mut current.chrome_path, patch.chrome_path);
    if let Some(value) = patch.cdp_port {
        current.cdp_port = Some(value);
    }
    if let Some(value) = patch.start_with_windows {
        current.start_with_windows = Some(value);
    }
    set_string_setting(&mut current.feedback_dir, patch.feedback_dir);
    if let Some(value) = patch.auto_approve_source_packets {
        current.auto_approve_source_packets = Some(value);
    }
    settings::save_settings(&data_root, &current);
    apply_settings_to_env(&current, true);
    apply_login_item(&app, current.start_with_windows.unwrap_or(false));
    current
}

// ---------------------------------------------------------------------------
// Boot helpers shared by the GUI setup and --headless-smoke.
// ---------------------------------------------------------------------------

/// Load settings, filling the TS defaults for unset keys, then apply them
/// to the env snapshot exactly like `main.ts` does at startup.
fn load_desktop_settings(data_root: &Path) -> DesktopSettings {
    let loaded = load_settings(data_root);
    let settings = DesktopSettings {
        enable_browser_prepare: loaded.enable_browser_prepare.or(Some(true)),
        enable_browser_post: loaded.enable_browser_post.or(Some(true)),
        close_chrome_after_post: loaded.close_chrome_after_post.or(Some(true)),
        headless: loaded.headless,
        command_code_path: loaded.command_code_path,
        opencode_path: loaded.opencode_path,
        opencode_variant: loaded.opencode_variant,
        llm_provider: loaded.llm_provider.or(Some("opencode".to_string())),
        gemini_api_key: loaded.gemini_api_key,
        chrome_path: loaded.chrome_path,
        cdp_port: loaded.cdp_port.or(Some(9222)),
        start_with_windows: loaded.start_with_windows.or(Some(false)),
        feedback_dir: loaded.feedback_dir,
        auto_approve_source_packets: loaded.auto_approve_source_packets.or(Some(true)),
    };
    apply_settings_to_env(&settings, false);
    apply_desktop_env_defaults(&settings);
    settings
}

/// Snapshot of the effective settings env (the keys `settings.rs` knows)
/// for `BuildAppOptions::settings_env`.
fn collect_settings_env(headless: bool) -> HashMap<String, String> {
    const KEYS: &[&str] = &[
        "ZYQUOR_ENABLE_BROWSER_PREPARE",
        "ZYQUOR_ENABLE_BROWSER_POST",
        "ZYQUOR_BROWSER_CLOSE_AFTER_POST",
        "ZYQUOR_BROWSER_HEADLESS",
        "ZYQUOR_COMMAND_CODE_PATH",
        "ZYQUOR_OPENCODE_PATH",
        "ZYQUOR_OPENCODE_VARIANT",
        "ZYQUOR_LLM_PROVIDER",
        "ZYQUOR_GEMINI_API_KEY",
        "ZYQUOR_CHROME_PATH",
        "ZYQUOR_BROWSER_CDP_PORT",
        "ZYQUOR_BROWSER_CDP_URL",
        "ZYQUOR_COMMAND_CODE_MODEL",
        "ZYQUOR_OPENCODE_MODEL",
        "ZYQUOR_BROWSER_CHANNEL",
        "ZYQUOR_OLLAMA_BASE_URL",
        "ZYQUOR_QUALITY_MIN",
    ];
    let mut map = HashMap::new();
    for key in KEYS {
        if let Some(value) = settings_env_value(key) {
            map.insert((*key).to_string(), value);
        }
    }
    if headless {
        map.insert("ZYQUOR_ENABLE_BROWSER_PREPARE".to_string(), "0".to_string());
        map.insert("ZYQUOR_ENABLE_BROWSER_POST".to_string(), "0".to_string());
    }
    map
}

/// Effective boolean for a snapshot key with TS `!== "0"` semantics.
fn flag_from_snapshot(key: &str, default: bool) -> bool {
    settings_env_value(key)
        .map(|value| value != "0")
        .unwrap_or(default)
}

fn parse_env_u64(key: &str) -> Option<u64> {
    std::env::var(key).ok()?.parse().ok()
}

fn build_options(settings_env: HashMap<String, String>, headless: bool) -> BuildAppOptions {
    let browser_channel =
        settings_env_value("ZYQUOR_BROWSER_CHANNEL").filter(|channel| channel != "chromium");
    BuildAppOptions {
        enable_browser_prepare: !headless
            && flag_from_snapshot("ZYQUOR_ENABLE_BROWSER_PREPARE", true),
        enable_browser_post: !headless && flag_from_snapshot("ZYQUOR_ENABLE_BROWSER_POST", true),
        browser_action_delay_ms: parse_env_u64("ZYQUOR_BROWSER_ACTION_DELAY_MS"),
        browser_channel,
        browser_cdp_url: settings_env_value("ZYQUOR_BROWSER_CDP_URL"),
        browser_typing_delay_ms: parse_env_u64("ZYQUOR_BROWSER_TYPING_DELAY_MS"),
        close_after_prepare: Some(flag_from_snapshot(
            "ZYQUOR_BROWSER_CLOSE_AFTER_PREPARE",
            true,
        )),
        close_after_post: Some(flag_from_snapshot("ZYQUOR_BROWSER_CLOSE_AFTER_POST", true)),
        settings_env: Some(settings_env),
        ..BuildAppOptions::default()
    }
}

fn worker_options(api_url: &str) -> WorkerOptions {
    WorkerOptions {
        api_url: api_url.to_string(),
        should_continue: None,
        auto_seed_default_ingest: Some(
            std::env::var("ZYQUOR_WORKER_AUTO_SEED_DEFAULT_INGEST")
                .map(|value| value != "0")
                .unwrap_or(true),
        ),
        ingest_interval_ms: Some(
            parse_env_u64("ZYQUOR_WORKER_INGEST_INTERVAL_MS").unwrap_or(60_000),
        ),
        performance_interval_ms: None,
        mentions_interval_ms: None,
        poll_ms: parse_env_u64("ZYQUOR_WORKER_POLL_MS").unwrap_or(5_000),
    }
}

fn bind_api_listener() -> std::net::TcpListener {
    match std::net::TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(error) => {
            log_line("error", &format!("failed to bind api listener: {error}"));
            std::process::exit(2);
        }
    }
}

fn listener_port(listener: &std::net::TcpListener) -> u16 {
    listener
        .local_addr()
        .map(|address| address.port())
        .unwrap_or(0)
}

struct BackendHandles {
    worker: WorkerHandle,
    api: ApiServerHandle,
}

/// Start the backend (axum API + worker) on a dedicated std thread with its
/// own tokio runtime. The thread stays alive until the API server stops.
fn spawn_backend(
    api_state: AppState,
    std_listener: std::net::TcpListener,
    options: WorkerOptions,
) -> Result<BackendHandles, String> {
    let api_port = listener_port(&std_listener);
    let (ready_tx, ready_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = ready_tx.send(Err(format!("tokio runtime error: {error}")));
                return;
            }
        };
        runtime.block_on(async move {
            // Newer tokio refuses to register blocking sockets with the
            // runtime; `from_std` therefore needs the listener non-blocking.
            if let Err(error) = std_listener.set_nonblocking(true) {
                let _ = ready_tx.send(Err(format!("non-blocking listener error: {error}")));
                return;
            }
            let listener = match tokio::net::TcpListener::from_std(std_listener) {
                Ok(listener) => listener,
                Err(error) => {
                    let _ = ready_tx.send(Err(format!("listener error: {error}")));
                    return;
                }
            };
            let router = zyquor_api::build_app(api_state);
            let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
            let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
            let serve = axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            });
            let serve_task = tokio::spawn(async move {
                let _ = serve.await;
                let _ = done_tx.send(());
            });
            log_line("info", &format!("api listening on port {api_port}"));
            let worker = match zyquor_worker::start_worker(options) {
                Ok(handle) => handle,
                Err(error) => {
                    let _ = ready_tx.send(Err(format!("worker start error: {}", error.message())));
                    return;
                }
            };
            let api = ApiServerHandle::new(shutdown_tx, serve_task);
            let _ = ready_tx.send(Ok(BackendHandles { worker, api }));
            // Keep the runtime alive until the server stops.
            let _ = done_rx.await;
        });
    });
    match ready_rx.recv() {
        Ok(result) => result,
        Err(error) => Err(format!("backend thread exited: {error}")),
    }
}

/// TS `captureConsole` has no portable Rust equivalent: `println!` /
/// `eprintln!` cannot be intercepted portably, so only a startup line is
/// written to the log (the crate's own `log_line` calls still mirror the
/// TS console forwarding for everything the desktop owns).
fn zyquor_init_script(api_base_url: &str) -> String {
    format!(
        "window.zyquor = {{\n  apiBaseUrl: \"{api_base_url}\",\n  appVersion: \"{app_version}\",\n  updates: {{\n    getStatus: function() {{ return window.__zyquorUpdateStatus || null; }},\n    onStatus: function(cb) {{ (window.__zyquorUpdateListeners = window.__zyquorUpdateListeners || []).push(cb); }}\n  }}\n}};\nwindow.__zyquorUpdateStatus = null;\nwindow.__zyquorUpdateListeners = [];\nwindow.__zyquorDispatchUpdate = function(status) {{\n  window.__zyquorUpdateStatus = status;\n  (window.__zyquorUpdateListeners || []).forEach(function(cb) {{ try {{ cb(status); }} catch (e) {{}} }});\n}};\n",
        api_base_url = api_base_url,
        app_version = env!("CARGO_PKG_VERSION"),
    )
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn tray_icon_image() -> tauri::image::Image<'static> {
    // The flat-color 16x16 icon from `makeTrayIcon` in `main.ts`. Loading
    // the packaged `build/icon.png` needs Tauri's `image-png` feature,
    // which this crate does not enable; the synthetic icon matches the TS
    // fallback exactly.
    let size: u32 = 16;
    let mut buffer = vec![0_u8; (size * size * 4) as usize];
    for index in 0..(size * size) as usize {
        buffer[index * 4] = 0xf6;
        buffer[index * 4 + 1] = 0x82;
        buffer[index * 4 + 2] = 0x3b;
        buffer[index * 4 + 3] = 0xff;
    }
    tauri::image::Image::new_owned(buffer, size, size)
}

async fn fetch_failed_jobs(client: &reqwest::Client, api_url: &str) -> Result<usize, ()> {
    #[derive(Debug, Deserialize)]
    struct JobsResponse {
        jobs: Vec<JobView>,
    }
    #[derive(Debug, Deserialize)]
    struct JobView {
        status: String,
    }
    let response = client
        .get(format!("{api_url}/jobs"))
        .send()
        .await
        .map_err(|_| ())?;
    if !response.status().is_success() {
        return Err(());
    }
    let text = response.text().await.map_err(|_| ())?;
    let body: JobsResponse = serde_json::from_str(&text).map_err(|_| ())?;
    Ok(body
        .jobs
        .iter()
        .filter(|job| job.status == "failed")
        .count())
}

async fn spawn_blocking_list_accounts(db_path: PathBuf) -> Vec<zyquor_accounts::Account> {
    match tokio::task::spawn_blocking(move || {
        zyquor_storage::SqliteRepository::open(&db_path)
            .and_then(|repository| repository.list_accounts())
    })
    .await
    {
        Ok(Ok(accounts)) => accounts,
        _ => Vec::new(),
    }
}

/// `--headless-smoke`: boot the backend without any window or tray, probe
/// the API, ensure everything shuts down and report the result.
fn run_headless_smoke() -> i32 {
    let data_root = std::env::var("ZYQUOR_DATA_ROOT")
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::temp_dir().join("zyquor-headless"));
    init_file_log(&data_root);
    log_line("info", "app boot");
    let _ = load_desktop_settings(&data_root);
    let settings_env = collect_settings_env(true);
    let std_listener = bind_api_listener();
    let api_port = listener_port(&std_listener);
    let api_url = format!("http://127.0.0.1:{api_port}");
    let db_path = data_root.join("app.sqlite");
    let options = build_options(settings_env, true);

    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            log_line("error", &format!("headless runtime error: {error}"));
            eprintln!("HEADLESS SMOKE FAILED");
            return 1;
        }
    };
    let ok = runtime.block_on(async move {
        let repository = match zyquor_storage::SqliteRepository::open(&db_path) {
            Ok(repository) => repository,
            Err(error) => {
                log_line("error", &format!("headless repository error: {error}"));
                return false;
            }
        };
        let api_state = match AppState::new(repository, db_path.clone(), &options) {
            Ok(api_state) => api_state,
            Err(error) => {
                log_line("error", &format!("headless api state error: {error}"));
                return false;
            }
        };
        let control_slot = api_state.clone();
        let backend = match spawn_backend(api_state, std_listener, worker_options(&api_url)) {
            Ok(backend) => backend,
            Err(error) => {
                log_line("error", &format!("headless backend error: {error}"));
                return false;
            }
        };
        log_line("info", "worker started");

        let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let app_runtime = AppRuntime {
            worker_handle: Arc::new(backend.worker),
            started_at,
            api_port,
            db_path,
            data_root: data_root.clone(),
            api: Arc::new(backend.api),
        };
        control_slot.set_desktop_control(Arc::new(ApiDesktopControl::new(app_runtime.clone())));

        tokio::time::sleep(Duration::from_millis(SETTLE_MS)).await;

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        let mut all_ok = true;
        for path in [
            "/accounts",
            "/worker/status",
            "/system/status",
            "/system/logs?lines=5",
        ] {
            let url = format!("{api_url}{path}");
            match client.get(&url).send().await {
                Ok(response) => {
                    let status = response.status().as_u16();
                    if status != 200 {
                        eprintln!("FAIL: {path} returned {status}");
                        all_ok = false;
                        continue;
                    }
                    let body = response.text().await.unwrap_or_default();
                    // `/system/status` must carry the injected desktop block;
                    // a null `desktop` means the control plane was not wired.
                    if path == "/system/status" && !body.contains("\"desktop\":{") {
                        eprintln!("FAIL: {path} has no desktop block: {body}");
                        all_ok = false;
                        continue;
                    }
                    println!("OK: {path} → 200");
                }
                Err(error) => {
                    eprintln!("FAIL: {path} fetch error: {error}");
                    all_ok = false;
                }
            }
        }

        DesktopControl::shutdown_sequence(&app_runtime).await;
        all_ok
    });
    println!("HEADLESS SMOKE {}", if ok { "OK" } else { "FAILED" });
    if ok { 0 } else { 1 }
}

fn apply_login_item(app: &tauri::AppHandle, start_with_windows: bool) {
    // Mirrors `app.setLoginItemSettings` in `main.ts`: wired only on
    // Windows (the TS fallback to --hidden launch args is the autostart
    // plugin's `args`).
    #[cfg(windows)]
    {
        let manager = app.autolaunch();
        let result = if start_with_windows {
            manager.enable()
        } else {
            manager.disable()
        };
        if let Err(error) = result {
            log_line("warn", &format!("login item setting failed: {error}"));
        }
    }
    #[cfg(not(windows))]
    let _ = (app, start_with_windows);
}

fn run_setup(
    app: &mut tauri::App,
    std_listener: std::net::TcpListener,
    api_port: u16,
    hidden: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let data_root = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("zyquor"));
    init_file_log(&data_root);
    if let Some(log_path) = log::log_file_path() {
        log_line("info", &format!("log file: {}", log_path.display()));
    }
    log_line("info", "app boot");

    let desktop_settings = load_desktop_settings(&data_root);
    let settings_env = collect_settings_env(false);
    let db_path = data_root.join("app.sqlite");
    let options = build_options(settings_env, false);

    let repository = zyquor_storage::SqliteRepository::open(&db_path)?;
    let api_state = AppState::new(repository, db_path.clone(), &options)
        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
    // Cloned before the server thread takes ownership: the desktop-control
    // slot is shared by every clone, so injecting it after the worker/API
    // start is visible to the router immediately.
    let control_slot = api_state.clone();
    let api_url = format!("http://127.0.0.1:{api_port}");
    let backend = spawn_backend(api_state, std_listener, worker_options(&api_url))
        .map_err(|error| -> Box<dyn std::error::Error> { error.into() })?;
    log_line("info", "worker started");

    let started_at = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let runtime = AppRuntime {
        worker_handle: Arc::new(backend.worker),
        started_at,
        api_port,
        db_path: db_path.clone(),
        data_root: data_root.clone(),
        api: Arc::new(backend.api),
    };
    control_slot.set_desktop_control(Arc::new(ApiDesktopControl::new(runtime.clone())));
    let runtime_for_tasks = runtime.clone();
    app.manage(runtime);

    apply_login_item(
        app.handle(),
        desktop_settings.start_with_windows.unwrap_or(false),
    );

    // Tray (menu: Open / Restart to update [hidden] / Launch posting
    // Chrome / Stop everything / Quit; tooltip "Zyquor" by default).
    let open_item = MenuItem::with_id(app, MENU_OPEN, "Open", true, None::<&str>)?;
    let restart_item = MenuItem::with_id(
        app,
        MENU_RESTART_TO_UPDATE,
        "Restart to update",
        false,
        None::<&str>,
    )?;
    let launch_item = MenuItem::with_id(
        app,
        MENU_LAUNCH_POSTING_CHROME,
        "Launch posting Chrome",
        true,
        None::<&str>,
    )?;
    let stop_item = MenuItem::with_id(
        app,
        MENU_STOP_EVERYTHING,
        "Stop everything",
        true,
        None::<&str>,
    )?;
    let quit_item = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
    let separator_a = PredefinedMenuItem::separator(app)?;
    let separator_b = PredefinedMenuItem::separator(app)?;
    let tray_menu = Menu::with_items(
        app,
        &[
            &open_item,
            &restart_item,
            &separator_a,
            &launch_item,
            &stop_item,
            &separator_b,
            &quit_item,
        ],
    )?;

    let tray = tauri::tray::TrayIconBuilder::new()
        .icon(tray_icon_image())
        .tooltip("Zyquor")
        .menu(&tray_menu)
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    controls::register_tray_icon(tray);

    if hidden {
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            let _ = window.hide();
        }
    }

    // Publish the (stubbed) update status: always null here.
    publish_update_status(app.handle(), None);

    // The "Restart to update" item becomes enabled once an update is
    // downloaded. Updater polling is stubbed, so it never does — the item
    // stays disabled (Tauri menu items have no visible flag).

    // Failed-job tooltip poll (every 60 s, GET /jobs).
    let poll_api_url = format!("http://127.0.0.1:{}", runtime_for_tasks.api_port);
    tauri::async_runtime::spawn(async move {
        let api_url = poll_api_url;
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        loop {
            tokio::time::sleep(FAILURE_POLL_INTERVAL).await;
            if STOP_POLLING.load(Ordering::SeqCst) {
                break;
            }
            match fetch_failed_jobs(&client, &api_url).await {
                Ok(count) if count > 0 => {
                    controls::set_tray_tooltip(format!("Zyquor — {count} failed job(s)"))
                }
                Ok(_) => controls::set_tray_tooltip("Zyquor"),
                Err(()) => {}
            }
        }
    });

    // Startup: launch posting Chrome for every enabled account (as in
    // `main.ts`) and reflect the result in the tray tooltip.
    let startup_runtime = runtime_for_tasks.clone();
    tauri::async_runtime::spawn(async move {
        let accounts = spawn_blocking_list_accounts(startup_runtime.db_path.clone()).await;
        let enabled: Vec<zyquor_accounts::Account> = accounts
            .into_iter()
            .filter(|account| account.enabled)
            .collect();
        let base_cdp_url = controls::base_cdp_url();
        let results: Vec<_> = futures::future::join_all(enabled.iter().map(|account| {
            DesktopControl::launch_posting_chrome(&startup_runtime, &account.id, &base_cdp_url)
        }))
        .await;
        let launched = results
            .iter()
            .filter(|result| result.launched || result.reason.as_deref() == Some("already-running"))
            .count();
        let message = if launched > 0 {
            format!("Chrome connected ({launched}/{})", enabled.len())
        } else {
            "Chrome unavailable".to_string()
        };
        log_line(
            if launched > 0 { "info" } else { "warn" },
            &format!("startup chrome: {message}"),
        );
        controls::set_tray_tooltip(format!("Zyquor — {message}"));
    });

    Ok(())
}

fn main() {
    zyquor_core::dotenv::load();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let headless = args.iter().any(|arg| arg == "--headless-smoke");
    let hidden = args.iter().any(|arg| arg == "--hidden");

    // Crash handlers: log the panic, never kill the app from the hook
    // (mirrors the TS uncaughtException handler semantics).
    std::panic::set_hook(Box::new(|info| {
        log_line("error", &format!("panic: {info}"));
        flush_log_sync();
    }));

    if headless {
        let code = run_headless_smoke();
        std::io::Write::flush(&mut std::io::stdout()).ok();
        std::process::exit(code);
    }

    let std_listener = bind_api_listener();
    let api_port = listener_port(&std_listener);
    let api_url = format!("http://127.0.0.1:{api_port}");
    let init_script = zyquor_init_script(&api_url);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(
            |app: &tauri::AppHandle, _args: Vec<String>, _cwd: String| {
                show_main_window(app);
            },
        ))
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .app_name("Zyquor")
                .args(["--hidden"])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri::plugin::Builder::<tauri::Wry, ()>::new("zyquor-init")
                .js_init_script(init_script)
                .on_navigation(|webview, url| {
                    let current = webview.url().unwrap_or_else(|_| url.clone());
                    if url == &current {
                        return true;
                    }
                    if url.origin() == current.origin() {
                        return true;
                    }
                    let scheme = url.scheme();
                    if scheme == "http" || scheme == "https" {
                        if let Some(app) = webview.app_handle().try_state::<tauri::AppHandle>() {
                            let _ = app.opener().open_url(url.as_str(), None::<&str>);
                        }
                        return false;
                    }
                    log_line("warn", &format!("blocked navigation to {}", url.as_str()));
                    false
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            update_status_get,
            launch_posting_chrome,
            desktop_status,
            desktop_close_chrome,
            desktop_log_tail,
            desktop_quit,
            desktop_restart,
            desktop_set_worker_paused,
            desktop_settings_update,
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_OPEN => {
                show_main_window(app);
            }
            MENU_RESTART_TO_UPDATE => {
                let version = update_ready_version().unwrap_or_default();
                if version.is_empty() {
                    log_line(
                        "warn",
                        "restart to update requested while no update is ready",
                    );
                } else {
                    log_line(
                        "info",
                        &format!("restart to update requested (version {version})"),
                    );
                    let runtime = (*app.state::<AppRuntime>()).clone();
                    tauri::async_runtime::spawn(async move {
                        DesktopControl::shutdown_sequence(&runtime).await;
                        std::process::exit(0);
                    });
                }
            }
            MENU_LAUNCH_POSTING_CHROME => {
                let runtime = (*app.state::<AppRuntime>()).clone();
                tauri::async_runtime::spawn(async move {
                    let accounts = spawn_blocking_list_accounts(runtime.db_path.clone()).await;
                    let enabled: Vec<zyquor_accounts::Account> = accounts
                        .into_iter()
                        .filter(|account| account.enabled)
                        .collect();
                    let base_cdp_url = controls::base_cdp_url();
                    let results: Vec<_> =
                        futures::future::join_all(enabled.iter().map(|account| {
                            DesktopControl::launch_posting_chrome(
                                &runtime,
                                &account.id,
                                &base_cdp_url,
                            )
                        }))
                        .await;
                    let launched = results.iter().any(|result| result.launched);
                    let reason = results
                        .iter()
                        .find(|result| !result.launched)
                        .and_then(|result| result.reason.clone())
                        .unwrap_or_else(|| "already-running".to_string());
                    let message = if launched {
                        "Chrome launched".to_string()
                    } else {
                        format!("Chrome not launched: {reason}")
                    };
                    log_line(
                        if launched { "info" } else { "warn" },
                        &format!("chrome launch: {message}"),
                    );
                    controls::set_tray_tooltip(format!("Zyquor — {message}"));
                });
            }
            MENU_STOP_EVERYTHING => {
                let runtime = (*app.state::<AppRuntime>()).clone();
                // Same actions as `POST /system/stop-all`; the tray has no
                // request to answer, so it runs them directly (pause the
                // worker and close every posting Chrome).
                tauri::async_runtime::spawn(async move {
                    runtime.worker_handle.set_paused(true);
                    DesktopControl::close_chrome(&runtime, &controls::base_cdp_url()).await;
                    log_line("warn", "stop everything from tray");
                    controls::set_tray_tooltip("Zyquor — stopped");
                });
            }
            MENU_QUIT => {
                let runtime = (*app.state::<AppRuntime>()).clone();
                tauri::async_runtime::spawn(async move {
                    DesktopControl::shutdown_sequence(&runtime).await;
                    std::process::exit(0);
                });
            }
            _ => {}
        })
        .setup(move |app| run_setup(app, std_listener, api_port, hidden));

    let app = match builder.build(tauri::generate_context!()) {
        Ok(app) => app,
        Err(error) => {
            eprintln!("tauri build error: {error}");
            std::process::exit(1);
        }
    };

    app.run(|app_handle, event| {
        // Mirrors `before-quit` in `main.ts`: log "app quitting", run the
        // time-boxed shutdown sequence, flush the log and exit(0). Runs on
        // a dedicated thread so the Tauri event loop never blocks on it.
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            api.prevent_exit();
            if SHUTTING_DOWN.swap(true, Ordering::SeqCst) {
                return;
            }
            log_line("info", "app quitting");
            STOP_POLLING.store(true, Ordering::SeqCst);
            let runtime = (*app_handle.state::<AppRuntime>()).clone();
            std::thread::spawn(move || {
                let runner = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                match runner {
                    Ok(runner) => runner.block_on(DesktopControl::shutdown_sequence(&runtime)),
                    Err(error) => {
                        log_line("error", &format!("shutdown runtime error: {error}"));
                    }
                }
                std::process::exit(0);
            });
        }
    });
}
