//! Accounts routes, ported from `apps/api/src/routes/accounts.ts`.

use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, patch},
};
use serde_json::{Value, json};

use crate::errors::ApiError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/accounts", get(list_accounts).post(create_account))
        .route(
            "/accounts/{id}",
            patch(update_account).delete(delete_account),
        )
}

async fn list_accounts(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let accounts = state.repository().list_accounts().await?;
    Ok(Json(json!({"accounts": accounts})))
}

#[derive(serde::Deserialize)]
struct CreateAccountRequest {
    handle: String,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
}

async fn create_account(
    State(state): State<AppState>,
    Json(input): Json<CreateAccountRequest>,
) -> Result<(axum::http::StatusCode, Json<Value>), ApiError> {
    if !is_valid_handle(&input.handle) {
        return Err(crate::errors::ApiError::invalid(
            "handle does not match ^[a-z0-9_]{1,15}$",
        ));
    }
    let display_name = input
        .display_name
        .clone()
        .unwrap_or_else(|| input.handle.clone());
    if display_name.is_empty() || display_name.len() > 120 {
        return Err(crate::errors::ApiError::invalid(
            "displayName length invalid",
        ));
    }
    let profile_dir = format!("profiles/{}", input.handle);
    zyquor_accounts::assert_dedicated_profile_dir(&profile_dir)
        .map_err(|error| crate::errors::ApiError::http(400, error.to_string()))?;

    let account = state
        .repository()
        .create_account(&input.handle, &display_name, &profile_dir, "style_default")
        .await?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({"account": account})),
    ))
}

fn is_valid_handle(handle: &str) -> bool {
    !handle.is_empty()
        && handle.len() <= 15
        && handle
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

#[derive(serde::Deserialize, Default)]
struct UpdateAccountRequest {
    #[allow(dead_code)]
    handle: Option<String>,
    #[serde(default, rename = "displayName")]
    display_name: Option<String>,
    #[serde(default, rename = "profileDir")]
    profile_dir: Option<String>,
    #[serde(default, rename = "postingMode")]
    posting_mode: Option<String>,
    enabled: Option<bool>,
    #[serde(default, rename = "dailyPostLimit")]
    daily_post_limit: Option<serde_json::Value>,
    #[serde(default, rename = "quietHoursStart")]
    quiet_hours_start: Option<serde_json::Value>,
    #[serde(default, rename = "quietHoursEnd")]
    quiet_hours_end: Option<serde_json::Value>,
}

async fn update_account(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(input): Json<UpdateAccountRequest>,
) -> Result<Json<Value>, ApiError> {
    if let Some(profile_dir) = &input.profile_dir {
        zyquor_accounts::assert_dedicated_profile_dir(profile_dir)
            .map_err(|error| crate::errors::ApiError::http(400, error.to_string()))?;
    }

    let posting_mode = match input.posting_mode.as_deref() {
        Some(mode) => Some(
            mode.parse::<zyquor_core::types::PostingMode>()
                .map_err(|_| {
                    crate::errors::ApiError::invalid(format!("invalid posting mode: {mode}"))
                })?,
        ),
        None => None,
    };

    let account = state
        .repository()
        .update_account(
            &id,
            zyquor_storage::AccountUpdate {
                display_name: input.display_name,
                profile_dir: input.profile_dir,
                posting_mode,
                enabled: input.enabled,
                daily_post_limit: opt_i64(input.daily_post_limit),
                quiet_hours_start: opt_str(input.quiet_hours_start),
                quiet_hours_end: opt_string(input.quiet_hours_end),
            },
        )
        .await?;
    Ok(Json(json!({"account": account})))
}

fn opt_i64(value: Option<Value>) -> Option<Option<i64>> {
    match value {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::Number(number)) => Some(number.as_i64()),
        _ => None,
    }
}

fn opt_str(value: Option<Value>) -> Option<Option<String>> {
    match value {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text)),
        _ => None,
    }
}

fn opt_string(value: Option<Value>) -> Option<Option<String>> {
    match value {
        None => None,
        Some(Value::Null) => Some(None),
        Some(Value::String(text)) => Some(Some(text)),
        _ => None,
    }
}

async fn delete_account(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    match repository.get_account(&id).await? {
        Some(_) => {}
        None => {
            return Err(crate::errors::ApiError::http(
                404,
                format!("Account not found: {id}"),
            ));
        }
    }
    if repository.list_accounts().await?.len() == 1 {
        return Err(crate::errors::ApiError::http(
            409,
            "Cannot delete the last remaining account",
        ));
    }
    let account = repository.delete_account(&id).await?;
    Ok(Json(json!({"account": account})))
}
