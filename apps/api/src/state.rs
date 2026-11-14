//! App state: everything the handlers share. Ported from
//! `apps/api/src/deps.ts` (minus the desktop-only control surface, which the
//! desktop app owns and injects from outside).

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, RwLock};

use chrono::DateTime;
use futures::future::BoxFuture;
use serde_json::{Map, Value};
use zyquor_adapters::SourceAdapter;
use zyquor_generation::providers::{
    DraftFuture, DraftGenerationProvider, create_generation_provider_from_env,
};
use zyquor_generation::types::GenerateDraftCandidatesInput;
use zyquor_generation::{ReqwestFetch, resolve_generation_provider_config};
use zyquor_storage::SqliteRepository;

use crate::lib_deps::GenerationEnvironment;

/// The desktop-only control surface (`deps.desktopControl` in the TypeScript
/// app). The Tauri shell implements this and injects it into [`AppState`]
/// after the worker and API are running; the standalone `zyquor api` leaves
/// the slot empty and the desktop routes answer `404`.
///
/// The payloads are already camelCase JSON so the API crate never has to
/// depend on the desktop crate (the dependency runs the other way around).
pub trait DesktopControlPlane: Send + Sync {
    /// `desktopControl.status` — the `desktop` block of `GET /system/status`.
    fn status(&self) -> BoxFuture<'_, serde_json::Value>;
    /// Tail of the desktop log file (`main.log`).
    fn log_tail(&self, lines: usize) -> Vec<String>;
    fn worker_paused(&self) -> bool;
    fn set_worker_paused(&self, paused: bool) -> bool;
    /// `desktopControl.closeChrome` — `{closed, reason?}`.
    fn close_chrome(&self) -> BoxFuture<'_, serde_json::Value>;
    /// Schedule a quit and return immediately so the HTTP response can flush.
    fn request_quit(&self);
    /// Schedule a restart and return immediately so the HTTP response can flush.
    fn request_restart(&self);
}

/// The desktop-settings persistence surface (`deps.desktopSettings` in the
/// TypeScript app). The Tauri shell implements this over `settings.json` and
/// injects it after the API starts, next to the desktop control plane; the
/// standalone `zyquor api` leaves the slot empty and the settings routes fall
/// back to a process-level store (documented deviation: TS registers
/// `/settings` only when `desktopSettings` exists and answers `404` otherwise;
/// the Rust standalone keeps the routes and their shapes available with the
/// in-process store, so existing clients keep working).
pub trait DesktopSettingsPlane: Send + Sync {
    /// `desktopSettings.get()` — the current settings as camelCase JSON.
    fn get(&self) -> Map<String, Value>;
    /// `desktopSettings.update(patch)` — merge + persist, return the result.
    fn update(&self, patch: Map<String, Value>) -> Map<String, Value>;
}

/// The live generation slot: the merged env snapshot the provider was built
/// from plus the provider itself. Both are swapped together by
/// `PATCH /generation` and `PATCH /settings`, so every clone of [`AppState`]
/// sees the new provider immediately.
struct GenerationSlot {
    env: GenerationEnvironment,
    provider: Arc<dyn DraftGenerationProvider>,
    /// `DraftGenerationProvider::name`/`model` return `&str`, so the live
    /// labels are interned `'static` strings (bounded by the provider/model
    /// allowlists; a swap reuses an existing interned label).
    labels: (&'static str, &'static str),
}

/// The swappable generation provider handed to the routes as an
/// `Arc<dyn DraftGenerationProvider>`: lock to clone the current provider out,
/// then await on the clone — no lock is held across an await.
pub struct LiveGenerationProvider {
    slot: RwLock<GenerationSlot>,
}

impl LiveGenerationProvider {
    fn new(env: GenerationEnvironment, provider: Arc<dyn DraftGenerationProvider>) -> Arc<Self> {
        let labels = labels_for(provider.as_ref());
        Arc::new(Self {
            slot: RwLock::new(GenerationSlot {
                env,
                provider,
                labels,
            }),
        })
    }

    fn read_slot(&self) -> std::sync::RwLockReadGuard<'_, GenerationSlot> {
        self.slot
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn labels(&self) -> (&'static str, &'static str) {
        let slot = self.read_slot();
        slot.labels
    }

    /// Clone the current provider out from under the lock.
    pub fn current(&self) -> Arc<dyn DraftGenerationProvider> {
        self.read_slot().provider.clone()
    }

    /// The current merged generation env (owned clone; never process env).
    pub fn environment(&self) -> GenerationEnvironment {
        self.read_slot().env.clone()
    }

    /// Swap env + provider together. `PATCH` handlers call this after the new
    /// provider was created successfully.
    pub fn swap(&self, env: GenerationEnvironment, provider: Arc<dyn DraftGenerationProvider>) {
        let labels = labels_for(provider.as_ref());
        let mut slot = self
            .slot
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *slot = GenerationSlot {
            env,
            provider,
            labels,
        };
    }
}

impl DraftGenerationProvider for LiveGenerationProvider {
    fn name(&self) -> &str {
        self.labels().0
    }

    fn model(&self) -> &str {
        self.labels().1
    }

    fn generate_draft_candidates<'a>(
        &'a self,
        input: &'a GenerateDraftCandidatesInput,
    ) -> DraftFuture<'a> {
        let provider = self.current();
        Box::pin(async move { provider.generate_draft_candidates(input).await })
    }
}

/// Intern the provider name/model labels so a live swap never grows the leak
/// set beyond the distinct values seen in this process.
fn labels_for(provider: &dyn DraftGenerationProvider) -> (&'static str, &'static str) {
    static LABELS: OnceLock<std::sync::Mutex<std::collections::HashSet<&'static str>>> =
        OnceLock::new();
    fn intern(value: &str) -> &'static str {
        if let Some(existing) = LABELS
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
            .lock()
            .ok()
            .and_then(|labels| labels.get(value).copied())
        {
            return existing;
        }
        let leaked: &'static str = Box::leak(value.to_string().into_boxed_str());
        if let Ok(mut labels) = LABELS
            .get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
            .lock()
        {
            labels.insert(leaked);
        }
        leaked
    }
    (intern(provider.name()), intern(provider.model()))
}

/// The options `build_app` accepts — the same levers the Fastify build took
/// (`BuildAppOptions`).
#[derive(Clone, Default)]
pub struct BuildAppOptions {
    pub generation_config_path: Option<Option<String>>,
    /// Pre-built provider (TS `options.generationProvider`), used by tests to
    /// keep generation offline. `None` builds one from the merged env.
    pub generation_provider: Option<Arc<dyn DraftGenerationProvider>>,
    pub enable_browser_prepare: bool,
    pub enable_browser_post: bool,
    pub browser_action_delay_ms: Option<u64>,
    pub browser_channel: Option<String>,
    pub browser_cdp_url: Option<String>,
    pub browser_typing_delay_ms: Option<u64>,
    pub close_after_prepare: Option<bool>,
    pub close_after_post: Option<bool>,
    /// Desktop-settings env snapshot (key → value), consulted as env fallback
    /// after the real process env — mirrors the TS `applySettingsToEnv`
    /// (which only sets env vars absent in `process.env`). `None` keeps the
    /// pure `std::env` behavior of the standalone server.
    pub settings_env: Option<std::collections::HashMap<String, String>>,
}

#[derive(Debug, Clone, Default)]
pub struct WorkerHeartbeat {
    pub last_error: Option<String>,
    pub last_heartbeat_at: Option<String>,
    pub last_ingest_at: Option<String>,
    pub last_post_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct IngestSkipped {
    pub blocked_url: usize,
    pub duplicate_packet: usize,
    pub duplicate_posted_url: usize,
    pub host_cap: usize,
    pub off_topic: usize,
    pub packet_cap: usize,
    pub schedule_window: usize,
    pub thin_context: usize,
    pub topic_overlap: usize,
}

#[derive(Debug, Clone, Default)]
pub struct IngestRunState {
    pub cancel_requested: bool,
    pub errors: Vec<IngestErrorEntry>,
    pub finished_at: Option<String>,
    pub last_started_at: Option<String>,
    pub processed: usize,
    pub running: bool,
    pub skipped_by_reason: Option<IngestSkipped>,
}

#[derive(Debug, Clone, Default)]
pub struct IngestErrorEntry {
    pub config_id: String,
    pub error: String,
}

impl IngestErrorEntry {
    pub fn new(config_id: impl Into<String>, error: impl Into<String>) -> Self {
        Self {
            config_id: config_id.into(),
            error: error.into(),
        }
    }
}

#[derive(Clone, Default)]
pub struct RuntimeState {
    pub browser_loaded: bool,
    pub ingest_run_state: IngestRunState,
    pub onboarding: OnboardingState,
    pub worker_heartbeat: Option<WorkerHeartbeat>,
}

#[derive(Debug, Clone, Default)]
pub struct OnboardingState {
    pub x_session_checked_ok: bool,
}

#[derive(Debug, Default)]
pub struct BrowserDeps {
    pub enable_prepare: bool,
    pub enable_post: bool,
    pub action_delay_ms: Option<u64>,
    pub channel: Option<String>,
    pub cdp_url: Option<String>,
    pub typing_delay_ms: Option<u64>,
    pub close_after_prepare: Option<bool>,
    pub close_after_post: Option<bool>,
}

/// The axum app state shared by every handler.
#[derive(Clone)]
pub struct AppState {
    pub repository: Arc<std::sync::Mutex<SqliteRepository>>,
    /// Path of the shared SQLite file. Long-running work (ingest runs, packet
    /// drafts) opens its own connection on this path instead of holding the
    /// proxy mutex across network-bound generation calls, so ordinary
    /// repository calls never stall behind a whole ingest/draft.
    pub db_path: std::path::PathBuf,
    pub source_adapters: HashMap<String, Arc<dyn SourceAdapter>>,
    pub automation_deps: zyquor_automation::AutomationDeps,
    /// The live provider. This is an `Arc<LiveGenerationProvider>` upcast to
    /// the trait object: routes keep calling `name`/`model`/
    /// `generate_draft_candidates` on it, and the handler that swaps updates
    /// the shared slot behind it.
    pub generation_provider: Arc<dyn DraftGenerationProvider>,
    pub browser: std::sync::Arc<std::sync::Mutex<BrowserDeps>>,
    pub runtime: Arc<std::sync::Mutex<RuntimeState>>,
    /// Injected by the desktop shell once its runtime exists (the API server
    /// and worker start before it). `None` in the standalone API.
    pub desktop_control: Arc<std::sync::Mutex<Option<Arc<dyn DesktopControlPlane>>>>,
    /// Injected by the desktop shell next to [`Self::desktop_control`];
    /// `None` in the standalone API (process-store fallback).
    pub desktop_settings: Arc<std::sync::Mutex<Option<Arc<dyn DesktopSettingsPlane>>>>,
    pub api_started_at: DateTime<chrono::Utc>,
    /// Swappable env + provider slot (see [`LiveGenerationProvider`]).
    generation: Arc<LiveGenerationProvider>,
    /// The saved generation config file (`generation.json`), if any.
    generation_config_path: Option<std::path::PathBuf>,
}

impl AppState {
    pub fn new(
        repository: SqliteRepository,
        db_path: std::path::PathBuf,
        options: &BuildAppOptions,
    ) -> Result<Self, String> {
        let repository_handle = Arc::new(std::sync::Mutex::new(repository));

        // Desktop settings snapshot is consulted after the real process env
        // (TS `applySettingsToEnv` only fills absent keys).
        let lookup = |key: &str| {
            std::env::var(key).ok().or_else(|| {
                options
                    .settings_env
                    .as_ref()
                    .and_then(|map| map.get(key).cloned())
            })
        };
        let automation_deps = zyquor_automation::AutomationDeps::from_env(&lookup);

        // `generationConfigPath` resolution as in `app.ts`: an explicit
        // option wins (`Some(None)` = disabled); `None` (undefined) falls back
        // to the default `data/generation.json` because the Rust build always
        // receives an explicit repository (the TS `repository ? null` branch
        // has no Rust equivalent and would silently drop saved-config
        // persistence).
        let generation_config_path = match &options.generation_config_path {
            Some(Some(path)) => Some(std::path::PathBuf::from(path)),
            Some(None) => None,
            None => crate::lib_deps::generation_config_path(),
        };

        // Boot env: `{...process.env, ...settingsEnv, ...savedGenerationEnv}`.
        let env = crate::lib_deps::boot_generation_environment(
            options.settings_env.as_ref(),
            generation_config_path.as_deref(),
        );
        let provider: Arc<dyn DraftGenerationProvider> = match options.generation_provider.clone() {
            Some(provider) => provider,
            None => Arc::new(
                create_generation_provider_from_env(&env.lookup(), ReqwestFetch::new())
                    .map_err(|error| error.to_string())?,
            ),
        };
        let generation = LiveGenerationProvider::new(env, provider);
        let generation_provider: Arc<dyn DraftGenerationProvider> = generation.clone();

        let source_adapters = default_source_adapters(&repository_handle);

        Ok(Self {
            repository: repository_handle,
            db_path,
            source_adapters,
            automation_deps,
            generation_provider,
            browser: std::sync::Arc::new(std::sync::Mutex::new(BrowserDeps {
                enable_prepare: options.enable_browser_prepare,
                enable_post: options.enable_browser_post,
                action_delay_ms: options.browser_action_delay_ms,
                channel: options.browser_channel.clone(),
                cdp_url: options.browser_cdp_url.clone(),
                typing_delay_ms: options.browser_typing_delay_ms,
                close_after_prepare: options.close_after_prepare,
                close_after_post: options.close_after_post,
            })),
            runtime: Arc::new(std::sync::Mutex::new(RuntimeState::default())),
            desktop_control: Arc::new(std::sync::Mutex::new(None)),
            desktop_settings: Arc::new(std::sync::Mutex::new(None)),
            api_started_at: chrono::Utc::now(),
            generation,
            generation_config_path,
        })
    }

    /// Attach the desktop control surface. Callable after the server has
    /// started: the slot is shared by every `AppState` clone (clones share the
    /// `Arc<Mutex<..>>`), so the router sees the control immediately.
    pub fn set_desktop_control(&self, control: Arc<dyn DesktopControlPlane>) {
        if let Ok(mut slot) = self.desktop_control.lock() {
            *slot = Some(control);
        }
    }

    /// The injected desktop control, if this process is the desktop app.
    pub fn desktop_control(&self) -> Option<Arc<dyn DesktopControlPlane>> {
        self.desktop_control
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
    }

    /// Attach the desktop settings persistence plane. Same late-injection
    /// pattern as [`Self::set_desktop_control`]: every `AppState` clone shares
    /// the slot, so the router sees it immediately. Also seeds the process
    /// fallback store so no-arg legacy readers (feedback notebook directory)
    /// resolve the injected values.
    pub fn set_desktop_settings(&self, settings: Arc<dyn DesktopSettingsPlane>) {
        crate::routes::settings::seed_fallback_store(settings.get());
        if let Ok(mut slot) = self.desktop_settings.lock() {
            *slot = Some(settings);
        }
    }

    /// The injected desktop settings plane, if this process is the desktop app.
    pub fn desktop_settings(&self) -> Option<Arc<dyn DesktopSettingsPlane>> {
        self.desktop_settings
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
    }

    /// The live merged generation env (`deps.generationEnv`) — never the
    /// process environment again once the API is up.
    pub fn generation_environment(&self) -> GenerationEnvironment {
        self.generation.environment()
    }

    /// The live generation config resolved from the live env snapshot.
    pub fn generation_config(
        &self,
    ) -> Result<zyquor_generation::GenerationProviderConfig, zyquor_generation::GenerationError>
    {
        let env = self.generation.environment();
        resolve_generation_provider_config(&env.lookup())
    }

    /// Swap the live env + provider (successful `PATCH /generation` /
    /// `PATCH /settings`). Both are replaced together so the config view and
    /// the provider can never disagree.
    pub fn apply_generation_provider(
        &self,
        env: GenerationEnvironment,
        provider: Arc<dyn DraftGenerationProvider>,
    ) {
        self.generation.swap(env, provider);
    }

    /// The saved generation config file (`generation.json`), if any.
    pub fn generation_config_path(&self) -> Option<&std::path::Path> {
        self.generation_config_path.as_deref()
    }

    pub fn repository(&self) -> Repository {
        Repository {
            handle: self.repository.clone(),
        }
    }

    pub fn generation_model(&self) -> String {
        self.generation_provider.model().to_string()
    }

    pub fn generation_provider_name(&self) -> String {
        self.generation_provider.name().to_string()
    }
}

fn default_source_adapters(
    _repository: &Arc<std::sync::Mutex<SqliteRepository>>,
) -> HashMap<String, Arc<dyn SourceAdapter>> {
    let fetch = Arc::new(zyquor_adapters::ReqwestFetch::new());
    let crawl_service = Arc::new(zyquor_adapters::Crawl4AiService::new(
        fetch.clone(),
        zyquor_adapters::Crawl4AiOptions::default(),
        &|key: &str| std::env::var(key).ok(),
    )) as Arc<dyn zyquor_adapters::CrawlService>;

    let adapters: Vec<Box<dyn SourceAdapter>> = vec![
        Box::new(zyquor_adapters::create_aggregated_news_adapter(
            zyquor_adapters::AggregatorOptions {
                crawl_service: Some(crawl_service.clone()),
                fetch: None,
                health_cooldown_ms: None,
                ..zyquor_adapters::AggregatorOptions::default()
            },
        )),
        Box::new(zyquor_adapters::ModelReleasesAdapter::new(
            fetch.clone(),
            zyquor_adapters::ModelReleasesAdapterOptions::default(),
        )),
        Box::new(zyquor_adapters::DeepSeekUpdatesAdapter::new(
            fetch.clone(),
            zyquor_adapters::DeepSeekUpdatesAdapterOptions::default(),
        )),
        Box::new(zyquor_adapters::CursorChangelogAdapter::new(
            fetch.clone(),
            zyquor_adapters::CursorChangelogAdapterOptions::default(),
        )),
        Box::new(zyquor_adapters::XaiNewsAdapter::new(
            fetch.clone(),
            zyquor_adapters::XaiNewsAdapterOptions::default(),
        )),
        Box::new(zyquor_adapters::AnthropicReleaseNotesAdapter::new(
            fetch.clone(),
            zyquor_adapters::AnthropicReleaseNotesAdapterOptions::default(),
        )),
        Box::new(zyquor_adapters::A16zAdapter::new(
            fetch.clone(),
            zyquor_adapters::A16zAdapterOptions::default(),
        )),
        Box::new(zyquor_adapters::RssAdapter::new(
            fetch.clone(),
            zyquor_adapters::RssAdapterOptions::default(),
        )),
    ];
    adapters
        .into_iter()
        .map(|adapter| {
            let source_type = adapter.source_type().to_string();
            (source_type, Arc::from(adapter))
        })
        .collect()
}

/// Async wrapper over the synchronous SQLite repository. Every call runs in
/// `spawn_blocking` holding the shared mutex, never blocking the executor.
#[derive(Clone)]
pub struct Repository {
    handle: Arc<std::sync::Mutex<SqliteRepository>>,
}

impl Repository {
    pub fn new(handle: Arc<std::sync::Mutex<SqliteRepository>>) -> Self {
        Self { handle }
    }

    pub async fn call<F, T>(&self, f: F) -> Result<T, zyquor_storage::StorageError>
    where
        F: FnOnce(&SqliteRepository) -> Result<T, zyquor_storage::StorageError> + Send + 'static,
        T: Send + 'static,
    {
        let handle = self.handle.clone();
        tokio::task::spawn_blocking(move || {
            let guard = handle.lock().map_err(|_| {
                zyquor_storage::StorageError::Invalid("repository mutex poisoned".to_string())
            })?;
            f(&guard)
        })
        .await
        .map_err(|error| {
            zyquor_storage::StorageError::Invalid(format!("repository task panicked: {error}"))
        })?
    }

    pub async fn list_accounts(
        &self,
    ) -> Result<Vec<zyquor_accounts::Account>, zyquor_storage::StorageError> {
        self.call(|repo| repo.list_accounts()).await
    }
    pub async fn get_account(
        &self,
        id: &str,
    ) -> Result<Option<zyquor_accounts::Account>, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.get_account(&id)).await
    }
    pub async fn create_account(
        &self,
        handle: &str,
        display_name: &str,
        profile_dir: &str,
        style_profile_id: &str,
    ) -> Result<zyquor_accounts::Account, zyquor_storage::StorageError> {
        let (handle, display_name, profile_dir, style_profile_id) = (
            handle.to_string(),
            display_name.to_string(),
            profile_dir.to_string(),
            style_profile_id.to_string(),
        );
        self.call(move |repo| {
            repo.create_account(&handle, &display_name, &profile_dir, &style_profile_id)
        })
        .await
    }
    pub async fn update_account(
        &self,
        id: &str,
        update: zyquor_storage::AccountUpdate,
    ) -> Result<zyquor_accounts::Account, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.update_account(&id, &update))
            .await
    }
    pub async fn delete_account(
        &self,
        id: &str,
    ) -> Result<zyquor_accounts::Account, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.delete_account(&id)).await
    }
    pub async fn create_draft(
        &self,
        input: zyquor_storage::NewDraft,
    ) -> Result<zyquor_storage::DraftWithCandidates, zyquor_storage::StorageError> {
        self.call(move |repo| repo.create_draft(&input)).await
    }
    pub async fn get_draft(
        &self,
        id: &str,
    ) -> Result<Option<zyquor_storage::DraftWithCandidates>, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.get_draft(&id)).await
    }
    pub async fn list_drafts(
        &self,
        account_id: Option<&str>,
    ) -> Result<Vec<zyquor_storage::Draft>, zyquor_storage::StorageError> {
        let account_id = account_id.map(str::to_string);
        self.call(move |repo| repo.list_drafts(account_id.as_deref()))
            .await
    }
    pub async fn count_pending_drafts(&self) -> Result<i64, zyquor_storage::StorageError> {
        self.call(|repo| repo.count_pending_drafts()).await
    }
    pub async fn list_pending_drafts(
        &self,
    ) -> Result<Vec<zyquor_storage::Draft>, zyquor_storage::StorageError> {
        self.call(|repo| repo.list_pending_drafts()).await
    }
    pub async fn list_quality_gate_failed_drafts(
        &self,
    ) -> Result<Vec<zyquor_storage::Draft>, zyquor_storage::StorageError> {
        self.call(|repo| repo.list_quality_gate_failed_drafts())
            .await
    }
    pub async fn get_draft_by_source_packet_id(
        &self,
        source_packet_id: &str,
    ) -> Result<Option<zyquor_storage::DraftWithCandidates>, zyquor_storage::StorageError> {
        let source_packet_id = source_packet_id.to_string();
        self.call(move |repo| repo.get_draft_by_source_packet_id(&source_packet_id))
            .await
    }
    pub async fn delete_draft(
        &self,
        draft_id: &str,
    ) -> Result<zyquor_storage::DraftWithCandidates, zyquor_storage::StorageError> {
        let draft_id = draft_id.to_string();
        self.call(move |repo| repo.delete_draft(&draft_id)).await
    }
    pub async fn save_draft_candidates(
        &self,
        draft_id: &str,
        candidates: Vec<zyquor_storage::NewCandidate>,
    ) -> Result<zyquor_storage::DraftWithCandidates, zyquor_storage::StorageError> {
        let draft_id = draft_id.to_string();
        self.call(move |repo| repo.save_draft_candidates(&draft_id, &candidates))
            .await
    }
    pub async fn update_draft_metadata(
        &self,
        draft_id: &str,
        metadata: serde_json::Map<String, serde_json::Value>,
    ) -> Result<zyquor_storage::Draft, zyquor_storage::StorageError> {
        let draft_id = draft_id.to_string();
        self.call(move |repo| repo.update_draft_metadata(&draft_id, &metadata))
            .await
    }
    pub async fn update_candidate_score(
        &self,
        candidate_id: &str,
        score: serde_json::Map<String, serde_json::Value>,
    ) -> Result<zyquor_storage::DraftCandidate, zyquor_storage::StorageError> {
        let candidate_id = candidate_id.to_string();
        self.call(move |repo| repo.update_candidate_score(&candidate_id, &score))
            .await
    }
    pub async fn select_candidate(
        &self,
        draft_id: &str,
        candidate_id: &str,
        edited_text: Option<&str>,
    ) -> Result<zyquor_storage::DraftWithCandidates, zyquor_storage::StorageError> {
        let draft_id = draft_id.to_string();
        let candidate_id = candidate_id.to_string();
        let edited_text = edited_text.map(str::to_string);
        self.call(move |repo| {
            repo.select_candidate(&draft_id, &candidate_id, edited_text.as_deref())
        })
        .await
    }
    pub async fn approve_draft(
        &self,
        input: zyquor_storage::ApproveDraft,
    ) -> Result<(zyquor_storage::Draft, zyquor_storage::PostJob), zyquor_storage::StorageError>
    {
        self.call(move |repo| repo.approve_draft(&input)).await
    }
    pub async fn get_job(
        &self,
        id: &str,
    ) -> Result<Option<zyquor_storage::PostJob>, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.get_job(&id)).await
    }
    pub async fn list_jobs(
        &self,
        account_id: Option<&str>,
        statuses: Option<Vec<zyquor_core::types::PostJobStatus>>,
        limit: Option<i64>,
    ) -> Result<Vec<zyquor_storage::PostJob>, zyquor_storage::StorageError> {
        let account_id = account_id.map(str::to_string);
        self.call(move |repo| repo.list_jobs(account_id.as_deref(), statuses.as_deref(), limit))
            .await
    }
    pub async fn list_jobs_by_draft_id(
        &self,
        draft_id: &str,
    ) -> Result<Vec<zyquor_storage::PostJob>, zyquor_storage::StorageError> {
        let draft_id = draft_id.to_string();
        self.call(move |repo| repo.list_jobs_by_draft_id(&draft_id))
            .await
    }
    pub async fn get_latest_posted_job(
        &self,
    ) -> Result<Option<zyquor_storage::PostJob>, zyquor_storage::StorageError> {
        self.call(|repo| repo.get_latest_posted_job()).await
    }
    pub async fn get_post_job_status_counts(
        &self,
    ) -> Result<std::collections::BTreeMap<String, i64>, zyquor_storage::StorageError> {
        self.call(|repo| repo.get_post_job_status_counts()).await
    }
    pub async fn update_job_status(
        &self,
        id: &str,
        status: zyquor_core::types::PostJobStatus,
    ) -> Result<zyquor_storage::PostJob, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.update_job_status(&id, status))
            .await
    }
    pub async fn assign_job_schedule(
        &self,
        id: &str,
        scheduled_for: Option<String>,
    ) -> Result<zyquor_storage::PostJob, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.assign_job_schedule(&id, scheduled_for.as_deref()))
            .await
    }
    pub async fn claim_job_for_browser_run(
        &self,
        id: &str,
    ) -> Result<Option<zyquor_storage::PostJob>, zyquor_storage::StorageError> {
        let id = id.to_string();
        let statuses: Vec<zyquor_core::types::PostJobStatus> = vec![
            zyquor_core::types::PostJobStatus::Approved,
            zyquor_core::types::PostJobStatus::Failed,
        ];
        self.call(move |repo| repo.claim_job_for_browser_run(&id, &statuses))
            .await
    }
    pub async fn delete_job(
        &self,
        id: &str,
    ) -> Result<zyquor_storage::PostJob, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.delete_job(&id)).await
    }
    pub async fn create_attempt(
        &self,
        input: zyquor_storage::NewAttempt,
    ) -> Result<zyquor_storage::PostAttempt, zyquor_storage::StorageError> {
        self.call(move |repo| repo.create_attempt(&input)).await
    }
    pub async fn list_attempts(
        &self,
        job_id: &str,
    ) -> Result<Vec<zyquor_storage::PostAttempt>, zyquor_storage::StorageError> {
        let job_id = job_id.to_string();
        self.call(move |repo| repo.list_attempts(&job_id)).await
    }
    pub async fn create_post_history(
        &self,
        input: zyquor_storage::NewPostHistory,
    ) -> Result<zyquor_storage::PostHistory, zyquor_storage::StorageError> {
        self.call(move |repo| repo.create_post_history(&input))
            .await
    }
    pub async fn list_post_history(
        &self,
    ) -> Result<Vec<zyquor_storage::PostHistory>, zyquor_storage::StorageError> {
        self.call(|repo| repo.list_post_history()).await
    }
    pub async fn get_post_history(
        &self,
        id: &str,
    ) -> Result<Option<zyquor_storage::PostHistory>, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.get_post_history(&id)).await
    }
    pub async fn get_latest_post_history_for_account(
        &self,
        account_id: &str,
    ) -> Result<Option<zyquor_storage::PostHistory>, zyquor_storage::StorageError> {
        let account_id = account_id.to_string();
        self.call(move |repo| repo.get_latest_post_history_for_account(&account_id))
            .await
    }
    pub async fn count_post_history_since(
        &self,
        account_id: &str,
        since_iso: &str,
    ) -> Result<i64, zyquor_storage::StorageError> {
        let account_id = account_id.to_string();
        let since_iso = since_iso.to_string();
        self.call(move |repo| repo.count_post_history_since(&account_id, &since_iso))
            .await
    }
    pub async fn count_post_history_by_draft_id(
        &self,
        draft_id: &str,
    ) -> Result<i64, zyquor_storage::StorageError> {
        let draft_id = draft_id.to_string();
        self.call(move |repo| repo.count_post_history_by_draft_id(&draft_id))
            .await
    }
    pub async fn count_post_history_by_source_packet(
        &self,
        account_id: &str,
        source_packet_id: &str,
    ) -> Result<i64, zyquor_storage::StorageError> {
        let account_id = account_id.to_string();
        let source_packet_id = source_packet_id.to_string();
        self.call(move |repo| {
            repo.count_post_history_by_source_packet(&account_id, &source_packet_id)
        })
        .await
    }
    pub async fn has_post_history_source_url(
        &self,
        account_id: &str,
        source_url: &str,
    ) -> Result<bool, zyquor_storage::StorageError> {
        let account_id = account_id.to_string();
        let source_url = source_url.to_string();
        self.call(move |repo| repo.has_post_history_source_url(&account_id, &source_url))
            .await
    }
    pub async fn update_post_history_metadata(
        &self,
        id: &str,
        metadata: serde_json::Map<String, serde_json::Value>,
    ) -> Result<Option<zyquor_storage::PostHistory>, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.update_post_history_metadata(&id, &metadata))
            .await
    }
    pub async fn purge_post_history_older_than(
        &self,
        cutoff_iso: &str,
    ) -> Result<usize, zyquor_storage::StorageError> {
        let cutoff_iso = cutoff_iso.to_string();
        self.call(move |repo| repo.purge_post_history_older_than(&cutoff_iso))
            .await
    }
    pub async fn has_post_history_text_hash(
        &self,
        account_id: &str,
        text_hash: &str,
        normalized_text: &str,
    ) -> Result<bool, zyquor_storage::StorageError> {
        let (account_id, text_hash, normalized_text) = (
            account_id.to_string(),
            text_hash.to_string(),
            normalized_text.to_string(),
        );
        self.call(move |repo| {
            repo.has_post_history_text_hash(&account_id, &text_hash, &normalized_text)
        })
        .await
    }
    pub async fn get_style_profile(
        &self,
        id: &str,
    ) -> Result<Option<zyquor_storage::StyleProfile>, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.get_style_profile(&id)).await
    }
    pub async fn update_style_profile(
        &self,
        id: &str,
        update: zyquor_storage::StyleProfileUpdate,
    ) -> Result<zyquor_storage::StyleProfile, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.update_style_profile(&id, &update))
            .await
    }
    pub async fn list_system_feedback(
        &self,
        account_id: &str,
    ) -> Result<Vec<zyquor_storage::SystemFeedback>, zyquor_storage::StorageError> {
        let account_id = account_id.to_string();
        self.call(move |repo| repo.list_system_feedback(&account_id))
            .await
    }
    pub async fn add_system_feedback(
        &self,
        account_id: &str,
        text: &str,
    ) -> Result<zyquor_storage::SystemFeedback, zyquor_storage::StorageError> {
        let (account_id, text) = (account_id.to_string(), text.to_string());
        self.call(move |repo| repo.add_system_feedback(&account_id, &text))
            .await
    }
    pub async fn delete_system_feedback(
        &self,
        id: &str,
    ) -> Result<(), zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.delete_system_feedback(&id))
            .await
    }
    pub async fn list_knowledge_entries(
        &self,
        account_id: &str,
    ) -> Result<Vec<zyquor_storage::KnowledgeEntry>, zyquor_storage::StorageError> {
        let account_id = account_id.to_string();
        self.call(move |repo| repo.list_knowledge_entries(&account_id))
            .await
    }
    pub async fn create_knowledge_entry(
        &self,
        input: zyquor_storage::NewKnowledgeEntry,
    ) -> Result<zyquor_storage::KnowledgeEntry, zyquor_storage::StorageError> {
        self.call(move |repo| repo.create_knowledge_entry(&input))
            .await
    }
    pub async fn update_knowledge_entry(
        &self,
        id: &str,
        update: zyquor_storage::KnowledgeUpdate,
    ) -> Result<zyquor_storage::KnowledgeEntry, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.update_knowledge_entry(&id, &update))
            .await
    }
    pub async fn delete_knowledge_entry(
        &self,
        id: &str,
    ) -> Result<zyquor_storage::KnowledgeEntry, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.delete_knowledge_entry(&id))
            .await
    }
    pub async fn create_source_packet(
        &self,
        input: zyquor_storage::NewSourcePacket,
    ) -> Result<zyquor_storage::SourcePacket, zyquor_storage::StorageError> {
        self.call(move |repo| repo.create_source_packet(&input))
            .await
    }
    pub async fn get_source_packet(
        &self,
        id: &str,
    ) -> Result<Option<zyquor_storage::SourcePacket>, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.get_source_packet(&id)).await
    }
    pub async fn get_source_packet_by_url(
        &self,
        url: &str,
        account_id: Option<&str>,
    ) -> Result<Option<zyquor_storage::SourcePacket>, zyquor_storage::StorageError> {
        let url = url.to_string();
        let account_id = account_id.map(str::to_string);
        self.call(move |repo| repo.get_source_packet_by_url(&url, account_id.as_deref()))
            .await
    }
    pub async fn list_source_packets(
        &self,
        account_id: Option<&str>,
        status: Option<zyquor_storage::SourcePacketStatus>,
        limit: Option<i64>,
    ) -> Result<Vec<zyquor_storage::SourcePacket>, zyquor_storage::StorageError> {
        let account_id = account_id.map(str::to_string);
        self.call(move |repo| repo.list_source_packets(account_id.as_deref(), status, limit))
            .await
    }
    pub async fn count_source_packets(
        &self,
        status: Option<zyquor_storage::SourcePacketStatus>,
    ) -> Result<i64, zyquor_storage::StorageError> {
        self.call(move |repo| repo.count_source_packets(status))
            .await
    }
    pub async fn get_latest_source_packet(
        &self,
    ) -> Result<Option<zyquor_storage::SourcePacket>, zyquor_storage::StorageError> {
        self.call(|repo| repo.get_latest_source_packet()).await
    }
    pub async fn delete_source_packet(
        &self,
        id: &str,
    ) -> Result<zyquor_storage::SourcePacket, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.delete_source_packet(&id)).await
    }
    pub async fn mark_source_packet_drafted(
        &self,
        id: &str,
    ) -> Result<zyquor_storage::SourcePacket, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.mark_source_packet_drafted(&id))
            .await
    }
    pub async fn reset_source_packet(
        &self,
        id: &str,
    ) -> Result<zyquor_storage::SourcePacket, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.reset_source_packet(&id)).await
    }
    pub async fn set_source_packet_status(
        &self,
        id: &str,
        status: zyquor_storage::SourcePacketStatus,
    ) -> Result<zyquor_storage::SourcePacket, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.set_source_packet_status(&id, status))
            .await
    }
    pub async fn set_source_packet_feedback(
        &self,
        id: &str,
        feedback: Option<&str>,
    ) -> Result<zyquor_storage::SourcePacket, zyquor_storage::StorageError> {
        let id = id.to_string();
        let feedback = feedback.map(str::to_string);
        self.call(move |repo| repo.set_source_packet_feedback(&id, feedback.as_deref()))
            .await
    }
    pub async fn create_ingest_run(
        &self,
        config_id: &str,
        account_id: &str,
    ) -> Result<zyquor_storage::IngestRun, zyquor_storage::StorageError> {
        let (config_id, account_id) = (config_id.to_string(), account_id.to_string());
        self.call(move |repo| repo.create_ingest_run(&config_id, &account_id))
            .await
    }
    pub async fn update_ingest_run(
        &self,
        id: &str,
        update: zyquor_storage::IngestRunUpdate,
    ) -> Result<zyquor_storage::IngestRun, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.update_ingest_run(&id, &update))
            .await
    }
    pub async fn list_ingest_runs(
        &self,
        account_id: Option<&str>,
        limit: i64,
    ) -> Result<Vec<zyquor_storage::IngestRun>, zyquor_storage::StorageError> {
        let account_id = account_id.map(str::to_string);
        self.call(move |repo| repo.list_ingest_runs(account_id.as_deref(), limit))
            .await
    }
    pub async fn recover_running_ingest_runs(&self) -> Result<usize, zyquor_storage::StorageError> {
        self.call(|repo| repo.recover_running_ingest_runs()).await
    }
    pub async fn upsert_tweet_measurement(
        &self,
        input: zyquor_storage::NewTweetMeasurement,
    ) -> Result<zyquor_storage::TweetMeasurement, zyquor_storage::StorageError> {
        self.call(move |repo| repo.upsert_tweet_measurement(&input))
            .await
    }
    pub async fn list_tweet_measurements(
        &self,
        account_id: Option<&str>,
    ) -> Result<Vec<zyquor_storage::TweetMeasurement>, zyquor_storage::StorageError> {
        let account_id = account_id.map(str::to_string);
        self.call(move |repo| repo.list_tweet_measurements(account_id.as_deref()))
            .await
    }
    pub async fn create_ingest_config(
        &self,
        input: zyquor_storage::NewIngestConfig,
    ) -> Result<zyquor_storage::IngestConfig, zyquor_storage::StorageError> {
        self.call(move |repo| repo.create_ingest_config(&input))
            .await
    }
    pub async fn get_ingest_config(
        &self,
        id: &str,
    ) -> Result<Option<zyquor_storage::IngestConfig>, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.get_ingest_config(&id)).await
    }
    pub async fn list_ingest_configs(
        &self,
        account_id: Option<&str>,
    ) -> Result<Vec<zyquor_storage::IngestConfig>, zyquor_storage::StorageError> {
        let account_id = account_id.map(str::to_string);
        self.call(move |repo| repo.list_ingest_configs(account_id.as_deref()))
            .await
    }
    pub async fn count_ingest_configs(
        &self,
        enabled: Option<bool>,
    ) -> Result<i64, zyquor_storage::StorageError> {
        self.call(move |repo| repo.count_ingest_configs(enabled))
            .await
    }
    pub async fn update_ingest_config(
        &self,
        id: &str,
        update: zyquor_storage::IngestConfigUpdate,
    ) -> Result<zyquor_storage::IngestConfig, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.update_ingest_config(&id, &update))
            .await
    }
    pub async fn delete_ingest_config(
        &self,
        id: &str,
    ) -> Result<zyquor_storage::IngestConfig, zyquor_storage::StorageError> {
        let id = id.to_string();
        self.call(move |repo| repo.delete_ingest_config(&id)).await
    }
}
