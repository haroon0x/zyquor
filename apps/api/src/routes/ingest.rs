//! Ingest routes, ported from `apps/api/src/routes/ingest.ts`.

use std::collections::HashMap;
use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, patch, post},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::errors::ApiError;
use crate::state::{AppState, IngestSkipped as StateIngestSkipped};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/ingest-runs", get(list_ingest_runs))
        .route(
            "/ingest-runs/recover-stale",
            post(recover_stale_ingest_runs),
        )
        .route(
            "/ingest-configs",
            get(list_ingest_configs).post(create_ingest_config),
        )
        .route("/ingest-sources", get(list_ingest_sources))
        .route(
            "/ingest-configs/default-news",
            post(create_default_news_config),
        )
        .route(
            "/ingest-configs/{id}",
            patch(update_ingest_config).delete(delete_ingest_config),
        )
        .route("/ingest-run", post(run_ingest_sync))
        .route("/ingest-run/async", post(run_ingest_async))
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn api_error_message(error: &ApiError) -> String {
    match error {
        ApiError::Invalid { message, .. } => message.clone(),
        ApiError::Http(http_error) => http_error.message.clone(),
        ApiError::Conflict(message) => message.clone(),
        ApiError::Generation(message) => message.clone(),
        ApiError::Internal(message) => message.clone(),
    }
}

#[derive(Deserialize)]
struct IngestRunsQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

#[derive(Deserialize)]
struct IngestConfigsQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
}

async fn list_ingest_runs(
    State(state): State<AppState>,
    Query(query): Query<IngestRunsQuery>,
) -> Result<Json<Value>, ApiError> {
    let runs = state
        .repository()
        .list_ingest_runs(query.account_id.as_deref(), 50)
        .await?;
    Ok(Json(json!({"runs": runs})))
}

async fn recover_stale_ingest_runs(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let running = match state.runtime.lock() {
        Ok(guard) => guard.ingest_run_state.running,
        Err(poisoned) => poisoned.into_inner().ingest_run_state.running,
    };
    if running {
        return Ok(Json(json!({"recoveredCount": 0})));
    }
    let recovered_count = state.repository().recover_running_ingest_runs().await?;
    Ok(Json(json!({"recoveredCount": recovered_count})))
}

async fn list_ingest_configs(
    State(state): State<AppState>,
    Query(query): Query<IngestConfigsQuery>,
) -> Result<Json<Value>, ApiError> {
    let configs = state
        .repository()
        .list_ingest_configs(query.account_id.as_deref())
        .await?;
    Ok(Json(json!({"configs": configs})))
}

async fn list_ingest_sources(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let mut sources = Vec::new();
    for adapter in state.source_adapters.values() {
        let name = adapter.name().to_string();
        let source_type = adapter.source_type().to_string();
        let health: Value = if name == "aggregated-news" {
            let snapshots = zyquor_adapters::get_aggregated_source_health();
            let mut items = Vec::new();
            for snapshot in &snapshots {
                items.push(json!({
                    "consecutiveFailures": snapshot.consecutive_failures,
                    "lastError": snapshot.last_error,
                    "lastFailureAt": snapshot.last_failure_at,
                    "lastItemCount": snapshot.last_item_count,
                    "lastSuccessAt": snapshot.last_success_at,
                    "name": snapshot.name,
                    "skippedUntil": snapshot.skipped_until,
                    "successCount": snapshot.success_count,
                }));
            }
            Value::Array(items)
        } else {
            Value::Null
        };
        sources.push(json!({"health": health, "name": name, "sourceType": source_type}));
    }
    // Deterministic order: HashMap iteration is unordered.
    sources.sort_by(|a, b| {
        let name_a = a.get("name").and_then(Value::as_str).unwrap_or("");
        let name_b = b.get("name").and_then(Value::as_str).unwrap_or("");
        name_a.cmp(name_b)
    });
    Ok(Json(json!({"sources": sources})))
}

fn is_valid_source_type(value: &str) -> bool {
    value.parse::<zyquor_core::types::SourceType>().is_ok()
}

fn is_valid_tweet_type_key(value: &str) -> bool {
    matches!(
        value,
        "useful_info" | "guide" | "opinion" | "reply" | "narrative_history" | "feed_observation"
    )
}

fn is_valid_schedule_window(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 5 {
        return false;
    }
    bytes.get(2) == Some(&b':')
        && bytes[0].is_ascii_digit()
        && bytes[1].is_ascii_digit()
        && bytes[3].is_ascii_digit()
        && bytes[4].is_ascii_digit()
}

fn insert_string_map(map: &mut Map<String, Value>, key: &str, value: String) {
    map.insert(key.to_string(), Value::String(value));
}

async fn create_ingest_config(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("request body must be a JSON object"))?;

    // accountId
    let account_id = match object.get("accountId").and_then(Value::as_str) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => return Err(ApiError::invalid("accountId is required")),
    };

    // sourceType
    let source_type = match object.get("sourceType").and_then(Value::as_str) {
        Some(value) if is_valid_source_type(value) => value.to_string(),
        _ => return Err(ApiError::invalid("sourceType is invalid")),
    };

    // maxPacketsPerDay (default 4)
    let max_packets_per_day: i64 = if let Some(raw) = object.get("maxPacketsPerDay") {
        if raw.is_null() {
            return Err(ApiError::invalid(
                "maxPacketsPerDay must be an integer between 1 and 1000",
            ));
        }
        match raw.as_i64() {
            Some(value) if (1..=1000).contains(&value) => value,
            _ => {
                return Err(ApiError::invalid(
                    "maxPacketsPerDay must be an integer between 1 and 1000",
                ));
            }
        }
    } else {
        4
    };

    // metadata (default {})
    let metadata: Map<String, Value> = if let Some(raw) = object.get("metadata") {
        if raw.is_null() {
            return Err(ApiError::invalid("metadata must be an object"));
        }
        match raw.as_object() {
            Some(map) => map.clone(),
            None => return Err(ApiError::invalid("metadata must be an object")),
        }
    } else {
        Map::new()
    };

    // tweetTypeMix (default {})
    let tweet_type_mix: Map<String, Value> = if let Some(raw) = object.get("tweetTypeMix") {
        if raw.is_null() {
            return Err(ApiError::invalid("tweetTypeMix must be an object"));
        }
        let map = raw
            .as_object()
            .ok_or_else(|| ApiError::invalid("tweetTypeMix must be an object"))?;
        for (key, value) in map.iter() {
            if !is_valid_tweet_type_key(key) {
                return Err(ApiError::invalid(format!(
                    "tweetTypeMix key is invalid: {key}"
                )));
            }
            match value.as_i64() {
                Some(number) if (0..=100).contains(&number) => {}
                _ => {
                    return Err(ApiError::invalid(
                        "tweetTypeMix values must be integers between 0 and 100",
                    ));
                }
            }
        }
        map.clone()
    } else {
        Map::new()
    };

    // scheduleWindowStart (default "09:00")
    let schedule_window_start: String = if let Some(raw) = object.get("scheduleWindowStart") {
        if raw.is_null() {
            return Err(ApiError::invalid(
                "scheduleWindowStart must match ^\\d{2}:\\d{2}$",
            ));
        }
        match raw.as_str() {
            Some(value) if is_valid_schedule_window(value) => value.to_string(),
            _ => {
                return Err(ApiError::invalid(
                    "scheduleWindowStart must match ^\\d{2}:\\d{2}$",
                ));
            }
        }
    } else {
        "09:00".to_string()
    };

    // scheduleWindowEnd (default "21:00")
    let schedule_window_end: String = if let Some(raw) = object.get("scheduleWindowEnd") {
        if raw.is_null() {
            return Err(ApiError::invalid(
                "scheduleWindowEnd must match ^\\d{2}:\\d{2}$",
            ));
        }
        match raw.as_str() {
            Some(value) if is_valid_schedule_window(value) => value.to_string(),
            _ => {
                return Err(ApiError::invalid(
                    "scheduleWindowEnd must match ^\\d{2}:\\d{2}$",
                ));
            }
        }
    } else {
        "21:00".to_string()
    };

    // enabled (default true)
    let enabled: bool = if let Some(raw) = object.get("enabled") {
        if raw.is_null() {
            return Err(ApiError::invalid("enabled must be a boolean"));
        }
        match raw.as_bool() {
            Some(value) => value,
            None => return Err(ApiError::invalid("enabled must be a boolean")),
        }
    } else {
        true
    };

    let config = state
        .repository()
        .create_ingest_config(zyquor_storage::NewIngestConfig {
            account_id,
            source_type,
            max_packets_per_day,
            metadata,
            tweet_type_mix,
            schedule_window_start,
            schedule_window_end,
            enabled,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(json!({"config": config}))))
}

async fn create_default_news_config(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let repository = state.repository();
    let configs = repository.list_ingest_configs(None).await?;
    if let Some(existing) = configs
        .into_iter()
        .find(|config| config.enabled && config.source_type == "news")
    {
        return Ok((
            StatusCode::OK,
            Json(json!({"config": existing, "created": false})),
        ));
    }

    let accounts = repository.list_accounts().await?;
    let account = accounts
        .iter()
        .find(|item| item.enabled)
        .cloned()
        .or_else(|| accounts.into_iter().next());
    let Some(account) = account else {
        return Err(ApiError::http(
            409,
            "No account available for default ingest config",
        ));
    };

    let mut metadata = Map::new();
    insert_string_map(&mut metadata, "__keep", String::new());
    metadata.remove("__keep");
    metadata.insert("includeArxiv".to_string(), Value::Bool(true));
    metadata.insert("includeCompanyRss".to_string(), Value::Bool(true));
    metadata.insert("includeExpandedHackerNews".to_string(), Value::Bool(true));
    metadata.insert("includeGitHub".to_string(), Value::Bool(true));
    metadata.insert("includeHiring".to_string(), Value::Bool(true));
    metadata.insert("includeProductHunt".to_string(), Value::Bool(true));
    metadata.insert("includeReddit".to_string(), Value::Bool(true));
    metadata.insert("includeTechCrunch".to_string(), Value::Bool(true));
    metadata.insert("maxItems".to_string(), Value::from(100));
    metadata.insert("requireTopicMatch".to_string(), Value::Bool(false));

    let mut tweet_type_mix = Map::new();
    tweet_type_mix.insert("useful_info".to_string(), Value::from(100));

    let config = repository
        .create_ingest_config(zyquor_storage::NewIngestConfig {
            account_id: account.id,
            enabled: true,
            max_packets_per_day: 4,
            metadata,
            schedule_window_end: "23:59".to_string(),
            schedule_window_start: "00:00".to_string(),
            source_type: "news".to_string(),
            tweet_type_mix,
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"config": config, "created": true})),
    ))
}

async fn update_ingest_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("request body must be a JSON object"))?;

    let mut update = zyquor_storage::IngestConfigUpdate {
        source_type: None,
        max_packets_per_day: None,
        metadata: None,
        tweet_type_mix: None,
        schedule_window_start: None,
        schedule_window_end: None,
        enabled: None,
    };

    if let Some(raw) = object.get("sourceType") {
        if raw.is_null() {
            return Err(ApiError::invalid("sourceType is invalid"));
        }
        match raw.as_str() {
            Some(value) if is_valid_source_type(value) => {
                update.source_type = Some(value.to_string())
            }
            _ => return Err(ApiError::invalid("sourceType is invalid")),
        }
    }
    if let Some(raw) = object.get("maxPacketsPerDay") {
        if raw.is_null() {
            return Err(ApiError::invalid(
                "maxPacketsPerDay must be an integer between 1 and 1000",
            ));
        }
        match raw.as_i64() {
            Some(value) if (1..=1000).contains(&value) => update.max_packets_per_day = Some(value),
            _ => {
                return Err(ApiError::invalid(
                    "maxPacketsPerDay must be an integer between 1 and 1000",
                ));
            }
        }
    }
    if let Some(raw) = object.get("metadata") {
        if raw.is_null() {
            return Err(ApiError::invalid("metadata must be an object"));
        }
        match raw.as_object() {
            Some(map) => update.metadata = Some(map.clone()),
            None => return Err(ApiError::invalid("metadata must be an object")),
        }
    }
    if let Some(raw) = object.get("tweetTypeMix") {
        if raw.is_null() {
            return Err(ApiError::invalid("tweetTypeMix must be an object"));
        }
        let map = raw
            .as_object()
            .ok_or_else(|| ApiError::invalid("tweetTypeMix must be an object"))?;
        for (key, value) in map.iter() {
            if !is_valid_tweet_type_key(key) {
                return Err(ApiError::invalid(format!(
                    "tweetTypeMix key is invalid: {key}"
                )));
            }
            match value.as_i64() {
                Some(number) if (0..=100).contains(&number) => {}
                _ => {
                    return Err(ApiError::invalid(
                        "tweetTypeMix values must be integers between 0 and 100",
                    ));
                }
            }
        }
        update.tweet_type_mix = Some(map.clone());
    }
    if let Some(raw) = object.get("scheduleWindowStart") {
        if raw.is_null() {
            return Err(ApiError::invalid(
                "scheduleWindowStart must match ^\\d{2}:\\d{2}$",
            ));
        }
        match raw.as_str() {
            Some(value) if is_valid_schedule_window(value) => {
                update.schedule_window_start = Some(value.to_string())
            }
            _ => {
                return Err(ApiError::invalid(
                    "scheduleWindowStart must match ^\\d{2}:\\d{2}$",
                ));
            }
        }
    }
    if let Some(raw) = object.get("scheduleWindowEnd") {
        if raw.is_null() {
            return Err(ApiError::invalid(
                "scheduleWindowEnd must match ^\\d{2}:\\d{2}$",
            ));
        }
        match raw.as_str() {
            Some(value) if is_valid_schedule_window(value) => {
                update.schedule_window_end = Some(value.to_string())
            }
            _ => {
                return Err(ApiError::invalid(
                    "scheduleWindowEnd must match ^\\d{2}:\\d{2}$",
                ));
            }
        }
    }
    if let Some(raw) = object.get("enabled") {
        if raw.is_null() {
            return Err(ApiError::invalid("enabled must be a boolean"));
        }
        match raw.as_bool() {
            Some(value) => update.enabled = Some(value),
            None => return Err(ApiError::invalid("enabled must be a boolean")),
        }
    }

    let repository = state.repository();
    match repository.update_ingest_config(&id, update).await {
        Ok(config) => Ok(Json(json!({"config": config}))),
        Err(zyquor_storage::StorageError::NotFound(_)) => {
            Err(ApiError::http(404, "Ingest config not found"))
        }
        Err(error) => Err(ApiError::from(error)),
    }
}

async fn delete_ingest_config(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    match repository.delete_ingest_config(&id).await {
        Ok(config) => Ok(Json(json!({"config": config}))),
        Err(zyquor_storage::StorageError::NotFound(_)) => {
            Err(ApiError::http(404, "Ingest config not found"))
        }
        Err(error) => Err(ApiError::from(error)),
    }
}

fn ingest_result_json(result: &zyquor_automation::IngestResult) -> Value {
    let errors = result
        .errors
        .iter()
        .map(|error| json!({"configId": error.config_id, "error": error.error}))
        .collect::<Vec<_>>();
    let results = result
        .results
        .iter()
        .map(|item| {
            json!({
                "configId": item.config_id,
                "draftId": item.draft_id,
                "jobId": item.job_id,
                "packetId": item.packet_id,
                "sourceType": item.source_type,
                "url": item.url,
            })
        })
        .collect::<Vec<_>>();
    json!({
        "errors": errors,
        "processed": result.processed,
        "results": results,
        "skippedByReason": {
            "blockedUrl": result.skipped.blocked_url,
            "duplicatePacket": result.skipped.duplicate_packet,
            "duplicatePostedUrl": result.skipped.duplicate_posted_url,
            "hostCap": result.skipped.host_cap,
            "offTopic": result.skipped.off_topic,
            "packetCap": result.skipped.packet_cap,
            "scheduleWindow": result.skipped.schedule_window,
            "thinContext": result.skipped.thin_context,
            "topicOverlap": result.skipped.topic_overlap,
            "lowSignal": result.skipped.low_signal,
        },
    })
}

fn ingest_run_state_json(state: &crate::state::IngestRunState) -> Value {
    let errors = state
        .errors
        .iter()
        .map(|error| json!({"configId": error.config_id, "error": error.error}))
        .collect::<Vec<_>>();
    let skipped = state.skipped_by_reason.as_ref().map(|skipped| {
        json!({
            "blockedUrl": skipped.blocked_url,
            "duplicatePacket": skipped.duplicate_packet,
            "duplicatePostedUrl": skipped.duplicate_posted_url,
            "hostCap": skipped.host_cap,
            "offTopic": skipped.off_topic,
            "packetCap": skipped.packet_cap,
            "scheduleWindow": skipped.schedule_window,
            "thinContext": skipped.thin_context,
            "topicOverlap": skipped.topic_overlap,
        })
    });
    json!({
        "cancelRequested": state.cancel_requested,
        "errors": errors,
        "finishedAt": state.finished_at,
        "lastStartedAt": state.last_started_at,
        "processed": state.processed,
        "running": state.running,
        "skippedByReason": skipped,
    })
}

async fn execute_automatic_ingest(
    state: &AppState,
    on_progress: Option<Arc<dyn Fn(zyquor_automation::IngestProgress) + Send + Sync>>,
    should_continue: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
) -> Result<zyquor_automation::IngestResult, ApiError> {
    let db_path = state.db_path.clone();
    let adapters: HashMap<String, Arc<dyn zyquor_adapters::SourceAdapter>> =
        state.source_adapters.clone();
    let provider = state.generation_provider.clone();
    let deps = state.automation_deps.clone();
    let now = chrono::Utc::now();
    // Rust has no desktopSettings: TS fallback is `true` when absent.
    let auto_approve = true;

    let outcome = tokio::task::spawn_blocking(
        move || -> std::result::Result<zyquor_automation::IngestResult, String> {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .map_err(|error| error.to_string())?;
            // Own connection: never hold the shared proxy mutex across a
            // network-bound ingest, or every other repository call stalls.
            let repository = zyquor_storage::SqliteRepository::open(&db_path)
                .map_err(|error| error.to_string())?;
            let options = zyquor_automation::RunAutomaticIngestOptions {
                adapters,
                generation_provider: provider,
                repository: &repository,
                deps: &deps,
                now,
                auto_approve,
                on_progress,
                should_continue,
            };
            runtime
                .block_on(async { zyquor_automation::run_automatic_ingest(&options).await })
                .map_err(|error| error.to_string())
        },
    )
    .await
    .map_err(|error| ApiError::Internal(format!("ingest task failed: {error}")))?;

    let result = outcome.map_err(ApiError::Internal)?;
    Ok(result)
}

async fn run_ingest_sync(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let result = execute_automatic_ingest(&state, None, None).await?;
    for error in &result.errors {
        eprintln!(
            "Ingest run failed for config {}: {}",
            error.config_id, error.error
        );
    }
    Ok(Json(ingest_result_json(&result)))
}

async fn run_ingest_async(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let is_running = match state.runtime.lock() {
        Ok(guard) => guard.ingest_run_state.running,
        Err(poisoned) => poisoned.into_inner().ingest_run_state.running,
    };
    if is_running {
        let snapshot = match state.runtime.lock() {
            Ok(guard) => ingest_run_state_json(&guard.ingest_run_state),
            Err(poisoned) => ingest_run_state_json(&poisoned.into_inner().ingest_run_state),
        };
        return Ok((
            StatusCode::ACCEPTED,
            Json(json!({"accepted": false, "ingestRun": snapshot, "reason": "already_running"})),
        ));
    }

    let repository = state.repository();
    let configs = repository.list_ingest_configs(None).await?;
    let enabled_configs: Vec<_> = configs
        .into_iter()
        .filter(|config| config.enabled)
        .collect();
    let mut runs = Vec::new();
    for config in &enabled_configs {
        let run = repository
            .create_ingest_run(&config.id, &config.account_id)
            .await?;
        runs.push(run);
    }

    let last_started_at = now_iso();
    {
        let mut guard = match state.runtime.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.ingest_run_state = crate::state::IngestRunState {
            cancel_requested: false,
            errors: Vec::new(),
            finished_at: None,
            last_started_at: Some(last_started_at.clone()),
            processed: 0,
            running: true,
            skipped_by_reason: None,
        };
    }

    let snapshot = match state.runtime.lock() {
        Ok(guard) => ingest_run_state_json(&guard.ingest_run_state),
        Err(poisoned) => ingest_run_state_json(&poisoned.into_inner().ingest_run_state),
    };

    let background_state = state.clone();
    let background_runs = runs.clone();
    let background_last_started = last_started_at.clone();
    tokio::spawn(async move {
        let runtime_handle = background_state.runtime.clone();

        let on_progress: Arc<dyn Fn(zyquor_automation::IngestProgress) + Send + Sync> =
            Arc::new(move |progress: zyquor_automation::IngestProgress| {
                let errors = progress
                    .errors
                    .into_iter()
                    .map(|error| crate::state::IngestErrorEntry::new(error.config_id, error.error))
                    .collect::<Vec<_>>();
                let mut guard = match runtime_handle.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.ingest_run_state.errors = errors;
                guard.ingest_run_state.processed = progress.processed;
            });
        let runtime_for_continue = background_state.runtime.clone();
        let should_continue: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || {
            let guard = match runtime_for_continue.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            !guard.ingest_run_state.cancel_requested
        });

        let repository = background_state.repository();
        let result =
            execute_automatic_ingest(&background_state, Some(on_progress), Some(should_continue))
                .await;

        match result {
            Ok(ingest_result) => {
                for error in &ingest_result.errors {
                    eprintln!(
                        "Async ingest run failed for config {}: {}",
                        error.config_id, error.error
                    );
                }
                for run in &background_runs {
                    let run_errors: Vec<_> = ingest_result
                        .errors
                        .iter()
                        .filter(|error| error.config_id == run.config_id)
                        .collect();
                    let packets_created = ingest_result
                        .results
                        .iter()
                        .filter(|item| item.config_id == run.config_id)
                        .count() as i64;
                    let status = if run_errors.is_empty() {
                        zyquor_storage::IngestRunStatus::Succeeded
                    } else {
                        zyquor_storage::IngestRunStatus::Failed
                    };
                    let error_value: Option<Option<String>> = if run_errors.is_empty() {
                        Some(None)
                    } else {
                        let joined = run_errors
                            .iter()
                            .map(|error| error.error.clone())
                            .collect::<Vec<_>>()
                            .join("; ");
                        Some(Some(joined))
                    };
                    let _ = repository
                        .update_ingest_run(
                            &run.id,
                            zyquor_storage::IngestRunUpdate {
                                status,
                                error: error_value,
                                packets_created: Some(packets_created),
                            },
                        )
                        .await;
                }
                let mut guard = match background_state.runtime.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.ingest_run_state = crate::state::IngestRunState {
                    errors: ingest_result
                        .errors
                        .into_iter()
                        .map(|error| {
                            crate::state::IngestErrorEntry::new(error.config_id, error.error)
                        })
                        .collect(),
                    finished_at: Some(now_iso()),
                    last_started_at: Some(background_last_started.clone()),
                    processed: ingest_result.processed,
                    running: false,
                    skipped_by_reason: Some(StateIngestSkipped {
                        blocked_url: ingest_result.skipped.blocked_url,
                        duplicate_packet: ingest_result.skipped.duplicate_packet,
                        duplicate_posted_url: ingest_result.skipped.duplicate_posted_url,
                        host_cap: ingest_result.skipped.host_cap,
                        off_topic: ingest_result.skipped.off_topic,
                        packet_cap: ingest_result.skipped.packet_cap,
                        schedule_window: ingest_result.skipped.schedule_window,
                        thin_context: ingest_result.skipped.thin_context,
                        topic_overlap: ingest_result.skipped.topic_overlap,
                    }),
                    cancel_requested: false,
                };
            }
            Err(error) => {
                let message = api_error_message(&error);
                eprintln!("Async ingest run failed: {message}");
                for run in &background_runs {
                    let _ = repository
                        .update_ingest_run(
                            &run.id,
                            zyquor_storage::IngestRunUpdate {
                                status: zyquor_storage::IngestRunStatus::Failed,
                                error: Some(Some(message.clone())),
                                packets_created: Some(0),
                            },
                        )
                        .await;
                }
                let mut guard = match background_state.runtime.lock() {
                    Ok(guard) => guard,
                    Err(poisoned) => poisoned.into_inner(),
                };
                guard.ingest_run_state = crate::state::IngestRunState {
                    errors: vec![crate::state::IngestErrorEntry::new("unknown", message)],
                    finished_at: Some(now_iso()),
                    last_started_at: Some(background_last_started.clone()),
                    processed: 0,
                    running: false,
                    skipped_by_reason: None,
                    cancel_requested: false,
                };
            }
        }
    });

    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"accepted": true, "ingestRun": snapshot})),
    ))
}
