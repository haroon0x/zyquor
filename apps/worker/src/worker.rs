//! Worker polling loop, ported 1:1 from `apps/worker/src/index.ts`.

use std::collections::{HashMap, HashSet};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

use chrono::{DateTime, SecondsFormat, Timelike, Utc};
use rand::Rng;
use serde_json::Value;

use crate::client::{ApiClient, ApiError, percent_encode};
use crate::env::{env_flag, env_spacing_f64, env_var};
use crate::types::{
    Account, AccountsResponse, ConfigsResponse, DraftsResponse, HealthResponse, HeartbeatBody,
    IngestRunResponse, JobsResponse, MentionApproveResult, MentionDraftResult, PacketsResponse,
    PerformanceResponse, PostJob, RecoverStaleResponse, SeedResponse, XSession,
};
use zyquor_core::POST_JOB_STATUSES;
use zyquor_core::spacing::{NextAutopostInput, next_autopost_scheduled_for};

pub type ShouldContinue = Arc<dyn Fn() -> bool + Send + Sync>;

const DEFAULT_INGEST_INTERVAL_MS: u64 = 60_000;
const DEFAULT_PERFORMANCE_INTERVAL_MS: u64 = 20 * 60 * 1000;
const DEFAULT_MENTIONS_INTERVAL_MS: u64 = 15 * 60 * 1000;
const X_SESSION_TIMEOUT_MS: u64 = 15_000;
const MENTIONS_TIMEOUT_MS: u64 = 120_000;

#[derive(Clone)]
pub struct WorkerOptions {
    pub api_url: String,
    pub should_continue: Option<ShouldContinue>,
    pub auto_seed_default_ingest: Option<bool>,
    pub ingest_interval_ms: Option<u64>,
    pub performance_interval_ms: Option<u64>,
    pub mentions_interval_ms: Option<u64>,
    pub poll_ms: u64,
}

impl std::fmt::Debug for WorkerOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerOptions")
            .field("api_url", &self.api_url)
            .field("should_continue", &self.should_continue.is_some())
            .field("auto_seed_default_ingest", &self.auto_seed_default_ingest)
            .field("ingest_interval_ms", &self.ingest_interval_ms)
            .field("performance_interval_ms", &self.performance_interval_ms)
            .field("mentions_interval_ms", &self.mentions_interval_ms)
            .field("poll_ms", &self.poll_ms)
            .finish()
    }
}

#[derive(Debug, Clone, Default)]
pub struct WorkerState {
    pub last_error: Option<String>,
    pub last_ingest_ms: u64,
    pub last_performance_ms: u64,
    pub last_mentions_ms: u64,
    pub last_post_ms: u64,
    pub autopost_job_ids: HashSet<String>,
    pub blocked_autopost_job_ids: HashSet<String>,
}

#[derive(Debug, Clone)]
pub struct WorkerDescription {
    pub name: String,
    pub supported_job_statuses: Vec<String>,
    pub mode: String,
}

#[derive(Debug, Clone)]
pub struct StartupReport {
    pub recovered_ingest_run_count: u64,
    pub seeded_config_id: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct CycleReport {
    pub approved_processed: usize,
    pub pending_processed: usize,
    pub recovered_count: u64,
    pub source_packet_processed: usize,
}

pub fn create_worker_state() -> WorkerState {
    WorkerState::default()
}

/// `ZYQUOR_ENABLE_BROWSER_POST === "1"`.
pub fn post_enabled() -> bool {
    env_flag("ZYQUOR_ENABLE_BROWSER_POST")
}

/// Mentions auto-draft: off by default. When enabled the worker calls
/// `POST /replies/mentions/scan-and-draft` per account. That route only ever
/// drafts; the review queue stays the gate and nothing auto-posts.
pub fn mentions_auto_draft_enabled() -> bool {
    env_flag("ZYQUOR_MENTIONS_AUTO_DRAFT")
}

/// Mentions auto-approve: the stage 2 lane. When enabled the worker calls
/// `POST /replies/mentions/scan-and-auto-approve` instead. When both lanes
/// are enabled auto-approve wins (it drafts as well).
pub fn mentions_auto_approve_enabled() -> bool {
    env_flag("ZYQUOR_MENTIONS_AUTO_APPROVE")
}

pub fn mentions_accounts_from_env() -> Vec<String> {
    env_var("ZYQUOR_MENTIONS_ACCOUNTS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

pub fn describe_worker() -> WorkerDescription {
    WorkerDescription {
        name: "zyquor-worker".to_string(),
        supported_job_statuses: POST_JOB_STATUSES
            .iter()
            .map(|status| status.to_string())
            .collect(),
        mode: "prepare_only".to_string(),
    }
}

fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

fn iso_from_millis(millis: u64) -> Option<String> {
    if millis == 0 {
        return None;
    }
    DateTime::<Utc>::from_timestamp_millis(millis as i64)
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn parse_ms(value: &str) -> Option<f64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis() as f64)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn trace_suffix(job_id: &str) -> String {
    job_id.chars().take(8).collect()
}

fn minutes_since_midnight(time: &str) -> Option<u32> {
    let (hour_part, minute_part) = time.split_once(':')?;
    let hour = hour_part.parse::<u32>().ok()?;
    let minute = minute_part.parse::<u32>().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some(hour * 60 + minute)
}

fn is_within_quiet_hours_at(hour: u32, minute: u32, account: &Account) -> bool {
    let (Some(start_text), Some(end_text)) = (
        account.quiet_hours_start.as_deref(),
        account.quiet_hours_end.as_deref(),
    ) else {
        return false;
    };
    let (Some(start), Some(end)) = (
        minutes_since_midnight(start_text),
        minutes_since_midnight(end_text),
    ) else {
        return false;
    };
    if start == end {
        return false;
    }
    let current = hour * 60 + minute;
    if start < end {
        current >= start && current < end
    } else {
        current >= start || current < end
    }
}

fn is_within_quiet_hours(account: &Account) -> bool {
    let now = chrono::Local::now();
    is_within_quiet_hours_at(now.hour(), now.minute(), account)
}

fn is_non_retryable_post_error(message: &str) -> bool {
    message.contains("Source packet already reached")
        || message.contains("Duplicate post text for this account")
        || message.contains("Daily post limit reached for this account")
}

fn extract_next_eligible_at(message: &str) -> Option<String> {
    let marker = "Next post allowed at ";
    let start = message.find(marker)? + marker.len();
    let rest = &message[start..];
    let mut end = rest.len();
    for (index, ch) in rest.char_indices() {
        if ch.is_whitespace() || ch == ')' {
            end = index;
            break;
        }
    }
    let value = &rest[..end];
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

fn mentions_interval_ms(options: &WorkerOptions) -> u64 {
    if let Some(value) = options.mentions_interval_ms {
        return value;
    }
    match env_var("ZYQUOR_MENTIONS_INTERVAL_MS") {
        Some(raw) => match raw.parse::<f64>() {
            Ok(value) if value.is_finite() && value > 0.0 => value as u64,
            _ => DEFAULT_MENTIONS_INTERVAL_MS,
        },
        None => DEFAULT_MENTIONS_INTERVAL_MS,
    }
}

fn keep_going(options: &WorkerOptions) -> bool {
    match &options.should_continue {
        Some(callback) => callback(),
        None => true,
    }
}

/// `workerState` ops are sequential within one loop task, so a plain
/// `&mut WorkerState` is enough.
pub async fn heartbeat(client: &ApiClient, state: &WorkerState) {
    let body = HeartbeatBody {
        last_error: state.last_error.clone(),
        last_ingest_at: iso_from_millis(state.last_ingest_ms),
        last_post_at: iso_from_millis(state.last_post_ms),
    };
    if let Err(error) = client
        .post::<Value, _>("/worker/heartbeat", Some(&body), None)
        .await
    {
        eprintln!("Failed to update worker heartbeat: {}", error.message());
    }
}

pub async fn check_worker_startup(
    client: &ApiClient,
    options: &WorkerOptions,
) -> Result<StartupReport, ApiError> {
    let mut warnings: Vec<String> = Vec::new();
    let mut recovered_ingest_run_count: u64 = 0;
    let mut seeded_config_id: Option<String> = None;

    if let Err(error) = client.get::<HealthResponse>("/health", None).await {
        warnings.push(format!(
            "API unreachable at {}: {}",
            options.api_url,
            error.message()
        ));
        return Ok(StartupReport {
            recovered_ingest_run_count,
            seeded_config_id,
            warnings,
        });
    }

    if !post_enabled() {
        warnings.push(
            "Browser post is disabled, so drafts queue up as approved autopost jobs but never submit to X."
                .to_string(),
        );
    }
    if mentions_auto_approve_enabled() && mentions_accounts_from_env().is_empty() {
        warnings.push(
            "Mentions auto-approve is enabled but ZYQUOR_MENTIONS_ACCOUNTS is empty, so no account gets scanned."
                .to_string(),
        );
    }
    if mentions_auto_draft_enabled() && mentions_accounts_from_env().is_empty() {
        warnings.push(
            "Mentions auto-draft is enabled but ZYQUOR_MENTIONS_ACCOUNTS is empty, so no account gets scanned."
                .to_string(),
        );
    }
    if mentions_auto_approve_enabled() && mentions_auto_draft_enabled() {
        warnings.push(
            "Mentions auto-draft and auto-approve are both enabled; the auto-approve lane takes precedence."
                .to_string(),
        );
    }

    let recovery = client
        .post::<RecoverStaleResponse, Value>("/ingest-runs/recover-stale", None, None)
        .await?;
    recovered_ingest_run_count = recovery.recovered_count;

    let (accounts_result, configs_result) = tokio::join!(
        client.get::<AccountsResponse>("/accounts", None),
        client.get::<ConfigsResponse>("/ingest-configs", None)
    );
    let accounts = accounts_result?.accounts;
    let configs = configs_result?.configs;
    let enabled_accounts: Vec<&Account> =
        accounts.iter().filter(|account| account.enabled).collect();
    let enabled_configs = configs.iter().filter(|config| config.enabled).count();

    if enabled_configs == 0 {
        let seed_allowed = !matches!(options.auto_seed_default_ingest, Some(false));
        if configs.is_empty() && seed_allowed && !enabled_accounts.is_empty() {
            let seeded = client
                .post::<SeedResponse, Value>("/ingest-configs/default-news", None, None)
                .await?;
            seeded_config_id = Some(seeded.config.id);
        } else {
            warnings.push(
                "No enabled ingest configs exist, so worker has no source to pull.".to_string(),
            );
        }
    }

    if enabled_accounts.is_empty() {
        warnings.push("No enabled account exists for automatic posting.".to_string());
    } else {
        let browser_prepare = env_flag("ZYQUOR_ENABLE_BROWSER_PREPARE");
        let browser_post = post_enabled();
        if !browser_prepare && !browser_post {
            println!("skipping X session check (browser actions disabled)");
        } else {
            for account in &enabled_accounts {
                let path = format!(
                    "/browser/x-session?accountId={}",
                    percent_encode(&account.id)
                );
                match client
                    .get::<XSession>(&path, Some(Duration::from_millis(X_SESSION_TIMEOUT_MS)))
                    .await
                {
                    Ok(session) => {
                        if !session.logged_in {
                            let suffix = session
                                .error
                                .as_deref()
                                .map_or_else(String::new, |e| format!(": {e}"));
                            warnings.push(format!(
                                "X login missing for {} (@{}){}",
                                account.id, account.handle, suffix
                            ));
                        }
                    }
                    Err(error) => {
                        warnings.push(format!(
                            "X login check failed for @{}: {}",
                            account.handle,
                            error.message()
                        ));
                    }
                }
            }
        }
    }

    Ok(StartupReport {
        recovered_ingest_run_count,
        seeded_config_id,
        warnings,
    })
}

pub async fn process_approved_jobs(
    client: &ApiClient,
    options: &WorkerOptions,
    state: &mut WorkerState,
) -> Result<usize, ApiError> {
    match client.get::<HealthResponse>("/health", None).await {
        Ok(health) => {
            if !health.ok {
                eprintln!(
                    "Cannot reach Zyquor API at {}: API health check failed",
                    options.api_url
                );
                return Ok(0);
            }
        }
        Err(error) => {
            eprintln!(
                "Cannot reach Zyquor API at {}: {}",
                options.api_url,
                error.message()
            );
            return Ok(0);
        }
    }

    let (jobs_result, accounts_result) = tokio::join!(
        client.get::<JobsResponse>("/jobs?statuses=approved", None),
        client.get::<AccountsResponse>("/accounts", None)
    );
    let jobs = jobs_result?.jobs;
    let accounts = accounts_result?.accounts;
    let now_ms = now_millis();
    let account_by_id: HashMap<&str, &Account> = accounts
        .iter()
        .map(|account| (account.id.as_str(), account))
        .collect();

    let mut approved_jobs: Vec<PostJob> = jobs
        .into_iter()
        .filter(|job| {
            let Some(account) = account_by_id.get(job.account_id.as_str()) else {
                return false;
            };
            if is_within_quiet_hours(account) {
                return false;
            }
            let due = match job.scheduled_for.as_deref() {
                None => true,
                Some(text) => parse_ms(text).is_some_and(|ms| ms <= now_ms as f64),
            };
            due && (job.mode == "prepare_only" || job.mode == "scheduled" || job.mode == "autopost")
        })
        .collect();

    let mut account_order: Vec<String> = Vec::new();
    let mut by_account: HashMap<String, Vec<usize>> = HashMap::new();
    for (index, job) in approved_jobs.iter().enumerate() {
        if !by_account.contains_key(&job.account_id) {
            account_order.push(job.account_id.clone());
        }
        by_account
            .entry(job.account_id.clone())
            .or_default()
            .push(index);
    }

    let mut processed: usize = 0;
    let mut seen_this_run: HashSet<String> = HashSet::new();
    for account_id in &account_order {
        let mut indices = by_account.get(account_id).cloned().unwrap_or_default();
        indices.sort_by_key(|index| {
            approved_jobs
                .get(*index)
                .and_then(|job| job.scheduled_for.as_deref())
                .and_then(parse_ms)
                .map(|ms| ms as i64)
                .unwrap_or(0)
        });
        for index in indices {
            if !keep_going(options) {
                break;
            }
            let job_id = approved_jobs[index].id.clone();
            if seen_this_run.contains(&job_id) {
                continue;
            }
            seen_this_run.insert(job_id.clone());

            let mode = approved_jobs[index].mode.clone();
            let action = if mode == "autopost" {
                "post"
            } else {
                "prepare"
            };
            if action == "post" && !post_enabled() {
                continue;
            }
            if action == "post" && state.autopost_job_ids.contains(&job_id) {
                continue;
            }
            if action == "post" && state.blocked_autopost_job_ids.contains(&job_id) {
                continue;
            }

            if action == "post" && approved_jobs[index].scheduled_for.is_none() {
                let mut recent: Vec<f64> = approved_jobs
                    .iter()
                    .filter(|other| other.account_id == *account_id)
                    .filter_map(|other| other.scheduled_for.as_deref())
                    .filter_map(parse_ms)
                    .collect();
                recent.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                let mut recent_gap_ms: Vec<f64> = Vec::new();
                for pair in recent.windows(2) {
                    if let (Some(first), Some(second)) = (pair.first(), pair.get(1)) {
                        recent_gap_ms.push((second - first).abs());
                    }
                }
                let input = NextAutopostInput {
                    last_scheduled_for: None,
                    timestamp: now_iso(),
                    gap_min_minutes: env_spacing_f64("ZYQUOR_POST_GAP_MIN_MINUTES", 40.0),
                    gap_max_minutes: env_spacing_f64("ZYQUOR_POST_GAP_MAX_MINUTES", 150.0),
                    jitter_ratio: None,
                    recent_gap_ms: Some(recent_gap_ms),
                    trace_id: Some(format!("backfill-{}", trace_suffix(&job_id))),
                    long_pause_chance: env_spacing_f64("ZYQUOR_POST_LONG_PAUSE_CHANCE", 0.15),
                    long_pause_min_minutes: env_spacing_f64(
                        "ZYQUOR_POST_LONG_PAUSE_MIN_MINUTES",
                        180.0,
                    ),
                    long_pause_max_minutes: env_spacing_f64(
                        "ZYQUOR_POST_LONG_PAUSE_MAX_MINUTES",
                        480.0,
                    ),
                };
                match next_autopost_scheduled_for(&input) {
                    Ok(next) => {
                        let body = serde_json::json!({ "scheduledFor": next.scheduled_for });
                        let path = format!("/jobs/{job_id}");
                        match client.patch::<Value, _>(&path, Some(&body), None).await {
                            Ok(_) => {
                                println!(
                                    "Back-filled autopost job {job_id} with scheduledFor={} ({:.1} min)",
                                    next.scheduled_for, next.gap_minutes
                                );
                                approved_jobs[index].scheduled_for = Some(next.scheduled_for);
                            }
                            Err(error) => {
                                eprintln!(
                                    "Failed to back-fill schedule for {job_id}: {}",
                                    error.message()
                                );
                            }
                        }
                    }
                    Err(error) => {
                        eprintln!("Failed to back-fill schedule for {job_id}: {error}");
                    }
                }
                continue;
            }

            let trace_id = format!("job-{}-{action}", trace_suffix(&job_id));
            let scheduled_display = approved_jobs[index]
                .scheduled_for
                .clone()
                .unwrap_or_else(|| "null".to_string());
            println!(
                "[trace={trace_id}] [worker] firing {action} account={account_id} mode={mode} scheduledFor={scheduled_display}"
            );
            let path = format!("/jobs/{job_id}/{action}");
            match client.post::<Value, Value>(&path, None, None).await {
                Ok(_) => {
                    if action == "post" {
                        state.autopost_job_ids.insert(job_id.clone());
                        state.last_post_ms = now_millis() as u64;
                        println!("[trace={trace_id}] [worker] post-success account={account_id}");
                    }
                    processed += 1;
                }
                Err(error) => {
                    let message = error.message().to_string();
                    if action == "post" && message.contains("Too soon since the last post") {
                        if let Some(next_eligible) = extract_next_eligible_at(&message) {
                            let patch_path = format!("/jobs/{job_id}");
                            let body = serde_json::json!({ "scheduledFor": next_eligible });
                            match client
                                .patch::<Value, _>(&patch_path, Some(&body), None)
                                .await
                            {
                                Ok(_) => {
                                    approved_jobs[index].scheduled_for =
                                        Some(next_eligible.clone());
                                    println!(
                                        "[trace={trace_id}] [worker] post-gate rescheduled job {job_id} scheduledFor={next_eligible}"
                                    );
                                }
                                Err(patch_error) => {
                                    eprintln!(
                                        "[trace={trace_id}] [worker] failed to reschedule job {job_id} after post-gate: {}",
                                        patch_error.message()
                                    );
                                }
                            }
                        } else {
                            println!(
                                "[trace={trace_id}] [worker] post-gate rejected job {job_id} with no parseable nextEligibleAt: {message}"
                            );
                        }
                        continue;
                    }
                    eprintln!("Failed to {action} job {job_id}: {message}");
                    if action == "post" && is_non_retryable_post_error(&message) {
                        state.blocked_autopost_job_ids.insert(job_id.clone());
                        println!(
                            "[trace=job-{}-post] [worker] non-retryable error: {message}",
                            trace_suffix(&job_id)
                        );
                    }
                    if action == "post"
                        && message
                            .contains("Another browser job is already running for this account")
                    {
                        break;
                    }
                }
            }
        }
    }

    Ok(processed)
}

pub async fn process_pending_drafts(
    client: &ApiClient,
    options: &WorkerOptions,
) -> Result<usize, ApiError> {
    let drafts = client
        .get::<DraftsResponse>("/drafts/pending", None)
        .await?
        .drafts;
    let mut generated: usize = 0;
    for draft in drafts {
        if !keep_going(options) {
            break;
        }
        let path = format!("/drafts/{}/generate", draft.id);
        match client.post::<Value, Value>(&path, None, None).await {
            Ok(_) => generated += 1,
            Err(error) => eprintln!("Failed to generate draft {}: {}", draft.id, error.message()),
        }
    }
    Ok(generated)
}

pub async fn process_new_source_packets(
    client: &ApiClient,
    options: &WorkerOptions,
) -> Result<usize, ApiError> {
    let packets = client
        .get::<PacketsResponse>("/source-packets?status=new", None)
        .await?
        .packets
        .unwrap_or_default();
    let mut processed: usize = 0;
    for packet in packets {
        if packet.status != "new" {
            continue;
        }
        if !keep_going(options) {
            break;
        }
        let body = serde_json::json!({ "autoApprove": true, "count": 1 });
        let path = format!("/source-packets/{}/draft", packet.id);
        match client.post::<Value, _>(&path, Some(&body), None).await {
            Ok(_) => processed += 1,
            Err(error) => eprintln!(
                "Failed to draft source packet {}: {}",
                packet.id,
                error.message()
            ),
        }
    }
    Ok(processed)
}

pub async fn process_ingest(client: &ApiClient) -> usize {
    match client
        .post::<IngestRunResponse, Value>("/ingest-run/async", None, None)
        .await
    {
        Ok(result) => usize::from(result.accepted),
        Err(error) => {
            eprintln!("Failed to run ingest: {}", error.message());
            0
        }
    }
}

pub async fn process_mentions_auto_draft(client: &ApiClient) -> usize {
    let accounts = mentions_accounts_from_env();
    if accounts.is_empty() {
        return 0;
    }
    let mut drafted: usize = 0;
    for account_id in accounts {
        let body = serde_json::json!({ "accountId": account_id });
        match client
            .post::<MentionDraftResult, _>(
                "/replies/mentions/scan-and-draft",
                Some(&body),
                Some(Duration::from_millis(MENTIONS_TIMEOUT_MS)),
            )
            .await
        {
            Ok(result) => {
                let count = result.created.map_or(0, |created| created.len());
                println!("[mentions] drafted {count} reply draft(s) for {account_id}");
                drafted += count;
            }
            Err(error) => eprintln!(
                "[mentions] scan-and-draft failed for {account_id}: {}",
                error.message()
            ),
        }
    }
    drafted
}

pub async fn process_mentions_auto_approve(client: &ApiClient) -> usize {
    let accounts = mentions_accounts_from_env();
    if accounts.is_empty() {
        return 0;
    }
    let mut approved: usize = 0;
    for account_id in accounts {
        let body = serde_json::json!({ "accountId": account_id });
        match client
            .post::<MentionApproveResult, _>(
                "/replies/mentions/scan-and-auto-approve",
                Some(&body),
                Some(Duration::from_millis(MENTIONS_TIMEOUT_MS)),
            )
            .await
        {
            Ok(result) => {
                let approved_count = result.approved.map_or(0, |items| items.len());
                let held_count = result.held.map_or(0, |items| items.len());
                println!(
                    "[mentions] auto-approved {approved_count} reply draft(s) for {account_id} ({held_count} held for review)"
                );
                approved += approved_count;
            }
            Err(error) => eprintln!(
                "[mentions] scan-and-auto-approve failed for {account_id}: {}",
                error.message()
            ),
        }
    }
    approved
}

pub async fn refresh_performance(client: &ApiClient) -> usize {
    match client
        .post::<PerformanceResponse, Value>("/performance/refresh", None, None)
        .await
    {
        Ok(result) => {
            if !result.measured.is_empty() {
                println!("[performance] measured {} post(s)", result.measured.len());
            }
            result.measured.len()
        }
        Err(error) => {
            eprintln!("Failed to refresh post performance: {}", error.message());
            0
        }
    }
}

pub async fn recover_stale_jobs(client: &ApiClient) -> u64 {
    match client
        .post::<RecoverStaleResponse, Value>("/jobs/recover-stale", None, None)
        .await
    {
        Ok(result) => result.recovered_count,
        Err(error) => {
            eprintln!("Failed to recover stale jobs: {}", error.message());
            0
        }
    }
}

pub async fn run_worker_cycle(
    client: &ApiClient,
    options: &WorkerOptions,
    state: &mut WorkerState,
) -> Result<CycleReport, ApiError> {
    state.last_error = None;
    let recovered_count = recover_stale_jobs(client).await;
    if recovered_count > 0 {
        println!("Recovered {recovered_count} stale browser job(s)");
    }

    let approved_processed = if keep_going(options) {
        process_approved_jobs(client, options, state).await?
    } else {
        0
    };
    if approved_processed > 0 {
        println!("Processed {approved_processed} approved job(s)");
    }

    let pending_processed = if keep_going(options) {
        process_pending_drafts(client, options).await?
    } else {
        0
    };
    if pending_processed > 0 {
        println!("Generated {pending_processed} pending draft(s)");
    }

    let source_packet_processed = if keep_going(options) {
        process_new_source_packets(client, options).await?
    } else {
        0
    };
    if source_packet_processed > 0 {
        println!("Drafted {source_packet_processed} source packet(s)");
    }

    if keep_going(options) && (mentions_auto_approve_enabled() || mentions_auto_draft_enabled()) {
        let scans_started_at = now_millis();
        let interval = mentions_interval_ms(options);
        if scans_started_at.saturating_sub(state.last_mentions_ms as i64) >= interval as i64 {
            state.last_mentions_ms = scans_started_at as u64;
            if mentions_accounts_from_env().is_empty() {
                eprintln!(
                    "[mentions] mentions automation is on but ZYQUOR_MENTIONS_ACCOUNTS lists no account ids; skipping."
                );
            } else if mentions_auto_approve_enabled() {
                let approved = process_mentions_auto_approve(client).await;
                if approved > 0 {
                    println!("Mention auto-approve approved {approved} reply draft(s)");
                }
            } else {
                let created = process_mentions_auto_draft(client).await;
                if created > 0 {
                    println!("Mention auto-draft created {created} reply draft(s)");
                }
            }
        }
    }

    let now = now_millis();
    let ingest_interval = options
        .ingest_interval_ms
        .unwrap_or(DEFAULT_INGEST_INTERVAL_MS);
    if keep_going(options)
        && now.saturating_sub(state.last_ingest_ms as i64) >= ingest_interval as i64
    {
        state.last_ingest_ms = now as u64;
        if process_ingest(client).await > 0 {
            println!("Queued async ingest run");
        }
    }

    let base_performance = options
        .performance_interval_ms
        .unwrap_or(DEFAULT_PERFORMANCE_INTERVAL_MS);
    let jittered = {
        let mut rng = rand::rng();
        let jitter_factor = 0.6 + 0.8 * rng.random::<f64>();
        (base_performance as f64 * jitter_factor) as u64
    };
    if keep_going(options)
        && now.saturating_sub(state.last_performance_ms as i64) >= jittered as i64
    {
        state.last_performance_ms = now as u64;
        let _ = refresh_performance(client).await;
    }

    heartbeat(client, state).await;

    Ok(CycleReport {
        approved_processed,
        pending_processed,
        recovered_count,
        source_packet_processed,
    })
}

pub type WorkerJoinHandle = tokio::task::JoinHandle<Result<(), String>>;

pub struct WorkerHandle {
    paused: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    join: Arc<Mutex<Option<WorkerJoinHandle>>>,
}

impl WorkerHandle {
    pub fn is_paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }

    pub fn set_paused(&self, paused: bool) {
        self.paused.store(paused, Ordering::SeqCst);
    }

    pub fn request_stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
    }

    pub async fn wait_finished(&self) -> Result<(), String> {
        let handle = {
            let mut guard = self
                .join
                .lock()
                .map_err(|_| "worker handle lock failed".to_string())?;
            guard.take()
        };
        match handle {
            Some(task) => task.await.unwrap_or_else(|error| Err(error.to_string())),
            None => Ok(()),
        }
    }

    pub async fn stop(&self) -> Result<(), String> {
        self.request_stop();
        self.wait_finished().await
    }
}

async fn sleep_poll(poll_ms: u64, stopping: &AtomicBool) {
    let mut remaining = Duration::from_millis(poll_ms.max(1));
    while remaining > Duration::ZERO {
        if stopping.load(Ordering::SeqCst) {
            return;
        }
        let chunk = remaining.min(Duration::from_millis(50));
        tokio::time::sleep(chunk).await;
        remaining = remaining.saturating_sub(chunk);
    }
}

/// Start the polling loop task. Must be called from within a Tokio runtime.
pub fn start_worker(options: WorkerOptions) -> Result<WorkerHandle, ApiError> {
    let client = ApiClient::new(&options.api_url)?;
    let paused = Arc::new(AtomicBool::new(false));
    let stopping = Arc::new(AtomicBool::new(false));
    let outer_continue = options.should_continue.clone();
    let paused_cond = paused.clone();
    let stopping_cond = stopping.clone();
    let paused_loop = paused.clone();
    let cycle_options = WorkerOptions {
        should_continue: Some(Arc::new(move || {
            if paused_cond.load(Ordering::SeqCst) || stopping_cond.load(Ordering::SeqCst) {
                return false;
            }
            match outer_continue.as_ref() {
                Some(callback) => callback(),
                None => true,
            }
        })),
        ..options.clone()
    };
    let poll_ms = options.poll_ms.max(1);

    let stopping_task = stopping.clone();
    let join = tokio::spawn(async move {
        let mut state = create_worker_state();
        let description = describe_worker();
        let description_json = serde_json::json!({
            "name": description.name,
            "supportedJobStatuses": description.supported_job_statuses,
            "mode": description.mode,
        });
        println!(
            "{}",
            serde_json::to_string(&description_json).unwrap_or_default()
        );
        match check_worker_startup(&client, &cycle_options).await {
            Ok(report) => {
                for warning in &report.warnings {
                    eprintln!("{warning}");
                }
                if let Some(id) = &report.seeded_config_id {
                    println!("Seeded default news ingest config {id}");
                }
                if report.recovered_ingest_run_count > 0 {
                    println!(
                        "Marked {} interrupted ingest run(s) as failed",
                        report.recovered_ingest_run_count
                    );
                }
            }
            Err(error) => {
                state.last_error = Some(error.message().to_string());
                eprintln!("{}", error.message());
                return Err(error.message().to_string());
            }
        }

        loop {
            if stopping_task.load(Ordering::SeqCst) {
                return Ok(());
            }
            if paused_loop.load(Ordering::SeqCst) {
                heartbeat(&client, &state).await;
            } else if let Err(error) = run_worker_cycle(&client, &cycle_options, &mut state).await {
                state.last_error = Some(error.message().to_string());
                eprintln!("{}", error.message());
                heartbeat(&client, &state).await;
            }
            sleep_poll(poll_ms, &stopping_task).await;
        }
    });

    Ok(WorkerHandle {
        paused,
        stopping,
        join: Arc::new(Mutex::new(Some(join))),
    })
}

pub async fn run_worker(options: WorkerOptions) -> Result<(), String> {
    let handle = start_worker(options).map_err(|error| error.message().to_string())?;
    handle.wait_finished().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::Account;

    fn account_with_quiet(start: Option<&str>, end: Option<&str>) -> Account {
        Account {
            id: "a1".to_string(),
            handle: "handle".to_string(),
            enabled: true,
            quiet_hours_start: start.map(str::to_string),
            quiet_hours_end: end.map(str::to_string),
        }
    }

    #[test]
    fn minutes_parse() {
        assert_eq!(minutes_since_midnight("01:30"), Some(90));
        assert_eq!(minutes_since_midnight("23:59"), Some(1439));
        assert_eq!(minutes_since_midnight("24:00"), None);
        assert_eq!(minutes_since_midnight("12"), None);
        assert_eq!(minutes_since_midnight("aa:bb"), None);
    }

    #[test]
    fn quiet_hours_wrap_around() {
        let account = account_with_quiet(Some("22:00"), Some("06:00"));
        assert!(is_within_quiet_hours_at(23, 30, &account));
        assert!(is_within_quiet_hours_at(5, 59, &account));
        assert!(!is_within_quiet_hours_at(6, 0, &account));
        assert!(!is_within_quiet_hours_at(12, 0, &account));
    }

    #[test]
    fn quiet_hours_same_day_and_invalid() {
        let account = account_with_quiet(Some("09:00"), Some("17:00"));
        assert!(is_within_quiet_hours_at(12, 0, &account));
        assert!(!is_within_quiet_hours_at(17, 0, &account));
        assert!(!is_within_quiet_hours_at(
            12,
            0,
            &account_with_quiet(None, Some("17:00"))
        ));
        assert!(!is_within_quiet_hours_at(
            12,
            0,
            &account_with_quiet(Some("09:00"), Some("09:00"))
        ));
    }

    #[test]
    fn next_eligible_parse() {
        let message = "Worker request to http://api.test/jobs/job1/post failed: Too soon since the last post. Next post allowed at 2026-04-25T12:00:00.000Z (retry later)";
        assert_eq!(
            extract_next_eligible_at(message).as_deref(),
            Some("2026-04-25T12:00:00.000Z")
        );
        assert_eq!(extract_next_eligible_at("nothing here"), None);
        assert_eq!(extract_next_eligible_at("Next post allowed at "), None);
    }

    #[test]
    fn trace_and_non_retryable() {
        assert_eq!(trace_suffix("job_123456789"), "job_1234");
        assert!(is_non_retryable_post_error(
            "Duplicate post text for this account"
        ));
        assert!(!is_non_retryable_post_error("browser failed"));
    }
}
