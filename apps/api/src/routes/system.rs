//! System routes, ported from `apps/api/src/routes/system.ts`.

use axum::{
    Json, Router,
    extract::{Query, State},
    routing::{get, post},
};
use serde_json::{Value, json};

use crate::errors::ApiError;
use crate::state::{AppState, DesktopControlPlane};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/system/status", get(status))
        .route("/system/posting", post(update_posting))
        .route("/system/ingest/cancel", post(cancel_ingest))
        .route("/system/logs", get(logs))
        .route("/system/worker/pause", post(pause_worker))
        .route("/system/chrome/close", post(close_chrome))
        .route("/system/stop-all", post(stop_all))
        .route("/system/quit", post(quit))
        .route("/system/restart", post(restart))
}

/// The desktop routes only exist when the Tauri shell injected its control
/// surface; the standalone API answers 404 like the TS API, which only
/// registered these routes when `deps.desktopControl` was present.
fn desktop_or_unavailable(
    state: &AppState,
) -> Result<std::sync::Arc<dyn DesktopControlPlane>, ApiError> {
    state.desktop_control().ok_or_else(|| {
        ApiError::http(
            404,
            "Desktop controls are only available in the desktop app",
        )
    })
}

async fn status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let status_counts = repository.get_post_job_status_counts().await?;
    let total_jobs: i64 = status_counts.values().sum();
    let running_jobs = repository
        .list_jobs(
            None,
            Some(vec![zyquor_core::types::PostJobStatus::Running]),
            None,
        )
        .await?;
    let running_job_meta: Vec<Value> = running_jobs
        .iter()
        .map(|job| {
            json!({
                "accountId": job.account_id,
                "id": job.id,
                "mode": job.mode,
                "updatedAt": job.updated_at,
            })
        })
        .collect();
    let packet_count = repository.count_source_packets(None).await?;
    let pending_drafts = repository.count_pending_drafts().await?;
    let enabled_config_count = repository.count_ingest_configs(Some(true)).await?;

    let (ingest_run, _worker_hb) = {
        let runtime = state
            .runtime
            .lock()
            .map_err(|_| crate::errors::ApiError::Internal("runtime mutex poisoned".to_string()))?;
        (
            ingest_run_to_value_pub(&runtime.ingest_run_state),
            worker_heartbeat_to_value(&runtime.worker_heartbeat),
        )
    };

    let browser_loaded = state
        .runtime
        .lock()
        .map(|runtime| runtime.browser_loaded)
        .unwrap_or(false);

    // The posting section serialization matches SystemStatus in TS:
    // posting.cdpUrl/channel/enablePost/enablePrepare.
    let (cdp_url, channel, enable_post, enable_prepare) = {
        let browser = state
            .browser
            .lock()
            .map_err(|_| crate::errors::ApiError::Internal("browser mutex poisoned".to_string()))?;
        (
            browser.cdp_url.clone(),
            browser.channel.clone(),
            browser.enable_post,
            browser.enable_prepare,
        )
    };
    let started_at = state
        .api_started_at
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let running = {
        let runtime = state
            .runtime
            .lock()
            .map_err(|_| crate::errors::ApiError::Internal("runtime mutex poisoned".to_string()))?;
        if let Some(heartbeat) = &runtime.worker_heartbeat {
            let last_heartbeat_at = heartbeat.last_heartbeat_at.clone().unwrap_or_default();
            chrono::DateTime::parse_from_rfc3339(&last_heartbeat_at)
                .map(|parsed| {
                    (chrono::Utc::now() - parsed.with_timezone(&chrono::Utc)).num_seconds() < 120
                })
                .unwrap_or(false)
        } else {
            false
        }
    };
    let heartbeat = state
        .runtime
        .lock()
        .map_err(|_| crate::errors::ApiError::Internal("runtime mutex poisoned".to_string()))?
        .worker_heartbeat
        .clone();
    let (last_error, last_heartbeat_at, last_ingest_at, last_post_at) = match heartbeat {
        Some(heartbeat) => (
            heartbeat.last_error,
            heartbeat.last_heartbeat_at,
            heartbeat.last_ingest_at,
            heartbeat.last_post_at,
        ),
        None => (None, None, None, None),
    };

    let control = state.desktop_control();
    let desktop = match &control {
        Some(control) => control.status().await,
        None => Value::Null,
    };
    let worker_paused = control
        .as_ref()
        .is_some_and(|control| control.worker_paused());

    Ok(Json(json!({
        "api": {
            "startedAt": started_at,
            "browserLoaded": browser_loaded
        },
        "counts": {
            "drafts": pending_drafts,
            "ingestConfigsEnabled": enabled_config_count,
            "jobs": total_jobs,
            "jobsByStatus": status_counts,
            "sourcePackets": packet_count
        },
        "desktop": desktop,
        "runningJobs": running_job_meta,
        "generation": {
            "model": state.generation_model(),
            "provider": state.generation_provider_name()
        },
        "ingestRun": ingest_run,
        "posting": {
            "cdpUrl": cdp_url,
            "channel": channel,
            "enablePost": enable_post,
            "enablePrepare": enable_prepare,
            "autoApproveSourcePackets": crate::routes::settings::stored_bool("autoApproveSourcePackets").unwrap_or(false)
        },
        "worker": {
            "lastError": last_error,
            "lastHeartbeatAt": last_heartbeat_at,
            "lastIngestAt": last_ingest_at,
            "lastPostAt": last_post_at,
            "paused": worker_paused,
            "running": running
        }
    })))
}

#[derive(serde::Deserialize, Default)]
struct UpdatePostingRequest {
    #[serde(default, rename = "enablePost")]
    enable_post: Option<bool>,
    #[serde(default, rename = "enablePrepare")]
    enable_prepare: Option<bool>,
    #[serde(default, rename = "autoApproveSourcePackets")]
    auto_approve_source_packets: Option<bool>,
}

async fn update_posting(
    State(state): State<AppState>,
    Json(input): Json<UpdatePostingRequest>,
) -> Result<Json<Value>, ApiError> {
    let (enable_prepare, enable_post) = {
        let mut browser = state
            .browser
            .lock()
            .map_err(|_| crate::errors::ApiError::Internal("browser mutex poisoned".to_string()))?;
        if let Some(enable_prepare) = input.enable_prepare {
            browser.enable_prepare = enable_prepare;
            crate::routes::settings::set_stored_value(
                "enableBrowserPrepare",
                json!(enable_prepare),
            );
        }
        if let Some(enable_post) = input.enable_post {
            browser.enable_post = enable_post;
            crate::routes::settings::set_stored_value("enableBrowserPost", json!(enable_post));
        }
        (browser.enable_prepare, browser.enable_post)
    };
    if let Some(auto_approve) = input.auto_approve_source_packets {
        crate::routes::settings::set_stored_value("autoApproveSourcePackets", json!(auto_approve));
    }
    let auto_approve =
        crate::routes::settings::stored_bool("autoApproveSourcePackets").unwrap_or(false);
    Ok(Json(json!({
        "enablePost": enable_post,
        "enablePrepare": enable_prepare,
        "autoApproveSourcePackets": auto_approve
    })))
}

async fn cancel_ingest(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let mut runtime = state
        .runtime
        .lock()
        .map_err(|_| crate::errors::ApiError::Internal("runtime mutex poisoned".to_string()))?;
    runtime.ingest_run_state.cancel_requested = true;
    Ok(Json(json!({
        "cancelRequested": true,
        "running": runtime.ingest_run_state.running
    })))
}

#[derive(serde::Deserialize, Default)]
struct LogsQuery {
    lines: Option<String>,
}

/// `GET /system/logs?lines=400` — tail of the desktop `main.log`.
async fn logs(
    State(state): State<AppState>,
    Query(query): Query<LogsQuery>,
) -> Result<Json<Value>, ApiError> {
    let control = desktop_or_unavailable(&state)?;
    // TS: `Math.min(Math.max(Number(lines ?? 200) || 200, 1), 2000)`.
    let requested = query
        .lines
        .as_deref()
        .and_then(|value| value.trim().parse::<i64>().ok())
        .unwrap_or(200);
    let lines = requested.clamp(1, 2_000) as usize;
    Ok(Json(json!({ "lines": control.log_tail(lines) })))
}

/// `POST /system/worker/pause` — pause/resume the in-process worker.
/// TS defaults to pausing: only an explicit `false` resumes.
async fn pause_worker(
    State(state): State<AppState>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let control = desktop_or_unavailable(&state)?;
    let paused = body
        .as_ref()
        .and_then(|Json(value)| value.get("paused"))
        .and_then(Value::as_bool)
        != Some(false);
    let paused = control.set_worker_paused(paused);
    Ok(Json(json!({ "paused": paused })))
}

/// `POST /system/chrome/close` — close every enabled account's posting Chrome.
async fn close_chrome(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let control = desktop_or_unavailable(&state)?;
    Ok(Json(control.close_chrome().await))
}

/// `POST /system/stop-all` — pause the worker, cancel ingest, disable prepare
/// and post, then close Chrome. Chrome stays open while a job is running and
/// the response says why (`reason: "job-running"`), matching the TS route.
async fn stop_all(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let control = desktop_or_unavailable(&state)?;
    let worker_paused = control.set_worker_paused(true);
    {
        let mut browser = state
            .browser
            .lock()
            .map_err(|_| ApiError::Internal("browser mutex poisoned".to_string()))?;
        browser.enable_prepare = false;
        browser.enable_post = false;
    }
    {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| ApiError::Internal("runtime mutex poisoned".to_string()))?;
        runtime.ingest_run_state.cancel_requested = true;
    }
    let running = state
        .repository()
        .list_jobs(
            None,
            Some(vec![zyquor_core::types::PostJobStatus::Running]),
            None,
        )
        .await?;
    let running_job_ids: Vec<String> = running.into_iter().map(|job| job.id).collect();
    let chrome = if running_job_ids.is_empty() {
        control.close_chrome().await
    } else {
        json!({ "closed": false, "reason": "job-running" })
    };
    Ok(Json(json!({
        "chrome": chrome,
        "enablePost": false,
        "enablePrepare": false,
        "runningJobIds": running_job_ids,
        "workerPaused": worker_paused
    })))
}

/// `POST /system/quit` — the desktop shell schedules the shutdown and exits.
async fn quit(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let control = desktop_or_unavailable(&state)?;
    control.request_quit();
    Ok(Json(json!({ "quitting": true })))
}

/// `POST /system/restart` — the desktop shell relaunches and exits.
async fn restart(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let control = desktop_or_unavailable(&state)?;
    control.request_restart();
    Ok(Json(json!({ "restarting": true })))
}

pub(crate) fn ingest_run_to_value_pub(state: &crate::state::IngestRunState) -> serde_json::Value {
    serde_json::json!({
        "cancelRequested": state.cancel_requested,
        "errors": state.errors.iter().map(|item| serde_json::json!({"configId": item.config_id, "error": item.error})).collect::<Vec<_>>(),
        "finishedAt": state.finished_at,
        "lastStartedAt": state.last_started_at,
        "processed": state.processed,
        "running": state.running,
        "skippedByReason": state.skipped_by_reason.as_ref().map(|skipped| serde_json::json!({
            "blockedUrl": skipped.blocked_url,
            "duplicatePacket": skipped.duplicate_packet,
            "duplicatePostedUrl": skipped.duplicate_posted_url,
            "hostCap": skipped.host_cap,
            "offTopic": skipped.off_topic,
            "packetCap": skipped.packet_cap,
            "scheduleWindow": skipped.schedule_window,
            "thinContext": skipped.thin_context,
            "topicOverlap": skipped.topic_overlap,
        }))
    })
}

fn worker_heartbeat_to_value(
    heartbeat: &Option<crate::state::WorkerHeartbeat>,
) -> serde_json::Value {
    match heartbeat {
        Some(heartbeat) => serde_json::json!({
            "lastError": heartbeat.last_error,
            "lastHeartbeatAt": heartbeat.last_heartbeat_at,
            "lastIngestAt": heartbeat.last_ingest_at,
            "lastPostAt": heartbeat.last_post_at,
        }),
        None => serde_json::Value::Null,
    }
}
