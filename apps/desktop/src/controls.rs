//! Desktop control surface, ported from the `desktopControl` +
//! `desktopLaunchPostingChrome` parts of `apps/desktop/src/main.ts`.
//!
//! Deviations from the TypeScript original (and from the frozen-spec sketch):
//! - The stubs are **associated functions on [`DesktopControl`] taking
//!   `&AppRuntime`** instead of `State`-taking free functions: every call
//!   in the app (Tauri commands, tray handlers, the run-loop exit handler
//!   and headless smoke) can then reach them. The Tauri `#[tauri::command]`
//!   wrappers in `main.rs` pass `&*state` and therefore stay
//!   `State`-compatible.
//! - `quit` / `restart` are **async** (like the TS `async quit()`), because
//!   the shutdown sequence they await is async, and `close_chrome` is async
//!   too (`close_posting_chrome` is). The TS semantics are preserved:
//!   `desktopControl.quit()` awaits `quitEverything()` before quitting, and
//!   here the command awaits [`shutdown_sequence`] before the process exit.
//! - Profile paths resolve through `zyquor_core::paths::profiles_path` with
//!   the **stripped profile dir** (like `main.ts` does with
//!   `profilesPath(account.profileDir.replace(/^profiles\//, ""))`) — not the
//!   account handle. `profiles_path` resolves `ZYQUOR_DATA_ROOT` from the
//!   process environment; keeping the desktop's Tauri data root in the
//!   environment requires mutating process env state, which this crate
//!   forbids (see `settings.rs`' docs — the accepted M6 limitation is that
//!   `ZYQUOR_DATA_ROOT` stays a variable for everything except the paths
//!   helpers, which fall back to the current directory when it is unset).
//! - [`AppRuntime`] carries an extra `api` field beyond the frozen-spec
//!   struct: the shutdown sequence needs the API serve task (process
//!   shutdown is driven from here), so the handle is managed next to the
//!   runtime state instead of in a second managed value.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::Serialize;

use crate::chrome;
use crate::log::log_line;
use crate::settings::{SettingsPlane, settings_env_value};

/// Managed runtime state shared by the Tauri commands.
#[derive(Clone)]
pub struct AppRuntime {
    pub worker_handle: Arc<zyquor_worker::WorkerHandle>,
    pub started_at: String,
    pub api_port: u16,
    pub db_path: PathBuf,
    pub data_root: PathBuf,
    pub api: Arc<ApiServerHandle>,
    /// The settings plane injected into the API (`desktopSettings` in TS).
    pub settings: Arc<SettingsPlane>,
}

/// Handle to the axum API server task running on the backend thread.
pub struct ApiServerHandle {
    shutdown: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl ApiServerHandle {
    pub fn new(
        shutdown: tokio::sync::oneshot::Sender<()>,
        task: tokio::task::JoinHandle<()>,
    ) -> Self {
        Self {
            shutdown: Mutex::new(Some(shutdown)),
            task: Mutex::new(Some(task)),
        }
    }

    /// Graceful shutdown: signal the server to stop and await its task.
    /// Idempotent; the caller time-boxes the wait (`withTimeout` parity).
    pub async fn close(&self) {
        let sender = self.shutdown.lock().ok().and_then(|mut guard| guard.take());
        if let Some(sender) = sender {
            let _ = sender.send(());
        }
        let task = self.task.lock().ok().and_then(|mut guard| guard.take());
        if let Some(task) = task {
            let _ = task.await;
        }
    }
}

/// Outcome of a posting Chrome close ({@code closed} + reason).
pub use chrome::CloseResult;
/// Outcome of a posting Chrome launch ({@code launched} + reason).
pub use chrome::LaunchResult;

/// Per-account posting Chrome state (mirrors the `chromes` entries of
/// `desktopControl.status`, serialized camelCase like the TS IPC payload).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeStatus {
    pub account_id: String,
    pub handle: String,
    pub cdp_url: String,
    pub port: u16,
    pub connected: bool,
}

/// Desktop runtime status (`desktopControl.status`, camelCase on the wire).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStatus {
    pub app_version: String,
    pub cdp_url: String,
    pub chrome_connected: bool,
    pub chrome_pid: Option<u32>,
    pub chromes: Vec<ChromeStatus>,
    pub data_root: String,
    pub log_path: String,
    pub platform: String,
    pub started_at: String,
    pub worker_paused: bool,
}

static TOOLTIP_STATE: OnceLock<Mutex<String>> = OnceLock::new();
static TRAY_ICON: OnceLock<Mutex<Option<tauri::tray::TrayIcon>>> = OnceLock::new();

fn tooltip_state() -> &'static Mutex<String> {
    TOOLTIP_STATE.get_or_init(|| Mutex::new("Zyquor".to_string()))
}

fn tray_icon_slot() -> &'static Mutex<Option<tauri::tray::TrayIcon>> {
    TRAY_ICON.get_or_init(|| Mutex::new(None))
}

/// Register the app's tray icon so [`set_tray_tooltip`] reaches it.
pub fn register_tray_icon(tray: tauri::tray::TrayIcon) {
    if let Ok(mut slot) = tray_icon_slot().lock() {
        *slot = Some(tray);
    }
    let current = tray_tooltip();
    if let Ok(slot) = tray_icon_slot().lock() {
        if let Some(tray) = slot.as_ref() {
            let _ = tray.set_tooltip(Some(current));
        }
    }
}

/// Current tray tooltip text (default `"Zyquor"`, like `tray.setToolTip("Zyquor")`).
pub fn tray_tooltip() -> String {
    tooltip_state()
        .lock()
        .map(|guard| guard.clone())
        .unwrap_or_else(|_| "Zyquor".to_string())
}

/// Update the tray tooltip text (and the tray icon, if registered).
pub fn set_tray_tooltip(text: impl Into<String>) {
    let text = text.into();
    if let Ok(mut guard) = tooltip_state().lock() {
        *guard = text.clone();
    }
    if let Ok(slot) = tray_icon_slot().lock() {
        if let Some(tray) = slot.as_ref() {
            let _ = tray.set_tooltip(Some(text));
        }
    }
}

/// The CDP port of the base URL (mirrors `getCdpPort` in `main.ts`).
pub fn cdp_port() -> u16 {
    if let Some(url) = settings_env_value("ZYQUOR_BROWSER_CDP_URL") {
        if let Some(port) = url.rsplit(':').next() {
            if let Ok(port) = port.parse::<u16>() {
                return port;
            }
        }
    }
    settings_env_value("ZYQUOR_BROWSER_CDP_PORT")
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(9222)
}

/// The base CDP URL (`ZYQUOR_BROWSER_CDP_URL` or derived from the port).
pub fn base_cdp_url() -> String {
    settings_env_value("ZYQUOR_BROWSER_CDP_URL")
        .or_else(|| {
            settings_env_value("ZYQUOR_BROWSER_CDP_PORT")
                .map(|port| format!("http://127.0.0.1:{port}"))
        })
        .unwrap_or_else(|| format!("http://127.0.0.1:{}", cdp_port()))
}

/// List accounts through a short-lived SQLite connection in
/// `spawn_blocking`, like the fleet's async repository proxy does in-process.
async fn list_accounts_blocking(db_path: &Path) -> Vec<zyquor_accounts::Account> {
    let db_path = db_path.to_path_buf();
    let result = tokio::task::spawn_blocking(move || {
        zyquor_storage::SqliteRepository::open(&db_path)
            .and_then(|repository| repository.list_accounts())
    })
    .await;
    match result {
        Ok(Ok(accounts)) => accounts,
        Ok(Err(error)) => {
            log_line("error", &format!("list accounts error: {error}"));
            Vec::new()
        }
        Err(error) => {
            log_line("error", &format!("list accounts task failed: {error}"));
            Vec::new()
        }
    }
}

/// Shutdown step helpers mirroring `withTimeout` — a hung child process
/// or socket must never trap the app in a half-closed state.
async fn with_timeout<F, T>(label: &str, ms: u64, work: F) -> Option<T>
where
    F: std::future::Future<Output = T>,
{
    let result = tokio::time::timeout(Duration::from_millis(ms), work).await;
    match result {
        Ok(value) => Some(value),
        Err(_) => {
            log_line(
                "error",
                &format!("{label} timed out after {ms}ms, continuing"),
            );
            None
        }
    }
}

pub struct DesktopControl;

/// Namespace for the desktop control functions (keeps the call shape of
/// the TS `desktopControl` object without instance state — all state is
/// in the managed [`AppRuntime`]).
impl DesktopControl {
    /// `desktopControl.launchPostingChrome` + `desktopLaunchPostingChrome`:
    /// pick the account by id (fall back to the first), resolve its profile
    /// and launch Chrome on the account's CDP port.
    pub async fn launch_posting_chrome(
        state: &AppRuntime,
        account_id: &str,
        base_cdp_url: &str,
    ) -> LaunchResult {
        let accounts = list_accounts_blocking(&state.db_path).await;
        let account = accounts
            .iter()
            .find(|account| account.id == account_id)
            .or_else(|| accounts.first());
        let Some(account) = account else {
            return LaunchResult {
                launched: false,
                reason: Some("account-not-found".to_string()),
            };
        };
        let stripped = account
            .profile_dir
            .strip_prefix("profiles/")
            .unwrap_or(&account.profile_dir);
        let profile_dir = zyquor_core::paths::profiles_path([stripped]);
        let port = chrome::cdp_port_for_profile(&account.profile_dir, base_cdp_url);
        chrome::launch_posting_chrome(&profile_dir, port).await
    }

    /// `desktopControl.status`.
    pub async fn chrome_status(state: &AppRuntime, base_cdp_url: &str) -> DesktopStatus {
        let default_cdp_url = format!("http://127.0.0.1:{}", cdp_port());
        let accounts = list_accounts_blocking(&state.db_path).await;
        let mut chromes = Vec::new();
        for account in accounts.iter().filter(|account| account.enabled) {
            let port = chrome::cdp_port_for_profile(&account.profile_dir, base_cdp_url);
            let url = format!("http://127.0.0.1:{port}");
            chromes.push(ChromeStatus {
                account_id: account.id.clone(),
                handle: account.handle.clone(),
                cdp_url: url.clone(),
                port,
                connected: chrome::is_cdp_up(&url).await,
            });
        }
        DesktopStatus {
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            cdp_url: default_cdp_url.clone(),
            chrome_connected: chrome::is_cdp_up(&default_cdp_url).await,
            chrome_pid: chrome::launched_posting_chrome_pid(),
            chromes,
            data_root: state.data_root.to_string_lossy().into_owned(),
            log_path: state
                .data_root
                .join("logs")
                .join("main.log")
                .to_string_lossy()
                .into_owned(),
            platform: std::env::consts::OS.to_string(),
            started_at: state.started_at.clone(),
            worker_paused: state.worker_handle.is_paused(),
        }
    }

    /// `desktopControl.closeChrome`: close every enabled account's Chrome,
    /// reporting success when at least one was actually running.
    pub async fn close_chrome(state: &AppRuntime, base_cdp_url: &str) -> CloseResult {
        let accounts = list_accounts_blocking(&state.db_path).await;
        let mut closed_any = false;
        for account in accounts.iter().filter(|account| account.enabled) {
            let port = chrome::cdp_port_for_profile(&account.profile_dir, base_cdp_url);
            if chrome::close_posting_chrome(port).await.closed {
                closed_any = true;
            }
        }
        let result = CloseResult {
            closed: closed_any,
            reason: if closed_any {
                None
            } else {
                Some("not-running".to_string())
            },
        };
        log_line(
            if result.closed { "info" } else { "warn" },
            &format!(
                "chrome close: {}",
                if result.closed {
                    "closed".to_string()
                } else {
                    result
                        .reason
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string())
                }
            ),
        );
        result
    }

    /// `desktopControl.logTail`.
    pub fn log_tail(lines: usize) -> Vec<String> {
        crate::log::log_tail(lines)
    }

    /// `desktopControl.quit`: log, run the shutdown sequence, then exit.
    /// Never returns — matches the TS semantics where `quitEverything()`
    /// is awaited and `app.quit()` follows it (the process never resumes).
    pub async fn quit(state: &AppRuntime) -> ! {
        log_line("info", "quit requested from UI");
        Self::shutdown_sequence(state).await;
        std::process::exit(0);
    }

    /// `desktopControl.restart`: log, shut down, spawn a fresh process,
    /// then exit.
    pub async fn restart(state: &AppRuntime) -> ! {
        log_line("info", "restart requested from UI");
        Self::shutdown_sequence(state).await;
        match std::env::current_exe() {
            Ok(exe) => {
                if let Err(error) = std::process::Command::new(&exe).spawn() {
                    log_line(
                        "error",
                        &format!("restart: failed to spawn {}: {error}", exe.display()),
                    );
                }
            }
            Err(error) => {
                log_line(
                    "error",
                    &format!("restart: cannot resolve current exe: {error}"),
                );
            }
        }
        std::process::exit(0);
    }

    /// `desktopControl.setWorkerPaused`.
    pub fn set_worker_paused(state: &AppRuntime, paused: bool) -> bool {
        state.worker_handle.set_paused(paused);
        log_line(
            "info",
            if paused {
                "worker paused from UI"
            } else {
                "worker resumed from UI"
            },
        );
        state.worker_handle.is_paused()
    }

    /// `quitEverything`: pause the worker, stop it, close the API, close
    /// the posting Chromes and flush the log — every step time-boxed so
    /// shutdown always finishes, even when a socket hangs.
    pub async fn shutdown_sequence(state: &AppRuntime) {
        state.worker_handle.set_paused(true);

        let stop_result = with_timeout("worker stop", 5_000, state.worker_handle.stop()).await;
        if let Some(Ok(_)) = stop_result {
        } else if let Some(Err(error)) = stop_result {
            log_line("error", &format!("worker stop error: {error}"));
        }

        with_timeout("api close", 5_000, state.api.close()).await;

        let accounts = list_accounts_blocking(&state.db_path).await;
        if accounts.is_empty() {
            // The repository could not be read (failures surface as an
            // empty list), so fall back to closing the default CDP port,
            // like the `catch` branch in `main.ts`.
            with_timeout(
                "close posting browser",
                4_000,
                chrome::close_posting_chrome(cdp_port()),
            )
            .await;
        } else {
            // Close every enabled account's Chrome in parallel, like
            // `Promise.allSettled` over the enabled accounts in `main.ts`.
            let base = base_cdp_url();
            let ports: Vec<u16> = accounts
                .iter()
                .filter(|account| account.enabled)
                .map(|account| chrome::cdp_port_for_profile(&account.profile_dir, &base))
                .collect();
            futures::future::join_all(ports.into_iter().map(chrome::close_posting_chrome)).await;
        }

        log_line("info", "shutdown complete");
        crate::log::flush_log_sync();
    }
}

/// The [`zyquor_api::DesktopControlPlane`] implementation the Tauri shell
/// injects into the API state. It lets the web UI's System panel drive the
/// desktop shell over HTTP (`/system/logs`, `/system/worker/pause`,
/// `/system/chrome/close`, `/system/stop-all`, `/system/quit`,
/// `/system/restart`) instead of the Electron IPC bridge.
pub struct ApiDesktopControl {
    runtime: AppRuntime,
}

impl ApiDesktopControl {
    pub fn new(runtime: AppRuntime) -> Self {
        Self { runtime }
    }
}

impl zyquor_api::DesktopControlPlane for ApiDesktopControl {
    fn status(&self) -> futures::future::BoxFuture<'_, serde_json::Value> {
        Box::pin(async move {
            let status = DesktopControl::chrome_status(&self.runtime, &base_cdp_url()).await;
            serde_json::to_value(status).unwrap_or(serde_json::Value::Null)
        })
    }

    fn log_tail(&self, lines: usize) -> Vec<String> {
        DesktopControl::log_tail(lines)
    }

    fn worker_paused(&self) -> bool {
        self.runtime.worker_handle.is_paused()
    }

    fn set_worker_paused(&self, paused: bool) -> bool {
        DesktopControl::set_worker_paused(&self.runtime, paused)
    }

    fn close_chrome(&self) -> futures::future::BoxFuture<'_, serde_json::Value> {
        Box::pin(async move {
            let result = DesktopControl::close_chrome(&self.runtime, &base_cdp_url()).await;
            serde_json::to_value(result).unwrap_or(serde_json::Value::Null)
        })
    }

    fn request_quit(&self) {
        let runtime = self.runtime.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            let runner = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            match runner {
                Ok(runner) => runner.block_on(DesktopControl::quit(&runtime)),
                Err(error) => {
                    log_line("error", &format!("quit runtime error: {error}"));
                    std::process::exit(1);
                }
            }
        });
    }

    fn request_restart(&self) {
        let runtime = self.runtime.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            let runner = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            match runner {
                Ok(runner) => runner.block_on(DesktopControl::restart(&runtime)),
                Err(error) => {
                    log_line("error", &format!("restart runtime error: {error}"));
                    std::process::exit(1);
                }
            }
        });
    }
}
