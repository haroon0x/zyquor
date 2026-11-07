//! Jobs routes, ported from `apps/api/src/routes/jobs.ts`.

use std::collections::HashSet;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use zyquor_core::types::{AttemptStatus, PostJobStatus, PostingMode};

use crate::errors::ApiError;
use crate::state::{AppState, Repository};

fn api_error_message(error: &ApiError) -> String {
    match error {
        ApiError::Invalid { message, .. } => message.clone(),
        ApiError::Http(http_error) => http_error.message.clone(),
        ApiError::Conflict(message) => message.clone(),
        ApiError::Generation(message) => message.clone(),
        ApiError::Internal(message) => message.clone(),
    }
}

// ---------------------------------------------------------------------------
// Helpers: lib/browser, lib/paths, lib/per-profile-cdp
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct BrowserOptions {
    action_delay_ms: Option<u64>,
    cdp_url: Option<String>,
    typing_delay_ms: Option<u64>,
}

fn browser_options(state: &AppState) -> BrowserOptions {
    match state.browser.lock() {
        Ok(guard) => BrowserOptions {
            action_delay_ms: guard.action_delay_ms,
            cdp_url: guard.cdp_url.clone(),
            typing_delay_ms: guard.typing_delay_ms,
        },
        Err(poisoned) => {
            let guard = poisoned.into_inner();
            BrowserOptions {
                action_delay_ms: guard.action_delay_ms,
                cdp_url: guard.cdp_url.clone(),
                typing_delay_ms: guard.typing_delay_ms,
            }
        }
    }
}

fn browser_enable_prepare(state: &AppState) -> bool {
    match state.browser.lock() {
        Ok(guard) => guard.enable_prepare,
        Err(poisoned) => poisoned.into_inner().enable_prepare,
    }
}

fn browser_enable_post(state: &AppState) -> bool {
    match state.browser.lock() {
        Ok(guard) => guard.enable_post,
        Err(poisoned) => poisoned.into_inner().enable_post,
    }
}

fn browser_close_after_prepare(state: &AppState) -> bool {
    match state.browser.lock() {
        Ok(guard) => guard.close_after_prepare.unwrap_or(true),
        Err(poisoned) => poisoned.into_inner().close_after_prepare.unwrap_or(true),
    }
}

fn browser_close_after_post(state: &AppState) -> bool {
    match state.browser.lock() {
        Ok(guard) => guard.close_after_post.unwrap_or(false),
        Err(poisoned) => poisoned.into_inner().close_after_post.unwrap_or(false),
    }
}

fn resolve_profile_dir(profile_dir: &str) -> String {
    if std::path::Path::new(profile_dir).is_absolute() {
        profile_dir.to_string()
    } else {
        zyquor_core::paths::resolve_data_root()
            .join(profile_dir)
            .to_string_lossy()
            .to_string()
    }
}

fn per_profile_cdp_url(base: Option<&str>, profile_dir: &str) -> String {
    zyquor_core::paths::per_profile_cdp_url(base, profile_dir)
}

fn mark_browser_loaded(state: &AppState) {
    let mut guard = match state.runtime.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard.browser_loaded = true;
}

// ---------------------------------------------------------------------------
// Helpers: lib/post-process
// ---------------------------------------------------------------------------

static TRACE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn trace_post_process_tweet_text(label: &str, text: &str, preserve_case: bool) -> String {
    let seq = TRACE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let trace_id = format!("pp-{}-{}", now_ms, seq);
    let before = text;
    let after = if preserve_case {
        zyquor_generation::format_tweet_text(text)
    } else {
        zyquor_generation::post_process_tweet_text(text)
    };
    let before_has_upper = before.chars().any(|c| c.is_ascii_uppercase());
    let after_has_upper = after.chars().any(|c| c.is_ascii_uppercase());
    let changed = before != after;
    let before_head: String = before.chars().take(60).collect();
    let after_head: String = after.chars().take(60).collect();
    println!(
        "[trace={trace_id}] [post-process] label={label} beforeLen={} afterLen={} changed={changed} beforeHasUpper={before_has_upper} afterHasUpper={after_has_upper} beforeHead={before_head:?} afterHead={after_head:?}",
        before.len(),
        after.len()
    );
    after
}

// ---------------------------------------------------------------------------
// Helpers: lib/daily-limit
// ---------------------------------------------------------------------------

fn env_integer(name: &str, fallback: i64) -> i64 {
    std::env::var(name)
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| value.floor() as i64)
        .unwrap_or(fallback)
}

fn daily_hash(seed: &str) -> u32 {
    let mut hash: u32 = 0;
    for i in 0..seed.len() {
        let ch = seed.as_bytes().get(i).copied().unwrap_or(0) as u32;
        hash = hash.wrapping_mul(31).wrapping_add(ch);
    }
    hash
}

fn absolute_daily_post_limit() -> i64 {
    env_integer("ZYQUOR_DAILY_POST_CEILING", 4)
}

struct DailyVarianceCap {
    min: i64,
    max: i64,
    value: i64,
    trace_id: String,
    absolute: i64,
}

fn daily_variance_cap() -> DailyVarianceCap {
    let absolute = absolute_daily_post_limit();
    let min = absolute.min(env_integer("ZYQUOR_DAILY_POST_VARIANCE_MIN", 2).max(1));
    let requested_max = env_integer("ZYQUOR_DAILY_POST_VARIANCE_MAX", 4).max(min);
    let max = requested_max.min(absolute);
    let seed = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let span = (max - min + 1).max(1);
    let value = min + (daily_hash(&seed) as i64 % span);
    DailyVarianceCap {
        min,
        max,
        value,
        trace_id: seed,
        absolute,
    }
}

async fn is_daily_limit_reached(
    repository: &Repository,
    account_id: &str,
    daily_post_limit: Option<i64>,
) -> Result<bool, ApiError> {
    if daily_post_limit.is_none_or(|limit| limit <= 0) {
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        println!(
            "[trace={today}] [daily-limit] account={account_id} accountDailyPostLimit={daily_post_limit:?} reached=false (no limit configured)"
        );
        return Ok(false);
    }
    let limit =
        daily_post_limit.ok_or_else(|| ApiError::Internal("missing daily limit".to_string()))?;
    let variance = daily_variance_cap();
    let effective_limit = limit.min(variance.value);
    let since_iso = format!("{}T00:00:00.000Z", variance.trace_id);
    let posts_today = repository
        .count_post_history_since(account_id, &since_iso)
        .await?;
    let reached = posts_today >= effective_limit;
    println!(
        "[trace={}] [daily-limit] account={} accountDailyPostLimit={} varianceCap={} (min={} max={}) absoluteCeiling={} postsToday={} effectiveLimit={} reached={}",
        variance.trace_id,
        account_id,
        limit,
        variance.value,
        variance.min,
        variance.max,
        variance.absolute,
        posts_today,
        effective_limit,
        reached
    );
    Ok(reached)
}

// ---------------------------------------------------------------------------
// Helpers: lib/media
// ---------------------------------------------------------------------------

fn media_urls_from_draft_metadata(metadata: &Map<String, Value>) -> Vec<String> {
    let urls = metadata.get("mediaUrls").and_then(Value::as_array);
    let Some(urls) = urls else {
        return Vec::new();
    };
    urls.iter()
        .filter_map(Value::as_str)
        .filter(|url| {
            let lower = url.to_ascii_lowercase();
            lower.starts_with("https://") || lower.starts_with("http://")
        })
        .take(4)
        .map(str::to_string)
        .collect()
}

fn extension_for_media(url: &str, content_type: Option<&str>) -> String {
    let from_url = std::path::Path::new(url)
        .extension()
        .map(|ext| format!(".{}", ext.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    if [".avif", ".gif", ".jpg", ".jpeg", ".png", ".webp"].contains(&from_url.as_str()) {
        return from_url;
    }
    if let Some(ct) = content_type {
        let lower = ct.to_ascii_lowercase();
        if lower.contains("png") {
            return ".png".to_string();
        }
        if lower.contains("webp") {
            return ".webp".to_string();
        }
        if lower.contains("gif") {
            return ".gif".to_string();
        }
        if lower.contains("avif") {
            return ".avif".to_string();
        }
    }
    ".jpg".to_string()
}

async fn download_media_urls(urls: Vec<String>) -> Result<Vec<String>, String> {
    if urls.is_empty() {
        return Ok(Vec::new());
    }
    let media_dir = zyquor_core::paths::data_path(["data", "media"]);
    std::fs::create_dir_all(&media_dir).map_err(|error| error.to_string())?;
    let client = reqwest::Client::new();
    let mut paths = Vec::new();
    for url in &urls {
        let response = client
            .get(url.as_str())
            .header(reqwest::header::USER_AGENT, "Zyquor/1.0")
            .send()
            .await
            .map_err(|error| format!("Media download failed: {error} for {url}"))?;
        let status = response.status().as_u16();
        if !response.status().is_success() {
            return Err(format!("Media download failed: {status} {url}"));
        }
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        if let Some(ref ct) = content_type {
            if !ct.to_ascii_lowercase().starts_with("image/") {
                return Err(format!("Media URL is not an image: {url}"));
            }
        }
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
            return Err(format!("Media size is invalid: {url}"));
        }
        // TS uses SHA-256 hex (first 16); reuse the storage SHA-256 helper.
        let hex = zyquor_storage::hash_post_text(url);
        let prefix: String = hex.chars().take(16).collect();
        let path = media_dir.join(format!(
            "{}{}",
            prefix,
            extension_for_media(url, content_type.as_deref())
        ));
        std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
        paths.push(path.to_string_lossy().to_string());
    }
    Ok(paths)
}

async fn media_paths_for_draft(draft: &zyquor_storage::Draft) -> Result<Vec<String>, String> {
    download_media_urls(media_urls_from_draft_metadata(&draft.metadata)).await
}

// ---------------------------------------------------------------------------
// Helpers: lib/source-packet
// ---------------------------------------------------------------------------

async fn source_packet_id_for_draft(
    repository: &Repository,
    draft_id: &str,
) -> Result<Option<String>, ApiError> {
    let draft = repository.get_draft(draft_id).await?;
    let Some(draft) = draft else {
        return Ok(None);
    };
    if let Some(value) = draft
        .draft
        .metadata
        .get("sourcePacketId")
        .and_then(Value::as_str)
    {
        return Ok(Some(value.to_string()));
    }
    for candidate in &draft.candidates {
        if let Some(value) = candidate
            .score
            .get("sourcePacketId")
            .and_then(Value::as_str)
        {
            return Ok(Some(value.to_string()));
        }
    }
    Ok(None)
}

async fn posted_source_packet_count_for_account(
    repository: &Repository,
    account_id: &str,
    draft_id: &str,
) -> Result<i64, ApiError> {
    let source_packet_id = source_packet_id_for_draft(repository, draft_id).await?;
    let Some(source_packet_id) = source_packet_id else {
        return Ok(0);
    };
    Ok(repository
        .count_post_history_by_source_packet(account_id, &source_packet_id)
        .await?)
}

async fn has_posted_text_for_account(
    repository: &Repository,
    account_id: &str,
    text: &str,
) -> Result<bool, ApiError> {
    let hash = zyquor_storage::hash_post_text(text);
    let normalized = zyquor_storage::normalize_post_text(text);
    Ok(repository
        .has_post_history_text_hash(account_id, &hash, &normalized)
        .await?)
}

async fn has_running_job_for_account(
    repository: &Repository,
    account_id: &str,
    current_job_id: &str,
) -> Result<bool, ApiError> {
    let jobs = repository.list_jobs(None, None, None).await?;
    Ok(jobs.into_iter().any(|job| {
        job.account_id == account_id
            && job.id != current_job_id
            && (job.status == PostJobStatus::Queued || job.status == PostJobStatus::Running)
    }))
}

// ---------------------------------------------------------------------------
// Helpers: lib/post-history-snapshot
// ---------------------------------------------------------------------------

async fn post_history_snapshot(
    repository: &Repository,
    draft_id: &str,
) -> Result<serde_json::Map<String, Value>, ApiError> {
    let draft = repository.get_draft(draft_id).await?;
    let source_packet_id = if draft.is_some() {
        source_packet_id_for_draft(repository, draft_id).await?
    } else {
        None
    };
    let packet = match &source_packet_id {
        Some(id) => repository.get_source_packet(id).await?,
        None => None,
    };
    let metadata = draft
        .as_ref()
        .map(|draft| draft.draft.metadata.clone())
        .unwrap_or_default();

    let mut inner = Map::new();
    inner.insert("draftMetadata".to_string(), Value::Object(metadata.clone()));
    if let Some(ref packet) = packet {
        inner.insert(
            "sourceFacts".to_string(),
            Value::Array(
                packet
                    .facts
                    .iter()
                    .map(|fact| Value::String(fact.clone()))
                    .collect(),
            ),
        );
        inner.insert(
            "sourceSummary".to_string(),
            Value::String(packet.summary.clone()),
        );
    }

    let mut out = Map::new();
    out.insert("metadata".to_string(), Value::Object(inner));
    out.insert(
        "sourcePacketId".to_string(),
        source_packet_id.map(Value::String).unwrap_or(Value::Null),
    );

    let source_title = packet
        .as_ref()
        .map(|packet| packet.title.clone())
        .or_else(|| {
            metadata
                .get("sourceTitle")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    out.insert(
        "sourceTitle".to_string(),
        source_title.map(Value::String).unwrap_or(Value::Null),
    );

    let source_type = packet
        .as_ref()
        .map(|packet| packet.source_type.clone())
        .or_else(|| {
            metadata
                .get("sourceType")
                .and_then(Value::as_str)
                .and_then(|value| {
                    if zyquor_core::SOURCE_TYPES
                        .iter()
                        .any(|candidate| candidate.as_str() == value)
                    {
                        Some(value.to_string())
                    } else {
                        None
                    }
                })
        });
    out.insert(
        "sourceType".to_string(),
        source_type.map(Value::String).unwrap_or(Value::Null),
    );

    let source_url = packet
        .as_ref()
        .and_then(|packet| packet.url.clone())
        .or_else(|| {
            metadata
                .get("sourceUrl")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    out.insert(
        "sourceUrl".to_string(),
        source_url.map(Value::String).unwrap_or(Value::Null),
    );

    let tweet_type = packet
        .as_ref()
        .map(|packet| packet.tweet_type.clone())
        .or_else(|| {
            metadata
                .get("tweetType")
                .and_then(Value::as_str)
                .and_then(|value| {
                    if zyquor_core::TWEET_TYPES
                        .iter()
                        .any(|candidate| candidate.as_str() == value)
                    {
                        Some(value.to_string())
                    } else {
                        None
                    }
                })
        });
    out.insert(
        "tweetType".to_string(),
        tweet_type.map(Value::String).unwrap_or(Value::Null),
    );
    Ok(out)
}

// ---------------------------------------------------------------------------
// Helpers: lib/stale-jobs
// ---------------------------------------------------------------------------

const DEFAULT_STALE_RUNNING_JOB_MS: i64 = 5 * 60 * 1000;

fn stale_running_job_ms() -> i64 {
    std::env::var("ZYQUOR_STALE_RUNNING_JOB_MS")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| raw.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value > 0.0)
        .map(|value| value as i64)
        .unwrap_or(DEFAULT_STALE_RUNNING_JOB_MS)
}

async fn recover_stale_running_jobs(
    repository: &Repository,
    account_id: Option<&str>,
    current_job_id: Option<&str>,
) -> Result<Vec<zyquor_storage::PostJob>, ApiError> {
    let jobs = repository
        .list_jobs(None, Some(vec![PostJobStatus::Running]), None)
        .await?;
    let now_ms = chrono::Utc::now().timestamp_millis();
    let threshold = stale_running_job_ms();
    let mut recovered = Vec::new();
    for job in jobs {
        if let Some(expected) = account_id {
            if job.account_id != expected {
                continue;
            }
        }
        if let Some(skip) = current_job_id {
            if job.id == skip {
                continue;
            }
        }
        if job.status != PostJobStatus::Running {
            continue;
        }
        let updated_ms = chrono::DateTime::parse_from_rfc3339(&job.updated_at)
            .map(|dt| dt.timestamp_millis())
            .unwrap_or(0);
        if now_ms - updated_ms <= threshold {
            continue;
        }
        let recovered_job = repository
            .update_job_status(&job.id, PostJobStatus::Failed)
            .await?;
        let message = if job.mode == PostingMode::Autopost {
            "Recovered stale running autopost job after interruption. Verify X manually before retrying or deleting."
        } else {
            "Recovered stale running browser job after interruption."
        };
        repository
            .create_attempt(zyquor_storage::NewAttempt {
                job_id: job.id.clone(),
                status: AttemptStatus::Failed,
                error_code: Some("stale_running_job".to_string()),
                error_message: Some(message.to_string()),
                screenshot_path: None,
                trace_path: None,
            })
            .await?;
        recovered.push(recovered_job);
    }
    Ok(recovered)
}

// ---------------------------------------------------------------------------
// Helpers: claim with explicit statuses (proxy only allows approved+failed)
// ---------------------------------------------------------------------------

async fn claim_job_for_browser_run_with_statuses(
    state: &AppState,
    id: &str,
    statuses: Vec<PostJobStatus>,
) -> Result<Option<zyquor_storage::PostJob>, ApiError> {
    let handle = state.repository.clone();
    let id = id.to_string();
    tokio::task::spawn_blocking(move || {
        let guard = match handle.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.claim_job_for_browser_run(&id, &statuses)
    })
    .await
    .map_err(|error| ApiError::Internal(format!("claim task failed: {error}")))?
    .map_err(ApiError::from)
}

// ---------------------------------------------------------------------------
// Helpers: browser session + artifacts
// ---------------------------------------------------------------------------

async fn check_x_login_session(cdp_url: &str) -> Result<zyquor_browser::CheckXLoginResult, String> {
    let session = zyquor_browser::Session::connect(cdp_url).await?;
    zyquor_browser::check_x_login(&session, "https://x.com/home").await
}

fn prepare_artifacts(
    error: &zyquor_browser::BrowserPrepareError,
) -> (Option<String>, Option<String>) {
    (
        error
            .screenshot_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        error
            .trace_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
    )
}

fn is_scheduled_for_future(job: &zyquor_storage::PostJob) -> bool {
    let Some(scheduled_for) = job.scheduled_for.as_deref() else {
        return false;
    };
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(scheduled_for) else {
        return false;
    };
    parsed.timestamp_millis() > chrono::Utc::now().timestamp_millis()
}

fn is_valid_datetime_offset(value: &str) -> bool {
    // zod datetime({ offset: true }) requires an offset designator.
    // Accept RFC3339 with Z or ±HH:MM.
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn shuffle<T>(items: &mut [T]) {
    // Fisher-Yates with a simple LCG seeded from wall-clock nanos.
    let seed = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64;
    let mut state = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
    let mut next = move || {
        state = state
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        state ^ (state >> 29)
    };
    if items.len() <= 1 {
        return;
    }
    for index in (1..items.len()).rev() {
        let swap_index = (next() % (index as u64 + 1)) as usize;
        items.swap(index, swap_index);
    }
}

// ---------------------------------------------------------------------------
// Post pipeline (lib/post-browser-job) + retry (lib/retry-job)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Default)]
struct PostBrowserJobOptions {
    bypass_schedule: bool,
    bypass_spacing: bool,
}

async fn post_browser_job(
    state: &AppState,
    job_id: &str,
    options: PostBrowserJobOptions,
) -> Result<Value, ApiError> {
    if job_id.is_empty() {
        return Err(ApiError::invalid("jobId is required"));
    }
    if !browser_enable_post(state) {
        return Err(ApiError::http(403, "Browser post action is disabled"));
    }
    let repository = state.repository();
    let job = repository
        .get_job(job_id)
        .await?
        .ok_or_else(|| ApiError::http(404, "Job not found"))?;
    if job.status != PostJobStatus::Approved && job.status != PostJobStatus::Prepared {
        return Err(ApiError::http(
            409,
            format!(
                "Job must be approved or prepared before posting: {}",
                job.status
            ),
        ));
    }
    let account = repository.get_account(&job.account_id).await?;
    let draft_with_candidates = repository.get_draft(&job.draft_id).await?;
    let provider_name = state.generation_provider_name();
    let selected_candidate = draft_with_candidates
        .as_ref()
        .and_then(|draft| draft.candidates.iter().find(|candidate| candidate.selected));
    let preserve_case = selected_candidate
        .and_then(|candidate| candidate.score.get("provider").and_then(Value::as_str))
        .map(|provider| provider == provider_name)
        .unwrap_or(false);
    let posted_text = draft_with_candidates
        .as_ref()
        .and_then(|draft| draft.draft.edited_text.clone())
        .map(|text| trace_post_process_tweet_text("post-job", &text, preserve_case));
    let Some(account) = account else {
        return Err(ApiError::http(
            409,
            "Job is missing account or approved text",
        ));
    };
    let Some(posted_text) = posted_text else {
        return Err(ApiError::http(
            409,
            "Job is missing account or approved text",
        ));
    };
    let Some(draft_for_post) = draft_with_candidates
        .as_ref()
        .map(|draft| draft.draft.clone())
    else {
        return Err(ApiError::http(
            409,
            "Job is missing account or approved text",
        ));
    };

    if is_scheduled_for_future(&job) && !options.bypass_schedule {
        return Err(ApiError::http(
            409,
            format!(
                "Job is scheduled for {}",
                job.scheduled_for.as_deref().unwrap_or("")
            ),
        ));
    }
    if !zyquor_accounts::is_account_runnable(&account) {
        return Err(ApiError::http(
            409,
            "Account is not enabled for browser jobs",
        ));
    }

    let browser = browser_options(state);
    let base_cdp = browser
        .cdp_url
        .as_deref()
        .unwrap_or("http://127.0.0.1:9222");
    let per_profile_url = per_profile_cdp_url(Some(base_cdp), &account.profile_dir);
    let profile_dir = resolve_profile_dir(&account.profile_dir);
    mark_browser_loaded(state);
    let expected_handle = account.handle.trim_start_matches('@').to_lowercase();
    let session_result = check_x_login_session(&per_profile_url).await;
    let session = match session_result {
        Ok(result) => result,
        Err(message) => {
            return Err(ApiError::http(
                409,
                format!(
                    "Cannot verify the X login before posting for @{}: {message}",
                    account.handle
                ),
            ));
        }
    };
    if !session.logged_in {
        return Err(ApiError::http(
            409,
            format!(
                "The posting Chrome is not logged in to X as @{}. Log in and activate the account first.",
                account.handle
            ),
        ));
    }
    let Some(session_handle) = session.handle.clone() else {
        return Err(ApiError::http(
            409,
            format!(
                "Cannot read which X account is logged in for @{}; refusing to act rather than guess.",
                account.handle
            ),
        ));
    };
    if session_handle != expected_handle {
        return Err(ApiError::http(
            409,
            format!(
                "Identity mismatch: the posting Chrome is logged in as @{session_handle}, but this job belongs to @{expected_handle}. Refusing to post under the wrong account."
            ),
        ));
    }

    if is_daily_limit_reached(&repository, &account.id, account.daily_post_limit).await? {
        return Err(ApiError::http(
            409,
            "Daily post limit reached for this account",
        ));
    }

    let latest_account_post = repository
        .get_latest_post_history_for_account(&account.id)
        .await?;
    let gap_min_minutes = std::env::var("ZYQUOR_POST_GAP_MIN_MINUTES")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .and_then(|raw| raw.parse::<f64>().ok());
    let gate = zyquor_core::spacing::evaluate_post_gate(&zyquor_core::spacing::PostGateInput {
        gap_min_minutes,
        last_posted_at: latest_account_post
            .as_ref()
            .map(|history| history.posted_at.clone()),
        now: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        trace_id: Some(format!(
            "gate-{}",
            job.id.chars().take(8).collect::<String>()
        )),
    })
    .map_err(|error| ApiError::Internal(error.to_string()))?;
    if !gate.allowed && !options.bypass_spacing {
        return Err(ApiError::http(
            429,
            format!(
                "Too soon since the last post. Next post allowed at {} ({} min to wait)",
                gate.next_eligible_at.as_deref().unwrap_or(""),
                gate.wait_minutes
            ),
        ));
    }

    if has_posted_text_for_account(&repository, &account.id, &posted_text).await? {
        let _ = repository
            .update_job_status(&job.id, PostJobStatus::Cancelled)
            .await;
        let _ = repository
            .create_attempt(zyquor_storage::NewAttempt {
                job_id: job.id.clone(),
                status: AttemptStatus::Failed,
                error_code: Some("duplicate_post_text".to_string()),
                error_message: Some("Duplicate post text for this account".to_string()),
                screenshot_path: None,
                trace_path: None,
            })
            .await;
        return Err(ApiError::http(409, "Duplicate post text for this account"));
    }
    let posted_source_count =
        posted_source_packet_count_for_account(&repository, &account.id, &job.draft_id).await?;
    if posted_source_count >= 2 {
        let _ = repository
            .update_job_status(&job.id, PostJobStatus::Cancelled)
            .await;
        let _ = repository
            .create_attempt(zyquor_storage::NewAttempt {
                job_id: job.id.clone(),
                status: AttemptStatus::Failed,
                error_code: Some("source_packet_cap_reached".to_string()),
                error_message: Some(
                    "Source packet already reached 2 posts for this account".to_string(),
                ),
                screenshot_path: None,
                trace_path: None,
            })
            .await;
        return Err(ApiError::http(
            409,
            "Source packet already reached 2 posts for this account",
        ));
    }
    let source_packet_id = source_packet_id_for_draft(&repository, &job.draft_id).await?;
    let source_packet = match &source_packet_id {
        Some(id) => repository.get_source_packet(id).await?,
        None => None,
    };
    let history = repository.list_post_history().await?;
    let source_quality = source_packet.as_ref().map(|packet| {
        zyquor_automation::validate_source_post_quality(&posted_text, packet, &history)
    });
    let quality_text = source_quality
        .as_ref()
        .map(|quality| quality.text.clone())
        .unwrap_or_else(|| posted_text.clone());
    let generated_required = job.mode == PostingMode::Autopost
        && (draft_for_post.metadata.get("yolo").and_then(Value::as_bool) == Some(true)
            || draft_for_post.metadata.contains_key("generatedScore"));
    let generated_quality = if generated_required {
        Some(zyquor_automation::validate_generated_post_quality(
            &quality_text,
            state.automation_deps.quality_min,
        ))
    } else {
        None
    };
    let mut quality_reasons: Vec<String> = Vec::new();
    if let Some(ref quality) = source_quality {
        quality_reasons.extend(quality.reasons.clone());
    }
    if let Some(ref quality) = generated_quality {
        quality_reasons.extend(quality.reasons.clone());
    }
    if !quality_reasons.is_empty() {
        let mut seen: HashSet<String> = HashSet::new();
        let mut deduped: Vec<String> = Vec::new();
        for reason in &quality_reasons {
            if seen.insert(reason.clone()) {
                deduped.push(reason.clone());
            }
        }
        let message = format!("Post failed quality gate: {}", deduped.join(", "));
        let _ = repository
            .update_job_status(&job.id, PostJobStatus::Cancelled)
            .await;
        let _ = repository
            .create_attempt(zyquor_storage::NewAttempt {
                job_id: job.id.clone(),
                status: AttemptStatus::Failed,
                error_code: Some("post_quality_gate_failed".to_string()),
                error_message: Some(message.clone()),
                screenshot_path: None,
                trace_path: None,
            })
            .await;
        return Err(ApiError::http(409, message));
    }

    recover_stale_running_jobs(&repository, Some(&account.id), Some(&job.id)).await?;
    if has_running_job_for_account(&repository, &account.id, &job.id).await? {
        return Err(ApiError::http(
            409,
            "Another browser job is already running for this account",
        ));
    }
    if let Err(error) = zyquor_accounts::assert_dedicated_profile_dir(&account.profile_dir) {
        return Err(ApiError::Internal(error.to_string()));
    }

    let claimed = claim_job_for_browser_run_with_statuses(
        state,
        &job.id,
        vec![PostJobStatus::Approved, PostJobStatus::Prepared],
    )
    .await?;
    if claimed.is_none() {
        return Err(ApiError::http(
            409,
            "Job is already running, posted, or no longer claimable",
        ));
    }
    repository
        .update_job_status(&job.id, PostJobStatus::Running)
        .await?;
    repository
        .create_attempt(zyquor_storage::NewAttempt {
            job_id: job.id.clone(),
            status: AttemptStatus::Started,
            error_code: None,
            error_message: None,
            screenshot_path: None,
            trace_path: None,
        })
        .await?;

    let media_paths = match media_paths_for_draft(&draft_for_post).await {
        Ok(paths) => paths,
        Err(message) => {
            let _ = repository
                .update_job_status(&job.id, PostJobStatus::Failed)
                .await;
            let _ = repository
                .create_attempt(zyquor_storage::NewAttempt {
                    job_id: job.id.clone(),
                    status: AttemptStatus::Failed,
                    error_code: Some("browser_post_failed".to_string()),
                    error_message: Some(message.clone()),
                    screenshot_path: None,
                    trace_path: None,
                })
                .await;
            return Err(ApiError::http(500, message));
        }
    };

    let browser = browser_options(state);
    let prepare_input = zyquor_browser::PreparePostInput {
        profile_dir: profile_dir.clone(),
        text: quality_text.clone(),
        action_delay_ms: browser.action_delay_ms,
        artifacts_dir: None,
        cdp_url: per_profile_url.clone(),
        media_paths: if media_paths.is_empty() {
            None
        } else {
            Some(media_paths)
        },
        submit: true,
        typing_delay_ms: browser.typing_delay_ms,
        x_url: None,
        reply_to_url: job.reply_to.as_ref().map(|reply| reply.url.clone()),
    };
    let post_result: std::result::Result<
        zyquor_browser::PreparePostResult,
        zyquor_browser::BrowserPrepareError,
    > = async {
        let session = zyquor_browser::Session::connect(&per_profile_url)
            .await
            .map_err(|message| zyquor_browser::BrowserPrepareError {
                message,
                screenshot_path: None,
                trace_path: None,
            })?;
        zyquor_browser::prepare_post(&session, &prepare_input).await
    }
    .await;

    match post_result {
        Ok(result) => {
            repository
                .create_attempt(zyquor_storage::NewAttempt {
                    job_id: job.id.clone(),
                    status: AttemptStatus::PostClicked,
                    error_code: None,
                    error_message: None,
                    screenshot_path: None,
                    trace_path: None,
                })
                .await?;
            let posted = repository
                .update_job_status(&job.id, PostJobStatus::Posted)
                .await?;
            let snapshot = post_history_snapshot(&repository, &job.draft_id).await?;
            let metadata = snapshot
                .get("metadata")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let history = repository
                .create_post_history(zyquor_storage::NewPostHistory {
                    account_id: job.account_id.clone(),
                    draft_id: job.draft_id.clone(),
                    posted_text: quality_text.clone(),
                    post_url: result.post_url.clone(),
                    source_packet_id: snapshot
                        .get("sourcePacketId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    source_type: snapshot
                        .get("sourceType")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    source_title: snapshot
                        .get("sourceTitle")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    source_url: snapshot
                        .get("sourceUrl")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    tweet_type: snapshot
                        .get("tweetType")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    metadata,
                })
                .await?;
            // removePostedDraftSourcePacket
            let source_packet_id = source_packet_id_for_draft(&repository, &job.draft_id).await?;
            if let Some(packet_id) = source_packet_id {
                if let Ok(Some(_packet)) = repository.get_source_packet(&packet_id).await {
                    let _ = repository.delete_source_packet(&packet_id).await;
                }
            }
            repository
                .create_attempt(zyquor_storage::NewAttempt {
                    job_id: job.id.clone(),
                    status: AttemptStatus::Verified,
                    error_code: None,
                    error_message: None,
                    screenshot_path: None,
                    trace_path: None,
                })
                .await?;
            if browser_close_after_post(state) {
                zyquor_browser::close_browser_cdp(&per_profile_url).await;
            }
            Ok(json!({"job": posted, "history": history}))
        }
        Err(error) => {
            if browser_close_after_post(state) {
                zyquor_browser::close_browser_cdp(&per_profile_url).await;
            }
            let message = error.message.clone();
            let (screenshot_path, trace_path) = prepare_artifacts(&error);
            let _ = repository
                .update_job_status(&job.id, PostJobStatus::Failed)
                .await;
            let _ = repository
                .create_attempt(zyquor_storage::NewAttempt {
                    job_id: job.id.clone(),
                    status: AttemptStatus::Failed,
                    error_code: Some("browser_post_failed".to_string()),
                    error_message: Some(message.clone()),
                    screenshot_path,
                    trace_path,
                })
                .await;
            Err(ApiError::http(500, message))
        }
    }
}

const RETRY_VERIFICATION_REPLIES: usize = 30;

fn compact_text(text: &str) -> String {
    let mut out = String::new();
    let mut prev_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            out.push(ch);
            prev_space = false;
        }
    }
    out.trim().to_lowercase()
}

async fn retry_browser_job(state: &AppState, job_id: &str) -> Result<Value, ApiError> {
    let repository = state.repository();
    let job = repository
        .get_job(job_id)
        .await?
        .ok_or_else(|| ApiError::http(404, "Job not found"))?;
    if job.status == PostJobStatus::Posted {
        return Err(ApiError::http(
            409,
            "Job is already posted; nothing to retry",
        ));
    }
    if job.status != PostJobStatus::Failed {
        return Err(ApiError::http(
            409,
            format!(
                "Retry applies to failed reply jobs only; this job is {}",
                job.status
            ),
        ));
    }
    let Some(reply_target) = job.reply_to.clone() else {
        return Err(ApiError::http(
            409,
            "Retry verification supports reply jobs only",
        ));
    };
    let reply_url = reply_target.url.clone();

    let draft_with_candidates = repository.get_draft(&job.draft_id).await?;
    let Some(draft_with_candidates) = draft_with_candidates else {
        return Err(ApiError::http(
            409,
            "Job's draft is missing approved text; regenerate the draft instead",
        ));
    };
    if draft_with_candidates.draft.status != zyquor_core::types::DraftStatus::Approved
        || draft_with_candidates.draft.edited_text.is_none()
    {
        return Err(ApiError::http(
            409,
            "Job's draft is missing approved text; regenerate the draft instead",
        ));
    }
    let approved_text = draft_with_candidates
        .draft
        .edited_text
        .clone()
        .unwrap_or_default();

    let account = repository.get_account(&job.account_id).await?;
    let Some(account) = account else {
        return Err(ApiError::http(409, "Job is missing its account"));
    };
    if !zyquor_accounts::is_account_runnable(&account) {
        return Err(ApiError::http(
            409,
            "Account is not enabled for browser jobs",
        ));
    }
    if !browser_enable_post(state) {
        return Err(ApiError::http(403, "Browser retry action is disabled"));
    }

    let browser = browser_options(state);
    let base_cdp = browser
        .cdp_url
        .as_deref()
        .unwrap_or("http://127.0.0.1:9222");
    let per_profile = per_profile_cdp_url(Some(base_cdp), &account.profile_dir);
    let profile_dir = resolve_profile_dir(&account.profile_dir);
    let expected_handle = account.handle.trim_start_matches('@').to_lowercase();
    mark_browser_loaded(state);
    let session_result = check_x_login_session(&per_profile).await;
    let session = match session_result {
        Ok(result) => result,
        Err(message) => {
            return Err(ApiError::http(
                409,
                format!(
                    "Cannot verify the X login before retrying for @{}: {message}",
                    account.handle
                ),
            ));
        }
    };
    if !session.logged_in {
        return Err(ApiError::http(
            409,
            format!(
                "The posting Chrome is not logged in to X as @{}. Log in and activate the account first.",
                account.handle
            ),
        ));
    }
    if session.handle.as_deref() != Some(expected_handle.as_str()) {
        return Err(ApiError::http(
            409,
            format!(
                "Identity mismatch while retrying for @{}: the posting Chrome is logged in as @{}. Refusing to act.",
                account.handle,
                session.handle.as_deref().unwrap_or("unknown")
            ),
        ));
    }
    if let Err(error) = zyquor_accounts::assert_dedicated_profile_dir(&account.profile_dir) {
        return Err(ApiError::Internal(error.to_string()));
    }

    // Verify thread / timeline via zyquor_browser feed flows.
    let browser_for_fetch = browser_options(state);
    let fetch_thread = async {
        let session = zyquor_browser::Session::connect(&per_profile)
            .await
            .map_err(|error| error.to_string())?;
        let action_delay = browser_for_fetch.action_delay_ms;
        zyquor_browser::fetch_tweet(
            &session,
            &reply_url,
            action_delay,
            Some(RETRY_VERIFICATION_REPLIES),
        )
        .await
    }
    .await;
    let (thread_result, thread_error) = match fetch_thread {
        Ok(result) => (Some(result), None),
        Err(message) => (None, Some(message)),
    };

    let reply_match =
        |candidates: &[zyquor_browser::XFeedTweet]| -> Option<zyquor_browser::XFeedTweet> {
            candidates
                .iter()
                .find(|candidate| {
                    candidate
                        .author_handle
                        .trim_start_matches('@')
                        .to_lowercase()
                        == expected_handle
                        && compact_text(&candidate.text) == compact_text(&approved_text)
                })
                .cloned()
        };

    let mut matched: Option<zyquor_browser::XFeedTweet> = None;
    if let Some(ref thread) = thread_result {
        if let Some(ref replies) = thread.replies {
            matched = reply_match(replies);
        }
    }
    let mut timeline_error: Option<String> = None;
    if matched.is_none() && thread_error.is_some() {
        let timeline_result = async {
            let session = zyquor_browser::Session::connect(&per_profile)
                .await
                .map_err(|error| error.to_string())?;
            let input = zyquor_browser::FeedFetchInput {
                profile_dir: profile_dir.clone(),
                cdp_url: per_profile.clone(),
                max_tweets: Some(RETRY_VERIFICATION_REPLIES),
                min_tweets: None,
                scrolls: None,
                action_delay_ms: browser_for_fetch.action_delay_ms,
                artifacts_dir: None,
                x_home_url: None,
                mentions_url: None,
            };
            let handle = format!("{expected_handle}/with_replies");
            zyquor_browser::fetch_account_timeline(&session, &input, &handle).await
        }
        .await;
        match timeline_result {
            Ok(timeline) => {
                matched = reply_match(&timeline.tweets);
            }
            Err(message) => {
                timeline_error = Some(message);
            }
        }
        if matched.is_none() && timeline_error.is_some() {
            return Err(ApiError::http(
                409,
                format!(
                    "Cannot verify the target thread or the account timeline before retrying (thread said: {}; timeline said: {}). Resolve the browser and retry again; nothing was reposted.",
                    thread_error.as_deref().unwrap_or("unknown error"),
                    timeline_error.as_deref().unwrap_or("unknown error")
                ),
            ));
        }
    }

    if let Some(matched) = matched {
        let posted = repository
            .update_job_status(&job.id, PostJobStatus::Posted)
            .await?;
        repository
            .create_attempt(zyquor_storage::NewAttempt {
                job_id: job.id.clone(),
                status: AttemptStatus::Verified,
                error_code: None,
                error_message: None,
                screenshot_path: None,
                trace_path: None,
            })
            .await?;
        let mut metadata = Map::new();
        metadata.insert("sourceUrl".to_string(), Value::String(reply_url.clone()));
        repository
            .create_post_history(zyquor_storage::NewPostHistory {
                account_id: account.id.clone(),
                draft_id: job.draft_id.clone(),
                posted_text: approved_text.clone(),
                post_url: Some(matched.url.clone()),
                source_packet_id: None,
                source_type: None,
                source_title: None,
                source_url: Some(reply_url.clone()),
                tweet_type: Some("reply".to_string()),
                metadata,
            })
            .await?;
        return Ok(json!({"verified": true, "job": posted, "replyUrl": matched.url}));
    }

    repository
        .update_job_status(&job.id, PostJobStatus::Approved)
        .await?;
    repository
        .create_attempt(zyquor_storage::NewAttempt {
            job_id: job.id.clone(),
            status: AttemptStatus::RetryScheduled,
            error_code: None,
            error_message: None,
            screenshot_path: None,
            trace_path: None,
        })
        .await?;
    let result = post_browser_job(
        state,
        job_id,
        PostBrowserJobOptions {
            bypass_schedule: false,
            bypass_spacing: false,
        },
    )
    .await?;
    let mut merged = result.as_object().cloned().unwrap_or_default();
    merged.insert("verified".to_string(), Value::Bool(false));
    Ok(Value::Object(merged))
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/jobs", get(list_jobs).delete(delete_jobs))
        .route("/jobs/cleanup", delete(delete_jobs_cleanup))
        .route("/jobs/post-next", post(post_next))
        .route("/jobs/post-ready", post(post_ready))
        .route("/jobs/recover-stale", post(recover_stale))
        .route("/jobs/{id}/attempts", get(list_attempts))
        .route("/jobs/{id}/prepare", post(prepare_job))
        .route("/jobs/{id}/post", post(post_job))
        .route("/jobs/{id}/retry", post(retry_job))
        .route("/jobs/{id}", delete(delete_job).patch(patch_job))
}

#[derive(Deserialize)]
struct JobsQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    statuses: Option<String>,
    limit: Option<String>,
}

fn parse_job_statuses(raw: Option<&str>) -> Option<Vec<PostJobStatus>> {
    let raw = raw?;
    if raw.is_empty() {
        return None;
    }
    let mut seen: HashSet<String> = HashSet::new();
    let mut out: Vec<PostJobStatus> = Vec::new();
    for part in raw.split(',') {
        let status = part.trim();
        if status.is_empty() {
            continue;
        }
        if let Ok(parsed) = status.parse::<PostJobStatus>() {
            // Ensure the value is one of POST_JOB_STATUSES (parse already ensures).
            if !seen.insert(status.to_string()) {
                continue;
            }
            out.push(parsed);
        }
    }
    if out.is_empty() { None } else { Some(out) }
}

fn parse_list_limit(raw: Option<&str>) -> Option<i64> {
    let raw = raw?;
    let parsed: f64 = raw.parse().ok()?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return None;
    }
    Some((parsed.floor() as i64).min(1000))
}

async fn list_jobs(
    State(state): State<AppState>,
    Query(query): Query<JobsQuery>,
) -> Result<Json<Value>, ApiError> {
    let statuses = parse_job_statuses(query.statuses.as_deref());
    let limit = parse_list_limit(query.limit.as_deref());
    let jobs = state
        .repository()
        .list_jobs(query.account_id.as_deref(), statuses, limit)
        .await?;
    Ok(Json(json!({"jobs": jobs})))
}

async fn list_attempts(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let attempts = repository.list_attempts(&id).await?;
    let _ = repository;
    Ok(Json(json!({"attempts": attempts})))
}

async fn recover_stale(
    State(state): State<AppState>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let account_id = body
        .as_ref()
        .and_then(|Json(value)| value.get("accountId"))
        .and_then(Value::as_str);
    let repository = state.repository();
    let recovered = recover_stale_running_jobs(&repository, account_id, None).await?;
    Ok(Json(
        json!({"recovered": recovered, "recoveredCount": recovered.len()}),
    ))
}

fn next_autopost_job(
    jobs: Vec<zyquor_storage::PostJob>,
    account_id: &str,
) -> Option<zyquor_storage::PostJob> {
    let mut filtered: Vec<_> = jobs
        .into_iter()
        .filter(|job| {
            job.account_id == account_id
                && job.mode == PostingMode::Autopost
                && (job.status == PostJobStatus::Approved || job.status == PostJobStatus::Prepared)
        })
        .collect();
    filtered.sort_by(|left, right| {
        let left_scheduled = left
            .scheduled_for
            .as_deref()
            .map(|value| {
                chrono::DateTime::parse_from_rfc3339(value)
                    .map(|dt| dt.timestamp_millis())
                    .unwrap_or(0)
            })
            .unwrap_or(i64::MIN);
        let right_scheduled = right
            .scheduled_for
            .as_deref()
            .map(|value| {
                chrono::DateTime::parse_from_rfc3339(value)
                    .map(|dt| dt.timestamp_millis())
                    .unwrap_or(0)
            })
            .unwrap_or(i64::MIN);
        left_scheduled.cmp(&right_scheduled).then_with(|| {
            chrono::DateTime::parse_from_rfc3339(&left.created_at)
                .map(|dt| dt.timestamp_millis())
                .unwrap_or(0)
                .cmp(
                    &chrono::DateTime::parse_from_rfc3339(&right.created_at)
                        .map(|dt| dt.timestamp_millis())
                        .unwrap_or(0),
                )
        })
    });
    filtered.into_iter().next()
}

async fn post_next(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let account_id = body.get("accountId").and_then(Value::as_str);
    let Some(account_id) = account_id else {
        return Err(ApiError::http(400, "accountId is required"));
    };
    let repository = state.repository();
    let jobs = repository
        .list_jobs(
            None,
            Some(vec![PostJobStatus::Approved, PostJobStatus::Prepared]),
            None,
        )
        .await?;
    let Some(job) = next_autopost_job(jobs, account_id) else {
        return Err(ApiError::http(404, "No approved autopost jobs in queue"));
    };
    match post_browser_job(
        &state,
        &job.id,
        PostBrowserJobOptions {
            bypass_schedule: true,
            bypass_spacing: true,
        },
    )
    .await
    {
        Ok(value) => Ok(Json(value)),
        Err(error) => Err(error),
    }
}

async fn post_ready(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let account_id = body
        .get("accountId")
        .and_then(Value::as_str)
        .map(str::to_string);
    let Some(account_id) = account_id else {
        return Err(ApiError::http(400, "accountId is required"));
    };
    let bypass_spacing = body
        .get("bypassSpacing")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let repository = state.repository();
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut ready_jobs = repository
        .list_jobs(
            Some(&account_id),
            Some(vec![PostJobStatus::Approved, PostJobStatus::Prepared]),
            None,
        )
        .await?;
    ready_jobs.retain(|job| {
        if job.status != PostJobStatus::Approved && job.status != PostJobStatus::Prepared {
            return false;
        }
        if job.scheduled_for.is_none() {
            return true;
        }
        let Some(scheduled_for) = job.scheduled_for.as_deref() else {
            return true;
        };
        chrono::DateTime::parse_from_rfc3339(scheduled_for)
            .map(|dt| dt.timestamp_millis() <= now_ms)
            .unwrap_or(false)
    });
    shuffle(&mut ready_jobs);
    let mut results = Vec::new();
    for job in &ready_jobs {
        match post_browser_job(
            &state,
            &job.id,
            PostBrowserJobOptions {
                bypass_schedule: false,
                bypass_spacing,
            },
        )
        .await
        {
            Ok(value) => {
                results.push(json!({
                    "jobId": job.id,
                    "status": "posted",
                    "job": value.get("job").cloned().unwrap_or(Value::Null),
                    "history": value.get("history").cloned().unwrap_or(Value::Null),
                    "error": Value::Null,
                }));
            }
            Err(error) => {
                let message = api_error_message(&error);
                let current = repository.get_job(&job.id).await.ok().flatten();
                results.push(json!({
                    "jobId": job.id,
                    "status": "failed",
                    "job": current,
                    "history": Value::Null,
                    "error": message,
                }));
            }
        }
    }
    let posted = results
        .iter()
        .filter(|result| result.get("status").and_then(Value::as_str) == Some("posted"))
        .count();
    let failed = results
        .iter()
        .filter(|result| result.get("status").and_then(Value::as_str) == Some("failed"))
        .count();
    Ok(Json(
        json!({"posted": posted, "failed": failed, "total": results.len(), "results": results}),
    ))
}

async fn delete_jobs(
    State(state): State<AppState>,
    Query(query): Query<JobsQuery>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let jobs = repository
        .list_jobs(query.account_id.as_deref(), None, None)
        .await?;
    let mut deleted = Vec::new();
    for job in jobs {
        if job.status != PostJobStatus::Running {
            let _ = repository.delete_job(&job.id).await?;
            deleted.push(job.id);
        }
    }
    Ok(Json(json!({"deletedCount": deleted.len(), "ids": deleted})))
}

async fn delete_jobs_cleanup(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let jobs = repository
        .list_jobs(
            None,
            Some(vec![PostJobStatus::Posted, PostJobStatus::Failed]),
            None,
        )
        .await?;
    let mut deleted = Vec::new();
    for job in jobs {
        let _ = repository.delete_job(&job.id).await?;
        deleted.push(job.id);
    }
    Ok(Json(json!({"deletedCount": deleted.len(), "ids": deleted})))
}

async fn delete_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let job = repository.get_job(&id).await?;
    let Some(job) = job else {
        return Err(ApiError::http(404, "Job not found"));
    };
    if job.status == PostJobStatus::Running {
        return Err(ApiError::http(409, "Cannot delete a running job"));
    }
    let deleted = repository.delete_job(&id).await?;
    Ok(Json(json!({"job": deleted})))
}

async fn patch_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("request body must be a JSON object"))?;
    // strict: only scheduledFor allowed.
    for key in object.keys() {
        if key != "scheduledFor" {
            return Err(ApiError::invalid(format!("Unrecognized key: {key}")));
        }
    }
    let scheduled_for: Option<String> = match object.get("scheduledFor") {
        Some(Value::Null) => None,
        Some(Value::String(value)) => {
            if !is_valid_datetime_offset(value) {
                return Err(ApiError::invalid(
                    "scheduledFor must be a datetime with offset",
                ));
            }
            Some(value.clone())
        }
        Some(_) => {
            return Err(ApiError::invalid(
                "scheduledFor must be a datetime string or null",
            ));
        }
        None => return Err(ApiError::invalid("scheduledFor is required")),
    };
    let repository = state.repository();
    let job = repository.get_job(&id).await?;
    let Some(job) = job else {
        return Err(ApiError::http(404, "Job not found"));
    };
    if matches!(
        job.status,
        PostJobStatus::Running
            | PostJobStatus::Posted
            | PostJobStatus::Failed
            | PostJobStatus::Cancelled
    ) {
        return Err(ApiError::http(
            409,
            format!("Cannot reschedule a job in status: {}", job.status),
        ));
    }
    let updated = repository.assign_job_schedule(&id, scheduled_for).await?;
    Ok(Json(json!({"job": updated})))
}

async fn prepare_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    if id.is_empty() {
        return Err(ApiError::invalid("jobId is required"));
    }
    let repository = state.repository();
    let job = repository.get_job(&id).await?;
    let Some(job) = job else {
        return Err(ApiError::http(404, "Job not found"));
    };
    let account = repository.get_account(&job.account_id).await?;
    let draft_with_candidates = repository.get_draft(&job.draft_id).await?;
    let provider_name = state.generation_provider_name();
    let selected_candidate = draft_with_candidates
        .as_ref()
        .and_then(|draft| draft.candidates.iter().find(|candidate| candidate.selected));
    let preserve_case = selected_candidate
        .and_then(|candidate| candidate.score.get("provider").and_then(Value::as_str))
        .map(|provider| provider == provider_name)
        .unwrap_or(false);
    let draft_text = draft_with_candidates
        .as_ref()
        .and_then(|draft| draft.draft.edited_text.clone())
        .map(|text| trace_post_process_tweet_text("prepare-job", &text, preserve_case));
    let source_packet_id = if draft_with_candidates.is_some() {
        source_packet_id_for_draft(&repository, &job.draft_id).await?
    } else {
        None
    };
    let source_packet = match &source_packet_id {
        Some(packet_id) => repository.get_source_packet(packet_id).await?,
        None => None,
    };
    let prepared_text = match (&draft_text, &source_packet) {
        (Some(text), Some(packet)) => {
            Some(zyquor_automation::with_required_source_url(text, packet))
        }
        (Some(text), None) => Some(text.clone()),
        _ => None,
    };
    let Some(account) = account else {
        return Err(ApiError::http(
            409,
            "Job is missing account or approved text",
        ));
    };
    let Some(prepared_text) = prepared_text else {
        return Err(ApiError::http(
            409,
            "Job is missing account or approved text",
        ));
    };
    let Some(draft_for_prepare) = draft_with_candidates
        .as_ref()
        .map(|draft| draft.draft.clone())
    else {
        return Err(ApiError::http(
            409,
            "Job is missing account or approved text",
        ));
    };
    if is_scheduled_for_future(&job) {
        return Err(ApiError::http(
            409,
            format!(
                "Job is scheduled for {}",
                job.scheduled_for.as_deref().unwrap_or("")
            ),
        ));
    }
    if !zyquor_accounts::is_account_runnable(&account) {
        return Err(ApiError::http(
            409,
            "Account is not enabled for browser jobs",
        ));
    }
    recover_stale_running_jobs(&repository, Some(&account.id), Some(&job.id)).await?;
    if has_running_job_for_account(&repository, &account.id, &job.id).await? {
        return Err(ApiError::http(
            409,
            "Another browser job is already running for this account",
        ));
    }
    if let Err(error) = zyquor_accounts::assert_dedicated_profile_dir(&account.profile_dir) {
        return Err(ApiError::Internal(error.to_string()));
    }
    let claimed = state
        .repository()
        .claim_job_for_browser_run(&job.id)
        .await?;
    if claimed.is_none() {
        return Err(ApiError::http(
            409,
            "Job is already running, posted, or no longer claimable",
        ));
    }
    repository
        .update_job_status(&job.id, PostJobStatus::Running)
        .await?;
    repository
        .create_attempt(zyquor_storage::NewAttempt {
            job_id: job.id.clone(),
            status: AttemptStatus::Started,
            error_code: None,
            error_message: None,
            screenshot_path: None,
            trace_path: None,
        })
        .await?;

    if !browser_enable_prepare(&state) {
        let prepared = repository
            .update_job_status(&job.id, PostJobStatus::Prepared)
            .await?;
        repository
            .create_attempt(zyquor_storage::NewAttempt {
                job_id: job.id.clone(),
                status: AttemptStatus::TextInserted,
                error_code: None,
                error_message: None,
                screenshot_path: None,
                trace_path: None,
            })
            .await?;
        return Ok(Json(json!({"job": prepared, "dryRun": true})));
    }

    let browser = browser_options(&state);
    let media_paths = match media_paths_for_draft(&draft_for_prepare).await {
        Ok(paths) => paths,
        Err(message) => {
            let _ = repository
                .update_job_status(&job.id, PostJobStatus::Failed)
                .await;
            let _ = repository
                .create_attempt(zyquor_storage::NewAttempt {
                    job_id: job.id.clone(),
                    status: AttemptStatus::Failed,
                    error_code: Some("browser_prepare_failed".to_string()),
                    error_message: Some(message.clone()),
                    screenshot_path: None,
                    trace_path: None,
                })
                .await;
            return Err(ApiError::http(500, message));
        }
    };
    let profile_dir = resolve_profile_dir(&account.profile_dir);
    let prepare_input = zyquor_browser::PreparePostInput {
        profile_dir: profile_dir.clone(),
        text: prepared_text.clone(),
        action_delay_ms: browser.action_delay_ms,
        artifacts_dir: None,
        cdp_url: browser.cdp_url.clone().unwrap_or_default(),
        media_paths: if media_paths.is_empty() {
            None
        } else {
            Some(media_paths)
        },
        submit: false,
        typing_delay_ms: browser.typing_delay_ms,
        x_url: None,
        reply_to_url: job.reply_to.as_ref().map(|reply| reply.url.clone()),
    };
    mark_browser_loaded(&state);
    let prepare_result = async {
        let session = zyquor_browser::Session::connect(&prepare_input.cdp_url).await;
        match session {
            Ok(session) => zyquor_browser::prepare_post(&session, &prepare_input).await,
            Err(message) => Err(zyquor_browser::BrowserPrepareError {
                message,
                screenshot_path: None,
                trace_path: None,
            }),
        }
    }
    .await;
    match prepare_result {
        Ok(_result) => {
            if browser_close_after_prepare(&state) {
                let close_url = browser.cdp_url.clone().unwrap_or_default();
                if !close_url.is_empty() {
                    zyquor_browser::close_browser_cdp(&close_url).await;
                }
            }
            let prepared = repository
                .update_job_status(&job.id, PostJobStatus::Prepared)
                .await?;
            repository
                .create_attempt(zyquor_storage::NewAttempt {
                    job_id: job.id.clone(),
                    status: AttemptStatus::TextInserted,
                    error_code: None,
                    error_message: None,
                    screenshot_path: None,
                    trace_path: None,
                })
                .await?;
            Ok(Json(json!({"job": prepared, "dryRun": false})))
        }
        Err(error) => {
            let message = error.message.clone();
            let (screenshot_path, trace_path) = prepare_artifacts(&error);
            let _ = repository
                .update_job_status(&job.id, PostJobStatus::Failed)
                .await;
            let _ = repository
                .create_attempt(zyquor_storage::NewAttempt {
                    job_id: job.id.clone(),
                    status: AttemptStatus::Failed,
                    error_code: Some("browser_prepare_failed".to_string()),
                    error_message: Some(message.clone()),
                    screenshot_path,
                    trace_path,
                })
                .await;
            Err(ApiError::http(500, message))
        }
    }
}

async fn post_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    match post_browser_job(&state, &id, PostBrowserJobOptions::default()).await {
        Ok(value) => Ok(Json(value)),
        Err(error) => Err(error),
    }
}

async fn retry_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    match retry_browser_job(&state, &id).await {
        Ok(value) => Ok(Json(value)),
        Err(error) => Err(error),
    }
}
