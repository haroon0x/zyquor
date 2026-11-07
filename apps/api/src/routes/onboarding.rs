//! Onboarding routes, ported from `apps/api/src/routes/onboarding.ts`.

use axum::{Json, Router, extract::State, routing::get};
use serde_json::{Value, json};
use zyquor_generation::resolve_generation_provider_config;

use crate::errors::ApiError;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/onboarding/status", get(onboarding_status))
}

fn has_explicit_generation_config(lookup: &impl Fn(&str) -> Option<String>) -> bool {
    let provider_explicit = lookup("ZYQUOR_LLM_PROVIDER")
        .map(|value| !value.is_empty() && value.to_lowercase() != "auto")
        .unwrap_or(false);
    provider_explicit
        || [
            "ZYQUOR_COMMAND_CODE_MODEL",
            "ZYQUOR_COMMAND_CODE_PATH",
            "ZYQUOR_CODEX_MODEL",
            "ZYQUOR_CODEX_PATH",
            "ZYQUOR_GEMINI_API_KEY",
            "ZYQUOR_GEMINI_MODEL",
            "ZYQUOR_GEMINI_BASE_URL",
            "ZYQUOR_OLLAMA_MODEL",
            "ZYQUOR_OLLAMA_BASE_URL",
        ]
        .iter()
        .any(|key| lookup(key).map(|value| !value.is_empty()).unwrap_or(false))
}

async fn onboarding_status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let repository = state.repository();
    let accounts = repository.list_accounts().await?;
    // `hasDrafts` / `hasPostJobs` in the TS repository are `SELECT 1 ... LIMIT 1`
    // checks; listing with a tight limit is the same existence test through the
    // async proxy.
    let has_drafts = !repository.list_drafts(None).await?.is_empty();
    let has_jobs = !repository.list_jobs(None, None, Some(1)).await?.is_empty();

    let merged = crate::lib_deps::merged_generation_env(&|key: &str| std::env::var(key).ok());
    let generation = resolve_generation_provider_config(&merged)
        .map_err(|error| crate::errors::ApiError::Internal(error.to_string()))?;
    let generation_is_default = !has_explicit_generation_config(&merged);
    let x_session_checked_ok = state
        .runtime
        .lock()
        .map_err(|_| crate::errors::ApiError::Internal("runtime mutex poisoned".to_string()))?
        .onboarding
        .x_session_checked_ok;

    let mut generation_value = serde_json::to_value(&generation)
        .map_err(|error| crate::errors::ApiError::Internal(error.to_string()))?;
    if let Value::Object(map) = &mut generation_value {
        map.insert("isDefault".to_string(), Value::Bool(generation_is_default));
    }

    Ok(Json(json!({
        "needsOnboarding": !has_drafts
            && !has_jobs
            && (!generation.configured || generation_is_default)
            && !x_session_checked_ok,
        "accountsCount": accounts.len(),
        "hasDrafts": has_drafts,
        "hasJobs": has_jobs,
        "generation": generation_value,
        "xSessionCheckedOk": x_session_checked_ok,
    })))
}
