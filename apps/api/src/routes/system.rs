//! System routes, ported from `apps/api/src/routes/system.ts`.

use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use serde_json::{Value, json};

use crate::errors::ApiError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/system/status", get(status))
        .route("/system/posting", post(update_posting))
        .route("/system/ingest/cancel", post(cancel_ingest))
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
        "desktop": null,
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
            "autoApproveSourcePackets": false
        },
        "worker": {
            "lastError": last_error,
            "lastHeartbeatAt": last_heartbeat_at,
            "lastIngestAt": last_ingest_at,
            "lastPostAt": last_post_at,
            "paused": false,
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
    _auto_approve_source_packets: Option<bool>,
}

async fn update_posting(
    State(state): State<AppState>,
    Json(input): Json<UpdatePostingRequest>,
) -> Result<Json<Value>, ApiError> {
    let mut browser = state
        .browser
        .lock()
        .map_err(|_| crate::errors::ApiError::Internal("browser mutex poisoned".to_string()))?;
    if let Some(enable_prepare) = input.enable_prepare {
        browser.enable_prepare = enable_prepare;
    }
    if let Some(enable_post) = input.enable_post {
        browser.enable_post = enable_post;
    }
    let auto_approve = state.runtime.lock().map(|_| false).unwrap_or(false);
    let _ = auto_approve;
    Ok(Json(json!({
        "enablePost": browser.enable_post,
        "enablePrepare": browser.enable_prepare,
        "autoApproveSourcePackets": false
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
