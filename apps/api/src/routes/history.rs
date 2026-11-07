//! History routes, ported from `apps/api/src/routes/history.ts`.

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use crate::errors::{ApiError, HttpError};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/history", get(get_history))
        .route("/history/analysis", get(get_analysis))
        .route("/history/{id}/delete", post(delete_history_post))
}

async fn get_history(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    crate::history::purge_expired_post_history(&repository).await?;
    let history = repository.list_post_history().await?;
    Ok(Json(json!({"history": history})))
}

#[derive(Debug, Default, Deserialize)]
struct AnalysisQuery {
    #[serde(default, rename = "accountId")]
    account_id: Option<String>,
    #[serde(default, rename = "sinceHours")]
    since_hours: Option<String>,
}

// --- `analyzePostHistory` port (inlined from `packages/core/src/index.ts`) ---

const HISTORY_GENERIC_PATTERNS: &[&str] = &[
    r"(?i)\bai is changing\b",
    r"(?i)\bgame changer\b",
    r"(?i)\bhere'?s why\b",
    r"(?i)\bin today'?s (fast-paced )?world\b",
    r"(?i)\bthis changes everything\b",
    r"(?i)\bunlock\b",
    r"(?i)\bworth paying attention\b",
];

const HISTORY_TOPIC_STOPWORDS: &[&str] = &[
    "about", "after", "also", "because", "being", "build", "builder", "builders", "change",
    "changing", "could", "from", "here", "into", "more", "news", "people", "post", "really",
    "should", "that", "their", "there", "these", "thing", "today", "using", "what", "when",
    "where", "with", "world", "would",
];

fn normalized_history_text(text: &str) -> String {
    // Mirrors TS `normalizedHistoryText`: lowercase, strip URLs, collapse
    // non-alphanumerics, collapse whitespace. URL removal is approximated
    // with a whitespace split (URLs have no internal whitespace).
    let lowered = text.to_lowercase();
    let without_urls = lowered
        .split_whitespace()
        .filter(|word| !word.starts_with("http://") && !word.starts_with("https://"))
        .collect::<Vec<_>>()
        .join(" ");
    let cleaned: String = without_urls
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c.is_whitespace() {
                c
            } else {
                ' '
            }
        })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn history_topic_words(text: &str) -> std::collections::HashSet<String> {
    normalized_history_text(text)
        .split(' ')
        .filter(|word| word.len() >= 4 && !HISTORY_TOPIC_STOPWORDS.contains(word))
        .take(24)
        .map(str::to_string)
        .collect()
}

fn set_overlap(
    first: &std::collections::HashSet<String>,
    second: &std::collections::HashSet<String>,
) -> usize {
    first
        .iter()
        .filter(|value| second.contains(value.as_str()))
        .count()
}

fn source_host(url: Option<&str>) -> Option<String> {
    let url = url?;
    let parsed = url::Url::parse(url).ok()?;
    Some(parsed.host_str()?.trim_start_matches("www.").to_lowercase())
}

fn contains_url(text: &str) -> bool {
    fancy_regex::Regex::new(r"(?i)https?://\S+")
        .map(|regex| regex.is_match(text).unwrap_or(false))
        .unwrap_or(false)
}

fn source_needs_link(item: &zyquor_storage::PostHistory) -> bool {
    item.source_url.is_some() && {
        item.tweet_type.as_deref() == Some("useful_info")
            || item.source_type.as_deref() == Some("job")
    }
}

fn analyze_post_history(
    history: &[zyquor_storage::PostHistory],
    account_id: Option<&str>,
    now: chrono::DateTime<chrono::Utc>,
    since_hours: Option<f64>,
) -> Value {
    let since_millis =
        now.timestamp_millis() - (since_hours.unwrap_or(24.0) * 60.0 * 60.0 * 1000.0) as i64;
    let since = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(since_millis)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default();

    let mut recent: Vec<&zyquor_storage::PostHistory> = history
        .iter()
        .filter(|item| {
            account_id.is_none_or(|id| item.account_id == id)
                && item.posted_at.as_str() >= since.as_str()
        })
        .collect();
    recent.sort_by(|a, b| a.posted_at.cmp(&b.posted_at));

    let mut summary = serde_json::json!({
        "duplicate_text": 0,
        "generic_phrasing": 0,
        "missing_link": 0,
        "repeated_topic": 0,
        "weak_source_attribution": 0,
    });
    let mut issues: Vec<Value> = Vec::new();
    let bump = |key: &str, summary: &mut Value| {
        if let Some(value) = summary.get_mut(key) {
            let current = value.as_i64().unwrap_or(0);
            *value = Value::from(current + 1);
        }
    };

    let mut by_text: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for item in &recent {
        let normalized = normalized_history_text(&item.posted_text);
        by_text.entry(normalized).or_default().push(item.id.clone());
    }
    for items in by_text.values() {
        if items.len() < 2 {
            continue;
        }
        bump("duplicate_text", &mut summary);
        issues.push(json!({
            "detail": format!("Exact duplicate post text appeared {} times.", items.len()),
            "historyIds": items,
            "severity": "high",
            "type": "duplicate_text",
        }));
    }

    for item in &recent {
        if let Some(pattern) = HISTORY_GENERIC_PATTERNS.iter().find(|pattern| {
            fancy_regex::Regex::new(pattern)
                .map(|regex| regex.is_match(&item.posted_text).unwrap_or(false))
                .unwrap_or(false)
        }) {
            bump("generic_phrasing", &mut summary);
            issues.push(json!({
                "detail": format!("Generic phrase matched {pattern}."),
                "historyIds": [item.id.clone()],
                "severity": "medium",
                "type": "generic_phrasing",
            }));
        }

        if source_needs_link(item) && !contains_url(&item.posted_text) {
            bump("missing_link", &mut summary);
            issues.push(json!({
                "detail": format!(
                    "Source-backed {} post omitted source URL {}.",
                    item.tweet_type.as_deref().unwrap_or(item.source_type.as_deref().unwrap_or("")),
                    item.source_url.clone().unwrap_or_default()
                ),
                "historyIds": [item.id.clone()],
                "severity": "medium",
                "type": "missing_link",
            }));
        }

        let has_source_identity = item.source_packet_id.is_some() || item.source_type.is_some();
        let missing_title_and_url = item.source_title.as_deref().unwrap_or("").is_empty()
            && item.source_url.as_deref().unwrap_or("").is_empty();
        if has_source_identity && missing_title_and_url {
            bump("weak_source_attribution", &mut summary);
            issues.push(json!({
                "detail": "Source-backed post has no source title or source URL in history metadata.",
                "historyIds": [item.id.clone()],
                "severity": "medium",
                "type": "weak_source_attribution",
            }));
        } else if item
            .source_url
            .as_deref()
            .is_some_and(|url| !url.is_empty())
            && !contains_url(&item.posted_text)
        {
            let host = source_host(item.source_url.as_deref());
            let title_words = item
                .source_title
                .as_deref()
                .map(history_topic_words)
                .unwrap_or_default();
            let post_words = history_topic_words(&item.posted_text);
            if host.is_some()
                && !title_words.is_empty()
                && set_overlap(&title_words, &post_words) == 0
            {
                bump("weak_source_attribution", &mut summary);
                issues.push(json!({
                    "detail": format!(
                        "Post does not include link or recognizable source title terms for {}.",
                        host.unwrap_or_default()
                    ),
                    "historyIds": [item.id.clone()],
                    "severity": "low",
                    "type": "weak_source_attribution",
                }));
            }
        }
    }

    for index in 0..recent.len() {
        let item = recent[index];
        let current_words = history_topic_words(&format!(
            "{} {}",
            item.source_title.clone().unwrap_or_default(),
            item.posted_text
        ));
        if current_words.len() < 3 {
            continue;
        }
        for other in &recent[index + 1..] {
            let other_words = history_topic_words(&format!(
                "{} {}",
                other.source_title.clone().unwrap_or_default(),
                other.posted_text
            ));
            let overlap = set_overlap(&current_words, &other_words);
            if overlap < 4 {
                continue;
            }
            bump("repeated_topic", &mut summary);
            issues.push(json!({
                "detail": format!("Topic overlap detected across recent posts ({overlap} shared terms)."),
                "historyIds": [item.id.clone(), other.id.clone()],
                "severity": "low",
                "type": "repeated_topic",
            }));
            break;
        }
    }

    json!({
        "generatedAt": now.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "issues": issues,
        "postCount": recent.len(),
        "since": since,
        "summary": summary,
    })
}

async fn get_analysis(
    State(state): State<AppState>,
    Query(query): Query<AnalysisQuery>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    crate::history::purge_expired_post_history(&repository).await?;
    let history = repository.list_post_history().await?;
    let account_id = query.account_id.filter(|value| !value.is_empty());
    let since_hours = query.since_hours.as_deref().and_then(|text| {
        let parsed: f64 = text.trim().parse().ok()?;
        if parsed.is_finite() && parsed > 0.0 {
            Some(parsed)
        } else {
            None
        }
    });
    let analysis = analyze_post_history(
        &history,
        account_id.as_deref(),
        chrono::Utc::now(),
        since_hours,
    );
    Ok(Json(json!({"analysis": analysis})))
}

fn resolve_profile_dir(profile_dir: &str) -> String {
    let path = std::path::Path::new(profile_dir);
    if path.is_absolute() {
        profile_dir.to_string()
    } else {
        zyquor_core::paths::resolve_data_root()
            .join(profile_dir)
            .to_string_lossy()
            .to_string()
    }
}

fn browser_snapshot(state: &AppState) -> Result<(bool, Option<u64>, Option<String>), ApiError> {
    let browser = state
        .browser
        .lock()
        .map_err(|_| ApiError::Internal("browser mutex poisoned".to_string()))?;
    Ok((
        browser.enable_post,
        browser.action_delay_ms,
        browser.cdp_url.clone(),
    ))
}

async fn record_delete_attempt(
    repository: &crate::state::Repository,
    draft_id: &str,
    status: zyquor_core::types::AttemptStatus,
    error_code: Option<String>,
    error_message: Option<String>,
    screenshot_path: Option<String>,
    trace_path: Option<String>,
) {
    let draft_jobs = repository
        .list_jobs_by_draft_id(draft_id)
        .await
        .unwrap_or_default();
    let Some(job) = draft_jobs.into_iter().next() else {
        return;
    };
    let _ = repository
        .create_attempt(zyquor_storage::NewAttempt {
            job_id: job.id,
            status,
            error_code,
            error_message,
            screenshot_path,
            trace_path,
        })
        .await;
}

async fn delete_history_post(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let history = repository.get_post_history(&id).await?;
    let Some(history) = history else {
        return Err(ApiError::Http(HttpError::new(
            404,
            "History entry not found",
        )));
    };
    if matches!(history.metadata.get("deletedAt"), Some(Value::String(text)) if !text.is_empty()) {
        return Ok(Json(json!({"history": history, "alreadyDeleted": true})));
    }
    let Some(post_url) = history.post_url.clone().filter(|url| !url.is_empty()) else {
        return Err(ApiError::Http(HttpError::new(
            409,
            "History entry has no post URL; cannot locate the tweet on X",
        )));
    };
    let (enable_post, action_delay_ms, base_cdp_url) = browser_snapshot(&state)?;
    if !enable_post {
        return Err(ApiError::Http(HttpError::new(
            403,
            "Browser delete action is disabled",
        )));
    }
    let account = repository.get_account(&history.account_id).await?;
    let Some(account) = account else {
        return Err(ApiError::Http(HttpError::new(
            409,
            "History entry is missing its account",
        )));
    };
    if !zyquor_accounts::is_account_runnable(&account) {
        return Err(ApiError::Http(HttpError::new(
            409,
            "Account is not enabled for browser jobs",
        )));
    }

    let profile_cdp_url =
        zyquor_core::paths::per_profile_cdp_url(base_cdp_url.as_deref(), &account.profile_dir);
    let profile_dir = resolve_profile_dir(&account.profile_dir);
    let expected_handle = account.handle.trim_start_matches('@').to_lowercase();

    let launched = zyquor_browser::ensure_browser_cdp(&profile_cdp_url, &profile_dir).await;
    if !launched {
        return Err(ApiError::Http(HttpError::new(
            409,
            format!(
                "Cannot verify the X login before deleting for @{}: could not launch Chrome at {profile_cdp_url}",
                account.handle
            ),
        )));
    }
    let session = zyquor_browser::Session::connect(&profile_cdp_url)
        .await
        .map_err(|error| {
            ApiError::Http(HttpError::new(
                409,
                format!(
                    "Cannot verify the X login before deleting for @{}: {error}",
                    account.handle
                ),
            ))
        })?;
    let login = zyquor_browser::check_x_login(&session, "https://x.com/home")
        .await
        .map_err(|error| {
            ApiError::Http(HttpError::new(
                409,
                format!(
                    "Cannot verify the X login before deleting for @{}: {error}",
                    account.handle
                ),
            ))
        })?;
    if !login.logged_in {
        return Err(ApiError::Http(HttpError::new(
            409,
            format!(
                "The posting Chrome is not logged in to X as @{} . Log in and activate the account first.",
                account.handle
            ),
        )));
    }
    let Some(handle) = login.handle.clone() else {
        return Err(ApiError::Http(HttpError::new(
            409,
            format!(
                "Cannot read which X account is logged in for @{}; refusing to act rather than guess.",
                account.handle
            ),
        )));
    };
    if handle != expected_handle {
        return Err(ApiError::Http(HttpError::new(
            409,
            format!(
                "Identity mismatch: the posting Chrome is logged in as @{handle}, but this post belongs to @{expected_handle}. Refusing to delete under the wrong account."
            ),
        )));
    }
    zyquor_accounts::assert_dedicated_profile_dir(&account.profile_dir)
        .map_err(|error| ApiError::Internal(error.to_string()))?;

    {
        let mut runtime = state
            .runtime
            .lock()
            .map_err(|_| ApiError::Internal("runtime mutex poisoned".to_string()))?;
        runtime.browser_loaded = true;
    }
    record_delete_attempt(
        &repository,
        &history.draft_id,
        zyquor_core::types::AttemptStatus::Started,
        None,
        None,
        None,
        None,
    )
    .await;

    let delete_input = zyquor_browser::DeletePostInput {
        profile_dir: profile_dir.clone(),
        post_url: post_url.clone(),
        cdp_url: profile_cdp_url.clone(),
        action_delay_ms,
        artifacts_dir: None,
    };
    let close_after_post = state
        .browser
        .lock()
        .map(|browser| browser.close_after_post.unwrap_or(true))
        .unwrap_or(true);
    match zyquor_browser::delete_post(&session, &delete_input).await {
        Ok(result) => {
            let mut metadata = Map::new();
            metadata.extend(history.metadata.clone());
            metadata.insert(
                "deletedAt".to_string(),
                Value::String(
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                ),
            );
            metadata.insert(
                "deletedVia".to_string(),
                Value::String("browser".to_string()),
            );
            if result.already_deleted {
                metadata.insert("alreadyDeleted".to_string(), Value::Bool(true));
            }
            let updated = repository
                .update_post_history_metadata(&history.id, metadata)
                .await?;
            record_delete_attempt(
                &repository,
                &history.draft_id,
                zyquor_core::types::AttemptStatus::Verified,
                None,
                None,
                None,
                None,
            )
            .await;
            if close_after_post {
                zyquor_browser::close_browser_cdp(&profile_cdp_url).await;
            }
            let value = updated.unwrap_or(history);
            Ok(Json(
                json!({"history": value, "alreadyDeleted": result.already_deleted}),
            ))
        }
        Err(error) => {
            if close_after_post {
                zyquor_browser::close_browser_cdp(&profile_cdp_url).await;
            }
            let screenshot_path = error
                .screenshot_path
                .as_ref()
                .map(|path| path.to_string_lossy().to_string());
            record_delete_attempt(
                &repository,
                &history.draft_id,
                zyquor_core::types::AttemptStatus::Failed,
                Some("browser_delete_failed".to_string()),
                Some(error.to_string()),
                screenshot_path,
                None,
            )
            .await;
            Err(ApiError::Http(HttpError::new(500, error.to_string())))
        }
    }
}
