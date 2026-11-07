//! System feedback routes, ported from `apps/api/src/routes/system-feedback.ts`.

use std::io::Write;
use std::path::PathBuf;

use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{delete, get},
};
use serde_json::{Value, json};

use crate::errors::ApiError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/system-feedback",
            get(list_system_feedback).post(create_system_feedback),
        )
        .route("/system-feedback/{id}", delete(delete_system_feedback))
}

#[derive(serde::Deserialize)]
struct SystemFeedbackQuery {
    #[serde(default, rename = "accountId")]
    account_id: Option<String>,
}

async fn list_system_feedback(
    State(state): State<AppState>,
    Query(query): Query<SystemFeedbackQuery>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    if let Some(account_id) = query.account_id.filter(|value| !value.is_empty()) {
        return Ok(Json(
            json!({"items": repository.list_system_feedback(&account_id).await?}),
        ));
    }
    let mut items = Vec::new();
    for account in repository.list_accounts().await? {
        items.extend(repository.list_system_feedback(&account.id).await?);
    }
    Ok(Json(json!({"items": items})))
}

#[derive(serde::Deserialize)]
struct CreateSystemFeedbackRequest {
    #[serde(rename = "accountId")]
    account_id: String,
    text: String,
}

async fn create_system_feedback(
    State(state): State<AppState>,
    Json(input): Json<CreateSystemFeedbackRequest>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    if input.account_id.is_empty() {
        return Err(crate::errors::ApiError::invalid("accountId is required"));
    }
    if input.text.is_empty() || input.text.len() > 1000 {
        return Err(crate::errors::ApiError::invalid(
            "text must be 1-1000 characters",
        ));
    }

    let item = state
        .repository()
        .add_system_feedback(&input.account_id, &input.text)
        .await?;
    let notebook_dir = resolve_feedback_dir(crate::routes::settings::feedback_dir().as_deref());
    append_notebook_entry(
        &notebook_dir,
        &format!(
            "[standing] {} — account {}",
            item.created_at, input.account_id
        ),
        &[
            "Standing correction applied to every future generation.".to_string(),
            String::new(),
            format!("> {}", input.text),
        ],
    )?;
    Ok((StatusCode::CREATED, Json(json!({"item": item}))))
}

async fn delete_system_feedback(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    state.repository().delete_system_feedback(&id).await?;
    Ok(Json(json!({"deleted": true})))
}

/// Port of `resolveFeedbackDir(feedbackDir?)` in `lib/feedback-notebook.ts`:
/// the configured dir (resolved against the cwd when relative), otherwise
/// `<cwd>/feedback`.
fn resolve_feedback_dir(feedback_dir: Option<&str>) -> PathBuf {
    match feedback_dir {
        Some(dir) if !dir.is_empty() => {
            let path = PathBuf::from(dir);
            if path.is_absolute() {
                path
            } else {
                std::env::current_dir()
                    .unwrap_or_else(|_| PathBuf::from("."))
                    .join(path)
            }
        }
        _ => std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("feedback"),
    }
}

/// Port of `appendNotebookEntry({ dir, heading, lines })`: creates the dir,
/// appends `## heading` + the lines (plus a trailing blank) to `notebook.md`.
fn append_notebook_entry(
    dir: &std::path::Path,
    heading: &str,
    lines: &[String],
) -> Result<(), ApiError> {
    std::fs::create_dir_all(dir)
        .map_err(|error| crate::errors::ApiError::Internal(error.to_string()))?;
    let path = dir.join("notebook.md");
    let body = format!("## {heading}\n{}\n\n", lines.join("\n"));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| crate::errors::ApiError::Internal(error.to_string()))?;
    file.write_all(body.as_bytes())
        .map_err(|error| crate::errors::ApiError::Internal(error.to_string()))
}
