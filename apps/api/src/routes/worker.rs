//! Worker routes, ported from `apps/api/src/routes/worker.ts`.

use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use serde_json::{Value, json};

use crate::errors::ApiError;
use crate::state::{AppState, WorkerHeartbeat};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/health", get(health))
        .route("/worker/status", get(worker_status))
        .route("/worker/heartbeat", post(worker_heartbeat))
}

async fn health(State(state): State<AppState>) -> Json<Value> {
    let browser_loaded = state
        .runtime
        .lock()
        .map(|runtime| runtime.browser_loaded)
        .unwrap_or(false);
    Json(json!({
        "browserLoaded": browser_loaded,
        "generation": {
            "model": state.generation_model(),
            "provider": state.generation_provider_name(),
        },
        "ok": true,
    }))
}

async fn worker_status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    // SQL-side picks instead of loading all jobs and packets every poll.
    let (enabled_config_count, latest_packet, latest_posted) = tokio::try_join!(
        repository.count_ingest_configs(Some(true)),
        repository.get_latest_source_packet(),
        repository.get_latest_posted_job(),
    )
    .map_err(|error| ApiError::Internal(error.to_string()))?;

    let (heartbeat, ingest_run_value) = {
        let runtime = state
            .runtime
            .lock()
            .map_err(|_| ApiError::Internal("runtime mutex poisoned".to_string()))?;
        (
            runtime.worker_heartbeat.clone(),
            crate::routes::system::ingest_run_to_value_pub(&runtime.ingest_run_state),
        )
    };

    let whb = heartbeat.as_ref();
    let last_heartbeat_at = whb.and_then(|heartbeat| heartbeat.last_heartbeat_at.clone());
    let last_ingest_at = whb
        .and_then(|heartbeat| heartbeat.last_ingest_at.clone())
        .or_else(|| latest_packet.map(|packet| packet.created_at));
    let last_post_at = whb
        .and_then(|heartbeat| heartbeat.last_post_at.clone())
        .or_else(|| latest_posted.map(|job| job.updated_at));
    let last_error = whb.and_then(|heartbeat| heartbeat.last_error.clone());
    let next_ingest_run_at = last_heartbeat_at.as_deref().and_then(|heartbeat| {
        chrono::DateTime::parse_from_rfc3339(heartbeat)
            .ok()
            .map(|parsed| {
                (parsed + chrono::Duration::seconds(60))
                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            })
    });
    let worker_running = last_heartbeat_at.as_deref().is_some_and(|heartbeat| {
        chrono::DateTime::parse_from_rfc3339(heartbeat)
            .map(|parsed| {
                (chrono::Utc::now() - parsed.with_timezone(&chrono::Utc)).num_seconds() < 120
            })
            .unwrap_or(false)
    });

    Ok(Json(json!({
        "enabledIngestConfigCount": enabled_config_count,
        "hasEnabledIngestConfigs": enabled_config_count > 0,
        "ingestRun": ingest_run_value,
        "lastError": last_error,
        "lastHeartbeatAt": last_heartbeat_at,
        "lastIngestAt": last_ingest_at,
        "lastPostAt": last_post_at,
        "nextIngestRunAt": next_ingest_run_at,
        "ok": true,
        "workerRunning": worker_running,
    })))
}

async fn worker_heartbeat(
    State(state): State<AppState>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let (last_error, last_ingest_at, last_post_at) = match body {
        Some(Json(value)) if value.is_object() => {
            let string = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
            (
                string("lastError"),
                string("lastIngestAt"),
                string("lastPostAt"),
            )
        }
        Some(Json(_)) | None => (None, None, None),
    };
    let heartbeat = WorkerHeartbeat {
        last_error,
        last_heartbeat_at: Some(
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        ),
        last_ingest_at,
        last_post_at,
    };
    {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| ApiError::Internal("runtime mutex poisoned".to_string()))?;
        runtime.worker_heartbeat = Some(heartbeat.clone());
    }
    Ok(Json(json!({
        "ok": true,
        "worker": {
            "lastError": heartbeat.last_error,
            "lastHeartbeatAt": heartbeat.last_heartbeat_at,
            "lastIngestAt": heartbeat.last_ingest_at,
            "lastPostAt": heartbeat.last_post_at,
        },
    })))
}
