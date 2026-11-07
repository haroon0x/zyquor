//! Draft routes, ported from `apps/api/src/routes/drafts.ts`.

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Map, Value, json};

use crate::errors::{ApiError, HttpError, Issue};
use crate::post_process::trace_post_process_tweet_text;
use crate::state::{AppState, Repository};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/drafts/pending", get(list_pending))
        .route(
            "/drafts/quality-gate-failures",
            get(list_quality_gate_failures),
        )
        .route("/drafts/research", post(research_draft))
        .route("/drafts", post(create_draft))
        .route("/drafts/{id}", get(get_draft).delete(delete_draft))
        .route("/drafts/{id}/evaluate", post(evaluate_draft))
        .route("/drafts/{id}/generate", post(generate_draft))
        .route("/drafts/{id}/select", post(select_candidate))
        .route("/drafts/{id}/approve", post(approve_draft))
}

fn is_valid_iso(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}

fn is_valid_url(value: &str) -> bool {
    url::Url::parse(value).is_ok()
}

fn is_posting_mode(value: &str) -> bool {
    zyquor_core::types::PostingMode::ALL
        .iter()
        .any(|mode| mode.as_str() == value)
}

fn quality_min(state: &AppState) -> f64 {
    state.automation_deps.quality_min
}

fn reply_quality_min() -> f64 {
    zyquor_generation::reply_quality_minimum(&|key: &str| std::env::var(key).ok())
}

async fn account_context(
    repository: &Repository,
    account_id: &str,
) -> Result<zyquor_automation::AccountGenerationContext, ApiError> {
    let account_id = account_id.to_string();
    repository
        .call(move |repo| {
            zyquor_automation::account_generation_context(repo, &account_id).map_err(|error| {
                match error {
                    zyquor_automation::AutomationError::Storage(inner) => inner,
                    other => zyquor_storage::StorageError::Invalid(other.to_string()),
                }
            })
        })
        .await
        .map_err(ApiError::from)
}

fn metadata_str(metadata: &Map<String, Value>, key: &str) -> Option<String> {
    match metadata.get(key) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

fn metadata_bool(metadata: &Map<String, Value>, key: &str) -> bool {
    matches!(metadata.get(key), Some(Value::Bool(true)))
}

fn metadata_count(metadata: &Map<String, Value>) -> usize {
    match metadata.get("count") {
        Some(Value::Number(number)) => number
            .as_f64()
            .filter(|value| value.is_finite() && *value != 0.0)
            .map(|value| value as usize)
            .filter(|value| *value > 0)
            .unwrap_or(1),
        _ => 1,
    }
}

async fn list_pending(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let drafts = state.repository().list_pending_drafts().await?;
    let filtered: Vec<_> = drafts
        .into_iter()
        .filter(|draft| {
            matches!(draft.metadata.get("yolo"), Some(Value::Bool(true)))
                || matches!(draft.metadata.get("lane"), Some(Value::String(lane)) if lane == "batch")
        })
        .collect();
    Ok(Json(json!({"drafts": filtered})))
}

async fn list_quality_gate_failures(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let drafts = repository.list_quality_gate_failed_drafts().await?;
    let mut out = Vec::new();
    for draft in drafts {
        let full = repository.get_draft(&draft.id).await?;
        let (candidates, quality_gate) = match full {
            Some(full) => {
                let quality_gate = full
                    .draft
                    .metadata
                    .get("qualityGate")
                    .cloned()
                    .unwrap_or(Value::Null);
                (full.candidates, quality_gate)
            }
            None => (Vec::new(), Value::Null),
        };
        out.push(json!({"draft": draft, "candidates": candidates, "qualityGate": quality_gate}));
    }
    Ok(Json(json!({"drafts": out})))
}

async fn evaluate_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let Some(existing) = repository.get_draft(&id).await? else {
        return Err(ApiError::Http(HttpError::new(404, "Draft not found")));
    };
    let draft = existing.draft.clone();
    let mut candidates = Vec::new();
    for candidate in &existing.candidates {
        let mut score = candidate.score.clone();
        score.insert(
            "quality".to_string(),
            Value::from(zyquor_generation::score_tweet_quality(&candidate.text)),
        );
        candidates.push(
            repository
                .update_candidate_score(&candidate.id, score)
                .await?,
        );
    }
    Ok(Json(json!({"draft": draft, "candidates": candidates})))
}

fn draft_candidates_response(updated: &zyquor_storage::DraftWithCandidates) -> Value {
    json!({"draft": updated.draft, "candidates": updated.candidates})
}

fn approved_response(
    draft: &zyquor_storage::Draft,
    job: &zyquor_storage::PostJob,
    candidates: &Value,
) -> Value {
    // approveDraft returns {draft, job}; the yolo generate path spreads it
    // with candidates: {draft, job, candidates}.
    json!({"draft": draft, "job": job, "candidates": candidates})
}

async fn generate_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let repository = state.repository();
    let Some(existing) = repository.get_draft(&id).await? else {
        return Err(ApiError::Http(HttpError::new(
            404,
            "Draft not found or already generated",
        )));
    };
    if existing.draft.status != zyquor_core::types::DraftStatus::Created {
        return Err(ApiError::Http(HttpError::new(
            404,
            "Draft not found or already generated",
        )));
    }
    let draft = existing.draft.clone();
    let metadata = draft.metadata.clone();
    let context = account_context(&repository, &draft.account_id).await?;
    let source_packet_id = metadata_str(&metadata, "sourcePacketId");
    let source_packet = match &source_packet_id {
        Some(packet_id) => repository.get_source_packet(packet_id).await?,
        None => None,
    };
    let source_context = source_packet
        .as_ref()
        .map(zyquor_automation::source_tweet_input);
    let count = if metadata_bool(&metadata, "yolo") {
        1
    } else {
        metadata_count(&metadata)
    };

    let mut input = zyquor_generation::types::GenerateDraftCandidatesInput {
        idea: if source_context.is_some() {
            String::new()
        } else {
            draft.source_input.clone()
        },
        context: source_context.clone(),
        count: Some(count),
        preserve_case: true,
        banned_phrases: context.banned_phrases.clone(),
        example_posts: context.example_posts.clone(),
        objective: context.objective.clone(),
        system_prompt_extra: context.system_prompt_extra.clone(),
        system_feedback: context.system_feedback.clone(),
        tone: context.tone.clone(),
        account_knowledge: context.account_knowledge.clone(),
        recent_post_history: context.recent_post_history.clone(),
        ..Default::default()
    };
    if let Some(reply_to) = &draft.reply_to {
        input.tweet_type = Some("reply".to_string());
        input.reply_context = Some(zyquor_generation::types::ReplyContext {
            author_handle: reply_to.author_handle.clone(),
            url: reply_to.url.clone(),
            author_name: reply_to.author_name.clone(),
            text: reply_to.text.clone(),
            other_replies: Vec::new(),
        });
    } else if let Some(tweet_type) = metadata_str(&metadata, "tweetType") {
        input.tweet_type = Some(
            zyquor_automation::normalize_tweet_type(&tweet_type)
                .as_str()
                .to_string(),
        );
    }
    if let Some(packet) = &source_packet {
        if let Some(feedback) = &packet.feedback {
            input.feedback = Some(feedback.clone());
        }
    }

    let generated = state
        .generation_provider
        .generate_draft_candidates(&input)
        .await
        .map_err(ApiError::from)?;

    let provider_name = state.generation_provider_name();
    let new_candidates: Vec<zyquor_storage::NewCandidate> = generated
        .iter()
        .map(|candidate| {
            let preserve_case = candidate.provider == provider_name;
            let normalized =
                trace_post_process_tweet_text("select-candidate", &candidate.text, preserve_case);
            let text = match &source_packet {
                Some(packet) => zyquor_automation::with_required_source_url(&normalized, packet),
                None => normalized,
            };
            let quality = zyquor_generation::score_tweet_quality(&text);
            let mut score = Map::new();
            score.insert(
                "provider".to_string(),
                Value::String(candidate.provider.clone()),
            );
            score.insert("model".to_string(), Value::String(candidate.model.clone()));
            score.insert("rank".to_string(), Value::from(candidate.rank as i64));
            score.insert("quality".to_string(), Value::from(quality));
            zyquor_storage::NewCandidate { text, score }
        })
        .collect();

    let updated = repository
        .save_draft_candidates(&draft.id, new_candidates)
        .await?;

    if metadata_bool(&metadata, "yolo") {
        let mut sorted = updated.candidates.clone();
        sorted.sort_by(|a, b| {
            let qa = a
                .score
                .get("quality")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MIN);
            let qb = b
                .score
                .get("quality")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MIN);
            let ra = a
                .score
                .get("rank")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX);
            let rb = b
                .score
                .get("rank")
                .and_then(Value::as_i64)
                .unwrap_or(i64::MAX);
            qb.cmp(&qa).then_with(|| ra.cmp(&rb))
        });
        let top_candidate = sorted.first();
        let quality_min = quality_min(&state);
        let best_candidate = sorted.iter().find(|candidate| {
            zyquor_generation::passes_tweet_quality_floor(&candidate.text, quality_min)
        });
        let best_quality = top_candidate
            .and_then(|candidate| candidate.score.get("quality").and_then(Value::as_i64))
            .map(|value| value as f64)
            .unwrap_or(f64::NEG_INFINITY);
        let slop_phrase = top_candidate.and_then(|candidate| {
            let lower = candidate.text.to_lowercase();
            zyquor_core::AI_SLOP_PHRASES
                .iter()
                .find(|phrase| lower.contains(*phrase))
                .map(|phrase| (*phrase).to_string())
        });
        if best_candidate.is_none() || slop_phrase.is_some() {
            let reason = if slop_phrase.is_some() {
                "ai_slop_phrase_detected"
            } else {
                "all_below_quality_floor"
            };
            let mut gate = Map::new();
            gate.insert(
                "bestQuality".to_string(),
                if best_quality.is_finite() {
                    Value::from(best_quality)
                } else {
                    Value::Null
                },
            );
            gate.insert(
                "bestCandidateId".to_string(),
                top_candidate
                    .map(|c| Value::String(c.id.clone()))
                    .unwrap_or(Value::Null),
            );
            gate.insert("threshold".to_string(), Value::from(quality_min));
            gate.insert(
                "slopPhrase".to_string(),
                slop_phrase
                    .clone()
                    .map(Value::String)
                    .unwrap_or(Value::Null),
            );
            gate.insert(
                "rejectedAt".to_string(),
                Value::String(
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ),
            );
            gate.insert("reason".to_string(), Value::String(reason.to_string()));
            let mut new_metadata = metadata.clone();
            new_metadata.insert("qualityGate".to_string(), Value::Object(gate));
            repository
                .update_draft_metadata(&draft.id, new_metadata)
                .await?;
            let fresh = repository.get_draft(&draft.id).await?;
            return Ok((
                StatusCode::CREATED,
                Json(json!({
                    "draft": fresh.map(|f| f.draft),
                    "candidates": updated.candidates,
                    "reason": reason,
                    "bestQuality": if best_quality.is_finite() { Value::from(best_quality) } else { Value::Null },
                    "threshold": quality_min,
                    "slopPhrase": slop_phrase,
                })),
            ));
        }
        if let Some(best) = best_candidate {
            let selected_text = best.text.clone();
            if !selected_text.is_empty() {
                let mode_text = if metadata_bool(&metadata, "autopost") {
                    "autopost".to_string()
                } else if let Some(mode) =
                    metadata_str(&metadata, "mode").filter(|mode| is_posting_mode(mode))
                {
                    mode
                } else {
                    "prepare_only".to_string()
                };
                let mode: zyquor_core::types::PostingMode = mode_text
                    .parse()
                    .map_err(|_| ApiError::Internal("invalid posting mode".to_string()))?;
                let preserve_case = best
                    .score
                    .get("provider")
                    .and_then(Value::as_str)
                    .is_some_and(|provider| provider == provider_name);
                let edited_text =
                    trace_post_process_tweet_text("manual-select", &selected_text, preserve_case);
                let scheduled_for = metadata_str(&metadata, "scheduleStart");
                let (approved_draft, job) = repository
                    .approve_draft(zyquor_storage::ApproveDraft {
                        draft_id: draft.id.clone(),
                        edited_text,
                        mode: Some(mode),
                        scheduled_for,
                        reply_to: draft.reply_to.clone(),
                        reply_to_url: None,
                    })
                    .await?;
                let candidates_value = json!(updated.candidates);
                return Ok((
                    StatusCode::CREATED,
                    Json(approved_response(&approved_draft, &job, &candidates_value)),
                ));
            }
        }
    }

    Ok((
        StatusCode::CREATED,
        Json(draft_candidates_response(&updated)),
    ))
}

struct ResearchInput {
    account_id: String,
    idea: String,
    count: Option<usize>,
    tweet_type: Option<String>,
    reply_to_url: Option<String>,
    yolo: bool,
    autopost: bool,
}

fn parse_create_draft(value: &Value) -> Result<ResearchInput, ApiError> {
    // createDraftRequestSchema (accountId, idea, count 1..5, tweetType, replyToUrl url, yolo, autopost).
    // Also used for POST /drafts/research (same schema).
    let obj = value.as_object().ok_or_else(|| {
        ApiError::invalid_with_issues(vec![Issue {
            path: String::new(),
            message: "expected an object".to_string(),
        }])
    })?;
    let mut issues = Vec::new();
    let account_id = match obj.get("accountId") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            String::new()
        }
        _ => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let idea = match obj.get("idea") {
        Some(Value::String(text)) if !text.is_empty() && text.len() <= 4000 => text.clone(),
        Some(Value::String(text)) => {
            issues.push(Issue {
                path: "idea".to_string(),
                message: if text.is_empty() {
                    "String must contain at least 1 character(s)".to_string()
                } else {
                    "String must contain at most 4000 character(s)".to_string()
                },
            });
            String::new()
        }
        _ => {
            issues.push(Issue {
                path: "idea".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let count = match obj.get("count") {
        None => None,
        Some(Value::Number(number)) => match number.as_i64() {
            Some(count)
                if number.as_f64().is_some_and(|f| f.fract() == 0.0)
                    && (1..=5).contains(&count) =>
            {
                Some(count as usize)
            }
            _ => {
                issues.push(Issue {
                    path: "count".to_string(),
                    message: "Number must be an integer between 1 and 5".to_string(),
                });
                None
            }
        },
        Some(_) => {
            issues.push(Issue {
                path: "count".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    let tweet_type = match obj.get("tweetType") {
        None => None,
        Some(Value::String(text)) => {
            if zyquor_core::types::TweetType::ALL
                .iter()
                .any(|t| t.as_str() == text)
            {
                Some(text.clone())
            } else {
                issues.push(Issue {
                    path: "tweetType".to_string(),
                    message: "Invalid enum value".to_string(),
                });
                None
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "tweetType".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    let reply_to_url = match obj.get("replyToUrl") {
        None => None,
        Some(Value::String(text)) => {
            if is_valid_url(text) {
                Some(text.clone())
            } else {
                issues.push(Issue {
                    path: "replyToUrl".to_string(),
                    message: "Invalid url".to_string(),
                });
                None
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "replyToUrl".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    let yolo = match obj.get("yolo") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            issues.push(Issue {
                path: "yolo".to_string(),
                message: "Required".to_string(),
            });
            false
        }
    };
    let autopost = match obj.get("autopost") {
        None => false,
        Some(Value::Bool(value)) => *value,
        Some(_) => {
            issues.push(Issue {
                path: "autopost".to_string(),
                message: "Required".to_string(),
            });
            false
        }
    };
    if issues.is_empty() {
        Ok(ResearchInput {
            account_id,
            idea,
            count,
            tweet_type,
            reply_to_url,
            yolo,
            autopost,
        })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

fn parse_published_millis(text: &str) -> Option<i64> {
    if let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(text) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(parsed) = chrono::DateTime::parse_from_str(text, "%a, %d %b %Y %H:%M:%S %Z") {
        return Some(parsed.timestamp_millis());
    }
    let naive = chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%dT%H:%M:%S").ok()?;
    Some(
        chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc)
            .timestamp_millis(),
    )
}

fn raw_score_map(provider: &str, model: &str, rank: usize, quality: i64) -> Map<String, Value> {
    let mut score = Map::new();
    score.insert("provider".to_string(), Value::String(provider.to_string()));
    score.insert("model".to_string(), Value::String(model.to_string()));
    score.insert("rank".to_string(), Value::from(rank as i64));
    score.insert("quality".to_string(), Value::from(quality));
    score
}

fn candidate_score_map(
    provider: &str,
    model: &str,
    rank: usize,
    quality: i64,
    packet: &zyquor_storage::SourcePacket,
) -> Map<String, Value> {
    let mut score = raw_score_map(provider, model, rank, quality);
    score.insert(
        "sourcePacketId".to_string(),
        Value::String(packet.id.clone()),
    );
    score.insert(
        "sourceType".to_string(),
        Value::String(packet.source_type.clone()),
    );
    score.insert(
        "tweetType".to_string(),
        Value::String(packet.tweet_type.clone()),
    );
    score
}

async fn assert_single_draft_per_topic(
    repository: &Repository,
    account_id: &str,
    packet_id: &str,
    title: &str,
    packet_created_at: &str,
) -> Result<(), ApiError> {
    let packet_ms = chrono::DateTime::parse_from_rfc3339(packet_created_at)
        .map(|parsed| parsed.timestamp_millis())
        .unwrap_or_else(|_| chrono::Utc::now().timestamp_millis());
    let cutoff_millis = packet_ms - 7 * 24 * 60 * 60 * 1000;
    let cutoff = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(cutoff_millis)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();
    let drafts = repository.list_drafts(Some(account_id)).await?;
    let packets = repository
        .list_source_packets(Some(account_id), None, None)
        .await?;
    let title_by_packet: std::collections::HashMap<String, String> = packets
        .iter()
        .map(|packet| (packet.id.clone(), packet.title.clone()))
        .collect();
    for draft in &drafts {
        if draft.status == zyquor_core::types::DraftStatus::Archived
            || draft.created_at.as_str() < cutoff.as_str()
        {
            continue;
        }
        let Some(source_packet_id) = draft.metadata.get("sourcePacketId").and_then(Value::as_str)
        else {
            continue;
        };
        if source_packet_id == packet_id {
            continue;
        }
        let Some(existing_title) = title_by_packet.get(source_packet_id) else {
            continue;
        };
        if zyquor_automation::has_topic_overlap(title, std::slice::from_ref(existing_title)) {
            return Err(ApiError::Http(HttpError::new(
                409,
                format!("Draft already exists for this topic ({title})"),
            )));
        }
    }
    Ok(())
}

struct ManualPacketResult {
    value: Value,
}

async fn draft_from_packet_manual(
    state: &AppState,
    repository: &Repository,
    packet: zyquor_storage::SourcePacket,
    auto_approve: bool,
    count: Option<usize>,
    mode: Option<zyquor_core::types::PostingMode>,
) -> Result<ManualPacketResult, ApiError> {
    assert_single_draft_per_topic(
        repository,
        &packet.account_id,
        &packet.id,
        &packet.title,
        &packet.created_at,
    )
    .await?;

    let provider_name = state.generation_provider_name();
    // generateCandidatesForPacket: account context + source context.
    let context = account_context(repository, &packet.account_id).await?;
    let tweet_context = zyquor_automation::source_tweet_input(&packet);
    if !zyquor_automation::has_enough_source_context(&packet.title, &packet.summary, &packet.facts)
    {
        // `generateCandidatesForPacket` returns [] here; the draft flow then
        // records no candidates (or a quality gate when autoApprove).
    }
    let input = zyquor_generation::types::GenerateDraftCandidatesInput {
        idea: packet.title.clone(),
        context: Some(tweet_context),
        count: count.or(Some(1)),
        preserve_case: true,
        banned_phrases: context.banned_phrases.clone(),
        example_posts: context.example_posts.clone(),
        objective: context.objective.clone(),
        system_prompt_extra: context.system_prompt_extra.clone(),
        system_feedback: context.system_feedback.clone(),
        tone: context.tone.clone(),
        account_knowledge: context.account_knowledge.clone(),
        recent_post_history: context.recent_post_history.clone(),
        feedback: packet.feedback.clone(),
        tweet_type: Some(
            zyquor_automation::normalize_tweet_type(&packet.tweet_type)
                .as_str()
                .to_string(),
        ),
        ..Default::default()
    };
    let mut generated = if zyquor_automation::has_enough_source_context(
        &packet.title,
        &packet.summary,
        &packet.facts,
    ) {
        state
            .generation_provider
            .generate_draft_candidates(&input)
            .await
            .map_err(ApiError::from)?
    } else {
        Vec::new()
    };
    if packet.source_type == "x-feed" {
        let quality_min = quality_min(state);
        generated.retain(|candidate| {
            zyquor_generation::passes_tweet_quality_floor(
                &zyquor_generation::format_tweet_text(&candidate.text),
                quality_min,
            )
        });
        if generated.is_empty() {
            return Err(ApiError::Generation(format!(
                "{provider_name} returned no draft candidates"
            )));
        }
    }

    let normalized: Vec<zyquor_generation::types::GeneratedDraftCandidate> = generated
        .into_iter()
        .map(|mut candidate| {
            let formatted = if candidate.provider == provider_name {
                zyquor_generation::format_tweet_text(&candidate.text)
            } else {
                zyquor_generation::post_process_tweet_text(&candidate.text)
            };
            let text = zyquor_automation::with_required_source_url(&formatted, &packet);
            candidate.quality = zyquor_generation::score_tweet_quality(&text);
            candidate.text = text;
            candidate
        })
        .collect();

    let history = if auto_approve {
        repository.list_post_history().await?
    } else {
        Vec::new()
    };
    let quality_min = quality_min(state);

    // Validate + sort (mirrors draft.rs).
    let mut indexed: Vec<(usize, zyquor_automation::PostQualityResult, bool)> = normalized
        .iter()
        .enumerate()
        .map(|(index, candidate)| {
            (
                index,
                zyquor_automation::validate_source_post_quality(&candidate.text, &packet, &history),
                zyquor_generation::passes_tweet_quality_floor(&candidate.text, quality_min),
            )
        })
        .collect();
    indexed.sort_by(|a, b| {
        let qa = normalized[a.0].quality;
        let qb = normalized[b.0].quality;
        qb.cmp(&qa)
            .then_with(|| normalized[a.0].rank.cmp(&normalized[b.0].rank))
    });
    let passing: Vec<(usize, zyquor_automation::PostQualityResult, bool)> = indexed
        .iter()
        .filter(|(_, validation, generated)| validation.ok && *generated)
        .cloned()
        .collect();
    let approved_candidate = passing.first().cloned();

    let mut source_metadata = Map::new();
    source_metadata.insert(
        "sourcePacketId".to_string(),
        Value::String(packet.id.clone()),
    );
    source_metadata.insert(
        "sourceType".to_string(),
        Value::String(packet.source_type.clone()),
    );
    source_metadata.insert(
        "tweetType".to_string(),
        Value::String(packet.tweet_type.clone()),
    );

    if auto_approve {
        if let Some((approved_index, validation, _)) = approved_candidate {
            let approved = &normalized[approved_index];
            let mut metadata = source_metadata.clone();
            metadata.insert(
                "generatedScore".to_string(),
                Value::Object(raw_score_map(
                    &approved.provider,
                    &approved.model,
                    approved.rank,
                    approved.quality,
                )),
            );
            let created = repository
                .create_draft(zyquor_storage::NewDraft {
                    account_id: packet.account_id.clone(),
                    source_input: article_tweet_idea(&packet),
                    candidates: Vec::new(),
                    reply_to: None,
                    reply_to_url: None,
                    metadata,
                })
                .await?;
            let approved_draft_id = created.draft.id.clone();
            let marked_packet = match repository.mark_source_packet_drafted(&packet.id).await {
                Ok(marked) => marked,
                Err(error) => {
                    let _ = repository.delete_draft(&approved_draft_id).await;
                    return Err(ApiError::from(error));
                }
            };
            let mode = mode.unwrap_or(zyquor_core::types::PostingMode::Autopost);
            match repository
                .approve_draft(zyquor_storage::ApproveDraft {
                    draft_id: approved_draft_id.clone(),
                    edited_text: validation.text.clone(),
                    mode: Some(mode),
                    scheduled_for: None,
                    reply_to: None,
                    reply_to_url: None,
                })
                .await
            {
                Ok((draft, job)) => {
                    return Ok(ManualPacketResult {
                        value: json!({
                            "approved": {"draft": draft, "job": job},
                            "candidates": created.candidates,
                            "draft": created.draft,
                            "packet": marked_packet,
                        }),
                    });
                }
                Err(error) => {
                    let _ = repository.delete_draft(&approved_draft_id).await;
                    let _ = repository.reset_source_packet(&packet.id).await;
                    return Err(ApiError::from(error));
                }
            }
        }
    }

    if auto_approve {
        let reason: Option<&str> = if normalized.is_empty() {
            Some("no_candidates_generated")
        } else if passing.is_empty() {
            Some("all_below_quality_floor")
        } else {
            None
        };
        let mut gate = Map::new();
        gate.insert("threshold".to_string(), Value::from(quality_min));
        gate.insert(
            "reason".to_string(),
            reason
                .map(|value| Value::String(value.to_string()))
                .unwrap_or(Value::Null),
        );
        gate.insert(
            "candidates".to_string(),
            Value::Array(
                normalized
                    .iter()
                    .map(|candidate| {
                        json!({
                            "text": candidate.text,
                            "score": candidate_score_map(&candidate.provider, &candidate.model, candidate.rank, candidate.quality, &packet),
                            "passedQualityMin": zyquor_generation::passes_tweet_quality_floor(&candidate.text, quality_min),
                            "reasons": zyquor_automation::validate_source_post_quality(&candidate.text, &packet, &history).reasons,
                        })
                    })
                    .collect(),
            ),
        );
        source_metadata.insert("qualityGate".to_string(), Value::Object(gate));
    }

    let draft_candidates: Vec<zyquor_storage::NewCandidate> = normalized
        .iter()
        .map(|candidate| zyquor_storage::NewCandidate {
            text: candidate.text.clone(),
            score: candidate_score_map(
                &candidate.provider,
                &candidate.model,
                candidate.rank,
                candidate.quality,
                &packet,
            ),
        })
        .collect();
    let created = repository
        .create_draft(zyquor_storage::NewDraft {
            account_id: packet.account_id.clone(),
            source_input: article_tweet_idea(&packet),
            candidates: draft_candidates,
            reply_to: None,
            reply_to_url: None,
            metadata: source_metadata,
        })
        .await?;
    match repository.mark_source_packet_drafted(&packet.id).await {
        Ok(marked_packet) => Ok(ManualPacketResult {
            value: json!({
                "approved": Value::Null,
                "candidates": created.candidates,
                "draft": created.draft,
                "packet": marked_packet,
            }),
        }),
        Err(error) => {
            let _ = repository.delete_draft(&created.draft.id).await;
            Err(ApiError::from(error))
        }
    }
}

fn article_tweet_idea(packet: &zyquor_storage::SourcePacket) -> String {
    // Mirrors `articleTweetIdea` in context.ts (cleanSentence pieces are
    // approximated with the packet fields; the packet content is already the
    // cleaned form the storage layer keeps).
    let title = packet.title.clone();
    let mut facts: Vec<String> = Vec::new();
    for fact in &packet.facts {
        if !facts.contains(fact) && fact.to_lowercase() != title.to_lowercase() {
            facts.push(fact.clone());
        }
    }
    facts.truncate(5);
    let mut parts: Vec<String> = Vec::new();
    if !title.is_empty() {
        parts.push(format!("Title: {title}"));
    }
    if let Some(url) = &packet.url {
        parts.push(format!("URL: {url}"));
    }
    parts.push(format!("Summary: {}", packet.summary));
    if !facts.is_empty() {
        parts.push(format!(
            "Facts:\n{}",
            facts
                .iter()
                .map(|fact| format!("- {fact}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    parts.join("\n")
}

async fn research_draft(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let input = parse_create_draft(&body)?;
    if input.reply_to_url.is_some() {
        return Err(ApiError::Http(HttpError::new(
            400,
            "Research drafts do not support reply targets",
        )));
    }
    let adapter = state
        .source_adapters
        .get("news")
        .ok_or_else(|| ApiError::Http(HttpError::new(503, "Topic search is unavailable")))?;
    let mut config = Map::new();
    config.insert("maxItems".to_string(), Value::from(30));
    config.insert("topic".to_string(), Value::String(input.idea.clone()));
    let items = adapter
        .fetch(&config)
        .await
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    let now = chrono::Utc::now().timestamp_millis();
    let max_age_ms = 48 * 60 * 60 * 1000i64;
    let mut filtered: Vec<(zyquor_adapters::SourceItem, i64)> = Vec::new();
    for item in items {
        let raw = item
            .metadata
            .get("published")
            .or_else(|| item.metadata.get("pubDate"))
            .and_then(Value::as_str);
        let Some(raw) = raw else { continue };
        let Some(published) = parse_published_millis(raw) else {
            continue;
        };
        let age = now - published;
        if age >= -5 * 60 * 1000 && age <= max_age_ms {
            filtered.push((item, published));
        }
    }
    filtered.sort_by_key(|entry| std::cmp::Reverse(entry.1));

    let repository = state.repository();
    for (item, _) in filtered {
        if !item.url.is_empty()
            && repository
                .has_post_history_source_url(&input.account_id, &item.url)
                .await?
        {
            continue;
        }
        if !item.url.is_empty()
            && repository
                .get_source_packet_by_url(&item.url, Some(&input.account_id))
                .await?
                .is_some()
        {
            continue;
        }
        let fields = zyquor_automation::packet_fields_from_item(&item);
        if !zyquor_automation::has_enough_source_context(
            &fields.title,
            &fields.summary,
            &fields.facts,
        ) {
            continue;
        }
        let packet = repository
            .create_source_packet(zyquor_storage::NewSourcePacket {
                account_id: input.account_id.clone(),
                source_type: "news".to_string(),
                title: fields.title.clone(),
                url: if item.url.is_empty() {
                    None
                } else {
                    Some(item.url.clone())
                },
                summary: fields.summary.clone(),
                facts: fields.facts.clone(),
                tweet_type: input
                    .tweet_type
                    .clone()
                    .unwrap_or_else(|| "useful_info".to_string()),
            })
            .await?;
        let auto_approve = input.yolo;
        let count = input.count.unwrap_or(1);
        let mode = if input.yolo {
            Some(if input.autopost {
                zyquor_core::types::PostingMode::Autopost
            } else {
                zyquor_core::types::PostingMode::PrepareOnly
            })
        } else {
            None
        };
        match draft_from_packet_manual(
            &state,
            &repository,
            packet.clone(),
            auto_approve,
            Some(count),
            mode,
        )
        .await
        {
            Ok(result) => return Ok((StatusCode::CREATED, Json(result.value))),
            Err(error) => {
                let _ = repository.delete_source_packet(&packet.id).await;
                return Err(error);
            }
        }
    }

    Err(ApiError::Http(HttpError::new(
        404,
        "No unused source from the last 48 hours matched this topic",
    )))
}

async fn create_draft(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let raw_reply_to_url = body.get("replyToUrl").cloned();
    let reply_to = match &raw_reply_to_url {
        Some(Value::String(text)) => zyquor_core::parse_reply_target_url(text),
        _ => None,
    };
    if raw_reply_to_url.is_some() && reply_to.is_none() {
        // TS: `rawReplyToUrl !== undefined && !replyTo` — null counts as defined.
        return Err(ApiError::Http(HttpError::new(
            400,
            "replyToUrl must be a valid x.com or twitter.com post URL",
        )));
    }
    let input = parse_create_draft(&body)?;
    let mut metadata = Map::new();
    metadata.insert("yolo".to_string(), Value::Bool(input.yolo));
    metadata.insert("autopost".to_string(), Value::Bool(input.autopost));
    metadata.insert(
        "count".to_string(),
        Value::from(input.count.unwrap_or(1) as i64),
    );
    if reply_to.is_some() {
        metadata.insert("tweetType".to_string(), Value::String("reply".to_string()));
    } else if let Some(tweet_type) = &input.tweet_type {
        metadata.insert("tweetType".to_string(), Value::String(tweet_type.clone()));
    }
    // TS stores `tweetType: replyTo ? "reply" : input.tweetType` — a missing
    // tweetType stays undefined. Rust metadata keeps the absent key absent.
    let repository = state.repository();
    let result = repository
        .create_draft(zyquor_storage::NewDraft {
            account_id: input.account_id.clone(),
            source_input: input.idea.clone(),
            candidates: Vec::new(),
            reply_to: reply_to.clone(),
            reply_to_url: input.reply_to_url.clone(),
            metadata,
        })
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"draft": result.draft, "candidates": result.candidates})),
    ))
}

async fn get_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let draft = state.repository().get_draft(&id).await?;
    match draft {
        Some(draft) => Ok(Json(
            json!({"draft": draft.draft, "candidates": draft.candidates}),
        )),
        None => Err(ApiError::Http(HttpError::new(404, "Draft not found"))),
    }
}

async fn delete_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    if repository.get_draft(&id).await?.is_none() {
        return Err(ApiError::Http(HttpError::new(404, "Draft not found")));
    }
    let deleted = repository.delete_draft(&id).await?;
    Ok(Json(json!({"draft": deleted})))
}

struct SelectInput {
    candidate_id: String,
    edited_text: Option<String>,
}

fn parse_select(value: &Value) -> Result<SelectInput, ApiError> {
    let obj = value.as_object().ok_or_else(|| {
        ApiError::invalid_with_issues(vec![Issue {
            path: String::new(),
            message: "expected an object".to_string(),
        }])
    })?;
    let mut issues = Vec::new();
    let candidate_id = match obj.get("candidateId") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "candidateId".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            String::new()
        }
        _ => {
            issues.push(Issue {
                path: "candidateId".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let edited_text = match obj.get("editedText") {
        None => None,
        Some(Value::String(text)) if !text.is_empty() => Some(text.clone()),
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "editedText".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            None
        }
        Some(_) => {
            issues.push(Issue {
                path: "editedText".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    if issues.is_empty() {
        Ok(SelectInput {
            candidate_id,
            edited_text,
        })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

async fn select_candidate(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let input = parse_select(&body)?;
    let edited_text = input
        .edited_text
        .as_deref()
        .map(|text| trace_post_process_tweet_text("edit-draft", text, false));
    let result = state
        .repository()
        .select_candidate(&id, &input.candidate_id, edited_text.as_deref())
        .await?;
    Ok(Json(
        json!({"draft": result.draft, "candidates": result.candidates}),
    ))
}

struct ApproveInput {
    edited_text: String,
    mode: Option<zyquor_core::types::PostingMode>,
    scheduled_for: Option<Option<String>>,
    screened: Option<bool>,
}

fn parse_approve(value: &Value) -> Result<ApproveInput, ApiError> {
    let obj = value.as_object().ok_or_else(|| {
        ApiError::invalid_with_issues(vec![Issue {
            path: String::new(),
            message: "expected an object".to_string(),
        }])
    })?;
    let mut issues = Vec::new();
    let edited_text = match obj.get("editedText") {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "editedText".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            String::new()
        }
        _ => {
            issues.push(Issue {
                path: "editedText".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let mode = match obj.get("mode") {
        None => None,
        Some(Value::String(text)) => {
            if is_posting_mode(text) {
                Some(
                    text.parse()
                        .map_err(|_| ApiError::Internal("invalid posting mode".to_string()))?,
                )
            } else {
                issues.push(Issue {
                    path: "mode".to_string(),
                    message: "Invalid enum value".to_string(),
                });
                None
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "mode".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    let scheduled_for = match obj.get("scheduledFor") {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(text)) => {
            if is_valid_iso(text) {
                Some(Some(text.clone()))
            } else {
                issues.push(Issue {
                    path: "scheduledFor".to_string(),
                    message: "String must be a valid ISO 8601 date".to_string(),
                });
                None
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "scheduledFor".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    let screened = match obj.get("screened") {
        None => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => {
            issues.push(Issue {
                path: "screened".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    if issues.is_empty() {
        Ok(ApproveInput {
            edited_text,
            mode,
            scheduled_for,
            screened,
        })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

fn features_value(text: &str) -> Value {
    let features = zyquor_automation::analyze_post_features(text);
    json!({
        "chars": features.chars,
        "words": features.words,
        "hasDigits": features.has_digits,
        "endsWithQuestion": features.ends_with_question,
        "linkCount": features.link_count,
        "hashtagCount": features.hashtag_count,
        "opener": features.opener,
    })
}

async fn approve_draft(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let input = parse_approve(&body)?;
    let scheduled_for_text: Option<String> = input.scheduled_for.clone().flatten();
    if input.mode == Some(zyquor_core::types::PostingMode::Scheduled)
        && scheduled_for_text.is_none()
    {
        return Err(ApiError::Http(HttpError::new(
            400,
            "scheduledFor is required for scheduled jobs",
        )));
    }
    let repository = state.repository();
    let Some(existing) = repository.get_draft(&id).await? else {
        return Err(ApiError::Http(HttpError::new(404, "Draft not found")));
    };
    // `POST /drafts/{id}/select`/`approve` return the DraftWithCandidates shape
    // in TS (`{draft, candidates}` for select; `{draft, job}` for approve).
    // `getDraft` here also returns `{draft, candidates}` in TS.
    let selected_candidate = existing
        .candidates
        .iter()
        .find(|candidate| candidate.selected);
    let preserve_case = selected_candidate
        .and_then(|candidate| candidate.score.get("provider").and_then(Value::as_str))
        .is_some_and(|provider| provider == state.generation_provider_name());
    let mut approved_text =
        trace_post_process_tweet_text("update-draft", &input.edited_text, preserve_case);

    if input.screened == Some(true) {
        let mut screen_reasons: Vec<String> = Vec::new();
        let is_reply = matches!(existing.draft.metadata.get("tweetType"), Some(Value::String(t)) if t == "reply");
        let screen_floor = if is_reply {
            reply_quality_min()
        } else {
            quality_min(&state)
        };
        if approved_text.len() > 279 {
            screen_reasons.push(format!("too_long ({} chars > 279)", approved_text.len()));
        }
        if is_reply && zyquor_generation::is_interrogation_dodge_reply(&approved_text) {
            screen_reasons.push("reply_interrogation_dodge".to_string());
        }
        if !zyquor_generation::is_clean_tweet_text(&approved_text) {
            screen_reasons.push("unclean text (links, spam markers, or slop phrases)".to_string());
        }
        if !zyquor_generation::passes_tweet_quality_floor(&approved_text, screen_floor) {
            screen_reasons.push(format!(
                "quality {} below floor {screen_floor}",
                zyquor_generation::score_tweet_quality(&approved_text)
            ));
        }
        if !screen_reasons.is_empty() {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({
                    "error": format!("Approval screen failed: {}", screen_reasons.join("; ")),
                    "screenFailed": screen_reasons,
                })),
            ));
        }
    }

    if input.mode == Some(zyquor_core::types::PostingMode::Autopost) {
        let source_packet_id = metadata_str(&existing.draft.metadata, "sourcePacketId");
        let source_packet = match &source_packet_id {
            Some(packet_id) => repository.get_source_packet(packet_id).await?,
            None => None,
        };
        let source_quality = match &source_packet {
            Some(packet) => Some(zyquor_automation::validate_source_post_quality(
                &approved_text,
                packet,
                &repository.list_post_history().await?,
            )),
            None => None,
        };
        let quality_text = source_quality
            .as_ref()
            .map(|quality| quality.text.clone())
            .unwrap_or_else(|| approved_text.clone());
        let generated_required = metadata_bool(&existing.draft.metadata, "yolo")
            || existing.draft.metadata.contains_key("generatedScore");
        let generated_quality = if generated_required {
            Some(zyquor_automation::validate_generated_post_quality(
                &quality_text,
                quality_min(&state),
            ))
        } else {
            None
        };
        let mut reasons: Vec<String> = Vec::new();
        if let Some(quality) = &source_quality {
            reasons.extend(quality.reasons.clone());
        }
        if let Some(quality) = &generated_quality {
            reasons.extend(quality.reasons.clone());
        }
        let quality_min = quality_min(&state);
        let selected_score = selected_candidate
            .and_then(|candidate| {
                candidate
                    .score
                    .get("quality")
                    .and_then(Value::as_i64)
                    .map(|value| value as f64)
            })
            .unwrap_or(f64::NAN);
        let operator_edited = match selected_candidate {
            Some(candidate) => approved_text.trim() != candidate.text.trim(),
            None => true,
        };
        if selected_score.is_finite() && selected_score < quality_min && !operator_edited {
            reasons.push(format!(
                "generated_score_below_floor ({selected_score} < {quality_min}); edit the text or regenerate"
            ));
        }
        if !reasons.is_empty() {
            let mut deduped: Vec<String> = Vec::new();
            for reason in reasons {
                if !deduped.contains(&reason) {
                    deduped.push(reason);
                }
            }
            return Ok((
                StatusCode::CONFLICT,
                Json(
                    json!({"error": format!("Autopost quality gate failed: {}", deduped.join(", "))}),
                ),
            ));
        }
        approved_text = quality_text;
    }

    let mut new_metadata = existing.draft.metadata.clone();
    new_metadata.insert("features".to_string(), features_value(&approved_text));
    repository.update_draft_metadata(&id, new_metadata).await?;

    let (draft, job) = repository
        .approve_draft(zyquor_storage::ApproveDraft {
            draft_id: id.clone(),
            edited_text: approved_text,
            mode: input.mode,
            scheduled_for: scheduled_for_text,
            reply_to: existing.draft.reply_to.clone(),
            reply_to_url: None,
        })
        .await?;
    // TS `approveDraft` result is `{draft, job}` with a 201.
    Ok((
        StatusCode::CREATED,
        Json(json!({"draft": draft, "job": job})),
    ))
}
