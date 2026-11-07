//! Source-packets routes, ported from `apps/api/src/routes/source-packets.ts`.

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get, post},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::errors::ApiError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/source-packets",
            get(list_source_packets)
                .post(create_source_packet)
                .delete(delete_source_packets_bulk),
        )
        .route("/source-packets/{id}", delete(delete_source_packet_cascade))
        .route(
            "/source-packets/{id}/draft",
            post(create_packet_draft)
                .get(get_packet_draft)
                .delete(delete_packet_draft),
        )
        .route("/source-packets/{id}/regenerate", post(regenerate_packet))
        .route("/source-packets/{id}/feedback", post(set_packet_feedback))
}

#[derive(Deserialize)]
struct PacketsQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
    status: Option<String>,
    limit: Option<String>,
}

#[derive(Deserialize, Default)]
struct AccountIdQuery {
    #[serde(rename = "accountId")]
    account_id: Option<String>,
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

fn parse_status(raw: Option<&str>) -> Option<zyquor_storage::SourcePacketStatus> {
    let raw = raw?;
    match raw {
        "new" => Some(zyquor_storage::SourcePacketStatus::New),
        "drafted" => Some(zyquor_storage::SourcePacketStatus::Drafted),
        "archived" => Some(zyquor_storage::SourcePacketStatus::Archived),
        _ => None,
    }
}

fn parse_list_limit(raw: Option<&str>) -> Option<i64> {
    let raw = raw?;
    let parsed: f64 = raw.parse().ok()?;
    if !parsed.is_finite() || parsed <= 0.0 {
        return None;
    }
    Some((parsed.floor() as i64).min(1000))
}

async fn list_source_packets(
    State(state): State<AppState>,
    Query(query): Query<PacketsQuery>,
) -> Result<Json<Value>, ApiError> {
    let status = parse_status(query.status.as_deref());
    let limit = parse_list_limit(query.limit.as_deref());
    let packets = state
        .repository()
        .list_source_packets(query.account_id.as_deref(), status, limit)
        .await?;
    Ok(Json(json!({"packets": packets})))
}

// --- lib/source-packet-delete ------------------------------------------------

async fn delete_source_packet_cascade_impl(
    state: &AppState,
    packet_id: &str,
) -> Result<(Option<String>, zyquor_storage::SourcePacket), ApiError> {
    let repository = state.repository();
    let packet = repository.get_source_packet(packet_id).await?;
    let Some(packet) = packet else {
        return Err(ApiError::http(404, "Source packet not found"));
    };
    let draft = repository.get_draft_by_source_packet_id(&packet.id).await?;
    if let Some(ref draft) = draft {
        let draft_jobs = repository.list_jobs_by_draft_id(&draft.draft.id).await?;
        let history_count = repository
            .count_post_history_by_draft_id(&draft.draft.id)
            .await?;
        let has_running_job = draft_jobs
            .iter()
            .any(|job| job.status == zyquor_core::types::PostJobStatus::Running);
        let has_posted_job = draft_jobs
            .iter()
            .any(|job| job.status == zyquor_core::types::PostJobStatus::Posted);
        let has_post_history = history_count > 0;
        if has_running_job {
            return Err(ApiError::http(
                409,
                "Cannot delete source with a running job",
            ));
        }
        if !has_posted_job && !has_post_history {
            let _ = repository.delete_draft(&draft.draft.id).await?;
        }
    }
    let draft_id = draft.as_ref().map(|draft| draft.draft.id.clone());
    let deleted = repository.delete_source_packet(&packet.id).await?;
    Ok((draft_id, deleted))
}

async fn delete_source_packet_cascade(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let (draft_id, packet) = delete_source_packet_cascade_impl(&state, &id).await?;
    Ok(Json(
        json!({"deleted": true, "draftId": draft_id, "packet": packet}),
    ))
}

async fn delete_source_packets_bulk(
    State(state): State<AppState>,
    Query(query): Query<AccountIdQuery>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let packets = repository
        .list_source_packets(query.account_id.as_deref(), None, None)
        .await?;
    let jobs = repository.list_jobs(None, None, None).await?;
    let history = repository.list_post_history().await?;

    let mut jobs_by_draft_id: std::collections::HashMap<String, Vec<zyquor_storage::PostJob>> =
        std::collections::HashMap::new();
    for job in &jobs {
        jobs_by_draft_id
            .entry(job.draft_id.clone())
            .or_default()
            .push(job.clone());
    }
    let historical_draft_ids: std::collections::HashSet<String> =
        history.iter().map(|item| item.draft_id.clone()).collect();
    let mut results = Vec::new();
    for packet in &packets {
        let draft = repository.get_draft_by_source_packet_id(&packet.id).await?;
        if let Some(ref draft) = draft {
            let draft_jobs = jobs_by_draft_id
                .get(&draft.draft.id)
                .cloned()
                .unwrap_or_default();
            let has_posted_job = draft_jobs
                .iter()
                .any(|job| job.status == zyquor_core::types::PostJobStatus::Posted);
            let has_post_history = historical_draft_ids.contains(&draft.draft.id);
            let has_running_job = draft_jobs
                .iter()
                .any(|job| job.status == zyquor_core::types::PostJobStatus::Running);
            if has_running_job {
                results.push(json!({"deleted": false, "draftId": draft.draft.id, "packetId": packet.id, "reason": "job_running"}));
                continue;
            }
            if !has_posted_job && !has_post_history {
                let _ = repository.delete_draft(&draft.draft.id).await?;
            }
        }
        let draft_id = draft.as_ref().map(|draft| draft.draft.id.clone());
        let _ = repository.delete_source_packet(&packet.id).await?;
        results.push(json!({"deleted": true, "draftId": draft_id, "packetId": packet.id, "reason": Value::Null}));
    }
    let deleted_count = results
        .iter()
        .filter(|result| result.get("deleted").and_then(Value::as_bool) == Some(true))
        .count();
    let skipped_count = results
        .iter()
        .filter(|result| result.get("deleted").and_then(Value::as_bool) == Some(false))
        .count();
    Ok(Json(
        json!({"deletedCount": deleted_count, "skippedCount": skipped_count, "results": results}),
    ))
}

// --- validation ---------------------------------------------------------------

fn validate_id(value: &str) -> Result<String, ApiError> {
    if value.is_empty() {
        return Err(ApiError::invalid("id must be at least 1 character"));
    }
    Ok(value.to_string())
}

fn is_valid_source_type(value: &str) -> bool {
    value.parse::<zyquor_core::types::SourceType>().is_ok()
}

fn is_valid_tweet_type(value: &str) -> bool {
    zyquor_core::ALL_TWEET_TYPES
        .iter()
        .any(|item| item.as_str() == value)
}

fn is_valid_url(value: &str) -> bool {
    url::Url::parse(value).is_ok()
}

async fn create_source_packet(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("request body must be a JSON object"))?;
    let account_id = match object.get("accountId").and_then(Value::as_str) {
        Some(value) => validate_id(value)?,
        None => return Err(ApiError::invalid("accountId is required")),
    };
    let facts: Vec<String> = if let Some(raw) = object.get("facts") {
        if raw.is_null() {
            return Err(ApiError::invalid("facts must be an array"));
        }
        let array = raw
            .as_array()
            .ok_or_else(|| ApiError::invalid("facts must be an array"))?;
        if array.len() > 8 {
            return Err(ApiError::invalid("facts exceeds 8 items"));
        }
        let mut out = Vec::new();
        for item in array {
            let text = item
                .as_str()
                .ok_or_else(|| ApiError::invalid("facts must contain strings"))?;
            if text.is_empty() || text.len() > 500 {
                return Err(ApiError::invalid("facts entries must be 1..500 characters"));
            }
            out.push(text.to_string());
        }
        out
    } else {
        Vec::new()
    };
    let source_type = match object.get("sourceType").and_then(Value::as_str) {
        Some(value) if is_valid_source_type(value) => value.to_string(),
        _ => return Err(ApiError::invalid("sourceType is invalid")),
    };
    let summary = match object.get("summary").and_then(Value::as_str) {
        Some(value) if !value.is_empty() && value.len() <= 2000 => value.to_string(),
        _ => return Err(ApiError::invalid("summary must be 1..2000 characters")),
    };
    let title = match object.get("title").and_then(Value::as_str) {
        Some(value) if !value.is_empty() && value.len() <= 240 => value.to_string(),
        _ => return Err(ApiError::invalid("title must be 1..240 characters")),
    };
    let tweet_type = if let Some(raw) = object.get("tweetType") {
        if raw.is_null() {
            return Err(ApiError::invalid("tweetType is invalid"));
        }
        match raw.as_str() {
            Some(value) if is_valid_tweet_type(value) => value.to_string(),
            _ => return Err(ApiError::invalid("tweetType is invalid")),
        }
    } else {
        "useful_info".to_string()
    };
    let url: Option<String> = if let Some(raw) = object.get("url") {
        if raw.is_null() {
            None
        } else {
            match raw.as_str() {
                Some(value) => {
                    if !is_valid_url(value) {
                        return Err(ApiError::invalid("url must be a valid URL"));
                    }
                    Some(value.to_string())
                }
                None => return Err(ApiError::invalid("url must be a string or null")),
            }
        }
    } else {
        None
    };

    let packet = state
        .repository()
        .create_source_packet(zyquor_storage::NewSourcePacket {
            account_id,
            facts,
            source_type,
            summary,
            title,
            tweet_type,
            url,
        })
        .await?;
    Ok((StatusCode::CREATED, Json(json!({"packet": packet}))))
}

// --- feedback notebook ---------------------------------------------------------

fn resolve_feedback_dir(feedback_dir: Option<&str>) -> std::path::PathBuf {
    if let Some(dir) = feedback_dir {
        if !dir.is_empty() {
            if std::path::Path::new(dir).is_absolute() {
                return std::path::PathBuf::from(dir);
            }
            return std::env::current_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."))
                .join(dir);
        }
    }
    std::env::current_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."))
        .join("feedback")
}

fn append_notebook_entry(dir: &std::path::Path, heading: &str, lines: &[&str]) {
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join("notebook.md");
    let mut body = format!("## {heading}\n");
    for line in lines {
        body.push_str(line);
        body.push('\n');
    }
    body.push('\n');
    // Best-effort, like the TS fire-and-forget append.
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(format!("{body}\n").as_bytes())
        });
}

fn browser_enable_post(state: &AppState) -> bool {
    match state.browser.lock() {
        Ok(guard) => guard.enable_post,
        Err(poisoned) => poisoned.into_inner().enable_post,
    }
}

// --- draft generation bridge ----------------------------------------------------

fn packet_draft_result_json(result: &zyquor_automation::PacketDraftResult) -> Value {
    let approved = result
        .approved
        .as_ref()
        .map(|(draft, job)| json!({"draft": draft, "job": job}))
        .unwrap_or(Value::Null);
    json!({
        "approved": approved,
        "candidates": result.candidates,
        "draft": result.draft,
        "packet": result.packet,
    })
}

async fn draft_from_packet(
    state: &AppState,
    packet: zyquor_storage::SourcePacket,
    options: zyquor_automation::PacketDraftOptions,
) -> Result<zyquor_automation::PacketDraftResult, ApiError> {
    let db_path = state.db_path.clone();
    let provider = state.generation_provider.clone();
    let deps = state.automation_deps.clone();
    let outcome = tokio::task::spawn_blocking(move || -> std::result::Result<zyquor_automation::PacketDraftResult, zyquor_automation::AutomationError> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().map_err(|error| zyquor_automation::AutomationError::Provider(zyquor_generation::types::GenerationRequestError::transport(error.to_string())))?;
        // Own connection (see ingest.rs): never hold the shared proxy mutex
        // across a network-bound draft generation.
        let repository = zyquor_storage::SqliteRepository::open(&db_path).map_err(|error| zyquor_automation::AutomationError::Provider(zyquor_generation::types::GenerationRequestError::transport(error.to_string())))?;
        runtime.block_on(async { zyquor_automation::draft_from_source_packet(&repository, provider, packet, &deps, options).await })
    })
    .await
    .map_err(|error| ApiError::Internal(format!("draft task failed: {error}")))?;
    outcome.map_err(ApiError::from)
}

#[derive(Deserialize, Default)]
struct DraftBody {
    #[serde(rename = "autoApprove")]
    auto_approve: Option<bool>,
    count: Option<serde_json::Value>,
    mode: Option<String>,
}

async fn create_packet_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<DraftBody>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let repository = state.repository();
    let packet = repository.get_source_packet(&id).await?;
    let Some(packet) = packet else {
        return Err(ApiError::http(404, "Source packet not found"));
    };

    let requested_auto_approve =
        body.auto_approve == Some(true) || body.mode.as_deref() == Some("autopost");
    let auto_approve_allowed = browser_enable_post(&state);
    let auto_approve = requested_auto_approve && auto_approve_allowed;
    if requested_auto_approve && !auto_approve_allowed {
        eprintln!(
            "Auto-approve requested for packet {id} but automated posting is off; drafting for review"
        );
    }

    let count: Option<usize> = match body.count {
        Some(Value::Number(number)) => number.as_u64().and_then(|value| {
            if value > 0 {
                Some(value as usize)
            } else {
                None
            }
        }),
        _ => None,
    };

    let draft_options = zyquor_automation::PacketDraftOptions {
        auto_approve,
        count,
        media_urls: None,
        mode: if auto_approve {
            Some(zyquor_core::types::PostingMode::Autopost)
        } else {
            None
        },
    };

    let result = draft_from_packet(&state, packet, draft_options).await;
    match result {
        Ok(result) => Ok((StatusCode::CREATED, Json(packet_draft_result_json(&result)))),
        Err(error) => {
            if let ApiError::Conflict(message) = &error {
                if message.contains("Draft already exists") {
                    return Err(ApiError::http(409, message.clone()));
                }
            }
            // Generation errors from "returned no draft candidates" archive the packet.
            let message = api_error_message(&error);
            if message.contains("returned no draft candidates") {
                let _ = repository
                    .set_source_packet_status(&id, zyquor_storage::SourcePacketStatus::Archived)
                    .await;
                eprintln!("Archived source packet {id}: generation dropped all candidates");
            }
            Err(error)
        }
    }
}

async fn get_packet_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let existing = repository.get_draft_by_source_packet_id(&id).await?;
    let Some(existing) = existing else {
        return Err(ApiError::http(404, "No draft for this source packet"));
    };
    Ok(Json(
        json!({"draft": existing.draft, "candidates": existing.candidates}),
    ))
}

fn parse_feedback_body(body: &Value) -> Result<Option<String>, ApiError> {
    let object = body
        .as_object()
        .ok_or_else(|| ApiError::invalid("request body must be a JSON object"))?;
    let raw = object.get("feedback");
    let Some(raw) = raw else {
        return Err(ApiError::invalid("feedback is required"));
    };
    if raw.is_null() {
        return Ok(None);
    }
    let text = raw
        .as_str()
        .ok_or_else(|| ApiError::invalid("feedback must be a string or null"))?;
    if text.len() > 2000 {
        return Err(ApiError::invalid("feedback exceeds 2000 characters"));
    }
    Ok(Some(text.to_string()))
}

async fn set_packet_feedback(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let feedback_raw = parse_feedback_body(&body)?;
    let repository = state.repository();
    let packet = repository.get_source_packet(&id).await?;
    if packet.is_none() {
        return Err(ApiError::http(404, "Source packet not found"));
    }
    let feedback = feedback_raw
        .as_deref()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let updated = repository
        .set_source_packet_feedback(&id, feedback.as_deref())
        .await?;
    if let Some(ref text) = feedback {
        let notebook_dir = resolve_feedback_dir(None);
        let heading = format!(
            "[post] {} — {} — {}",
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            updated.tweet_type,
            updated.title
        );
        let source_line = format!(
            "Source: {} · packet {}{}",
            updated.source_type,
            updated.id,
            updated
                .url
                .as_deref()
                .map(|url| format!(" · {url}"))
                .unwrap_or_default()
        );
        append_notebook_entry(
            &notebook_dir,
            &heading,
            &[
                &source_line,
                "",
                "Feedback (saved without regenerating):",
                &format!("> {text}"),
            ],
        );
    }
    Ok(Json(json!({"packet": updated})))
}

async fn regenerate_packet(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let feedback_raw = parse_feedback_body(&body)?;
    let repository = state.repository();
    let packet = repository.get_source_packet(&id).await?;
    let Some(packet) = packet else {
        return Err(ApiError::http(404, "Source packet not found"));
    };
    let _ = packet;
    let feedback = feedback_raw
        .as_deref()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty());
    let Some(ref feedback) = feedback else {
        return Err(ApiError::http(400, "Feedback is required to regenerate"));
    };
    let notebook_dir = resolve_feedback_dir(None);

    let existing_draft = repository.get_draft_by_source_packet_id(&id).await?;
    let mut replaced_job_ids: Vec<String> = Vec::new();
    if let Some(ref existing) = existing_draft {
        let draft_jobs = repository.list_jobs_by_draft_id(&existing.draft.id).await?;
        let history_count = repository
            .count_post_history_by_draft_id(&existing.draft.id)
            .await?;
        let has_posted_job = draft_jobs
            .iter()
            .any(|job| job.status == zyquor_core::types::PostJobStatus::Posted);
        let has_post_history = history_count > 0;
        let has_running_job = draft_jobs
            .iter()
            .any(|job| job.status == zyquor_core::types::PostJobStatus::Running);
        if has_running_job {
            return Err(ApiError::http(
                409,
                "A post job is still running for this draft",
            ));
        }
        if has_posted_job || has_post_history {
            return Err(ApiError::http(
                409,
                "This post was already posted; feedback cannot rewrite it",
            ));
        }
        let approved: Vec<String> = draft_jobs
            .into_iter()
            .filter(|job| job.status == zyquor_core::types::PostJobStatus::Approved)
            .map(|job| job.id)
            .collect();
        if !approved.is_empty() {
            eprintln!(
                "Regenerate {id}: replacing approved job(s) {} for draft {}",
                approved.join(", "),
                existing.draft.id
            );
            replaced_job_ids = approved;
        }
    }

    let _ = repository
        .set_source_packet_feedback(&id, Some(feedback.as_str()))
        .await?;
    let refreshed = repository.get_source_packet(&id).await?;
    let Some(refreshed) = refreshed else {
        return Err(ApiError::http(404, "Source packet not found"));
    };
    let heading = format!(
        "[post] {} — {} — {}",
        chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        refreshed.tweet_type,
        refreshed.title
    );
    let source_line = format!(
        "Source: {} · packet {}{}",
        refreshed.source_type,
        refreshed.id,
        refreshed
            .url
            .as_deref()
            .map(|url| format!(" · {url}"))
            .unwrap_or_default()
    );
    let last_text = existing_draft
        .as_ref()
        .and_then(|draft| {
            draft
                .draft
                .edited_text
                .clone()
                .or_else(|| draft.draft.generated_text.clone())
        })
        .unwrap_or_else(|| "(none)".to_string());
    let feedback_line = format!("> {feedback}");
    append_notebook_entry(
        &notebook_dir,
        &heading,
        &[
            &source_line,
            "",
            "Last generated post:",
            &format!("> {last_text}"),
            "",
            "Feedback:",
            &feedback_line,
        ],
    );

    let options = zyquor_automation::PacketDraftOptions {
        auto_approve: false,
        count: None,
        media_urls: None,
        mode: None,
    };
    let result = draft_from_packet(&state, refreshed.clone(), options).await;
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            eprintln!(
                "Regenerate failed for source packet {id}; keeping existing draft intact: {:?}",
                error
            );
            return Err(error);
        }
    };

    if let Some(ref existing) = existing_draft {
        if existing.draft.id != result.draft.id {
            if let Err(error) = repository.delete_draft(&existing.draft.id).await {
                eprintln!(
                    "Regenerate {id}: failed to remove replaced draft {}: {error}",
                    existing.draft.id
                );
            }
        }
    }

    let new_text = result
        .candidates
        .first()
        .map(|candidate| candidate.text.as_str())
        .unwrap_or("");
    let regen_heading = format!("[regenerated] {}", result.draft.id);
    append_notebook_entry(
        &notebook_dir,
        &regen_heading,
        &["Rewritten after feedback:", &format!("> {new_text}")],
    );

    let mut merged = packet_draft_result_json(&result);
    if !replaced_job_ids.is_empty() {
        merged["replacedJobIds"] = json!(replaced_job_ids);
    }
    let _ = refreshed;
    Ok((StatusCode::CREATED, Json(merged)))
}

async fn delete_packet_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let packet = repository.get_source_packet(&id).await?;
    let Some(packet) = packet else {
        return Err(ApiError::http(404, "Source packet not found"));
    };
    let existing = repository.get_draft_by_source_packet_id(&id).await?;
    if existing.is_none() {
        let current = if packet.status == zyquor_storage::SourcePacketStatus::Drafted {
            repository.reset_source_packet(&id).await?
        } else {
            packet
        };
        return Ok(Json(
            json!({"deleted": false, "draft": Value::Null, "packet": current}),
        ));
    }
    let existing =
        existing.ok_or_else(|| ApiError::http(404, "No draft for this source packet"))?;
    match repository.delete_draft(&existing.draft.id).await {
        Ok(deleted) => {
            let reset = repository.reset_source_packet(&id).await?;
            Ok(Json(
                json!({"candidates": deleted.candidates, "deleted": true, "draft": deleted.draft, "packet": reset}),
            ))
        }
        Err(error) => Err(ApiError::http(409, error.to_string())),
    }
}
