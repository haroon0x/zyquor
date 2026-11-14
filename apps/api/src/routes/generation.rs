//! Generation config routes, ported from `apps/api/src/routes/generation.ts`.
//!
//! `PATCH /generation` hot-swaps the live provider (`deps.generationProvider`
//! in TS): it builds the next env from the current live env snapshot, creates
//! the provider, swaps it into [`AppState`], then persists the saved config.
//! `GET /generation` resolves from that live env store, never process env.

use std::sync::Arc;

use axum::{Json, Router, extract::State, routing::get};
use serde_json::{Value, json};
use zyquor_generation::ReqwestFetch;
use zyquor_generation::providers::{DraftGenerationProvider, create_generation_provider_from_env};

use crate::errors::{ApiError, Issue};
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/generation", get(get_generation).patch(update_generation))
}

fn providers_value() -> Value {
    json!({
        "command-code": zyquor_generation::COMMAND_CODE_MODELS,
        "opencode": zyquor_generation::OPENCODE_MODELS,
        "gemini": zyquor_generation::GEMINI_MODELS,
        "ollama": zyquor_generation::OLLAMA_MODELS,
    })
}

fn generation_value(state: &AppState) -> Result<Value, ApiError> {
    // Mirrors `resolveGenerationProviderConfig(deps.generationEnv)`: the live
    // env snapshot the provider was built from, not a fresh process-env read.
    let config = state
        .generation_config()
        .map_err(|error| ApiError::Generation(error.to_string()))?;
    let mut value = serde_json::json!({
        "provider": config.provider.as_str(),
        "model": config.model,
        "configured": config.configured,
    });
    if let Some(base_url) = config.base_url {
        value["baseUrl"] = Value::String(base_url);
    }
    if let Some(revision_pass) = config.revision_pass {
        value["revisionPass"] = Value::Bool(revision_pass);
    }
    Ok(value)
}

async fn get_generation(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(json!({
        "generation": generation_value(&state)?,
        "providers": providers_value(),
    })))
}

struct GenerationInput {
    provider: String,
    model: String,
}

fn parse_generation(value: &Value) -> Result<GenerationInput, ApiError> {
    let obj = value.as_object().ok_or_else(|| {
        ApiError::invalid_with_issues(vec![Issue {
            path: String::new(),
            message: "expected an object".to_string(),
        }])
    })?;
    let mut issues = Vec::new();
    let provider = match obj.get("provider") {
        Some(Value::String(text)) => {
            if zyquor_generation::GenerationProviderName::from_str(text.as_str()).is_ok() {
                // `GenerationProviderName::from_str` is the same allowlist as LLM_PROVIDERS.
                // Fall back to the explicit list check for the wire spelling.
                if zyquor_core::types::LLM_PROVIDERS
                    .iter()
                    .any(|p| p.as_str() == text)
                {
                    text.clone()
                } else {
                    issues.push(Issue {
                        path: "provider".to_string(),
                        message: "Invalid enum value".to_string(),
                    });
                    String::new()
                }
            } else if zyquor_core::types::LLM_PROVIDERS
                .iter()
                .any(|p| p.as_str() == text)
            {
                text.clone()
            } else {
                issues.push(Issue {
                    path: "provider".to_string(),
                    message: "Invalid enum value".to_string(),
                });
                String::new()
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "provider".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
        None => {
            issues.push(Issue {
                path: "provider".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let model = match obj.get("model") {
        Some(Value::String(text)) if !text.is_empty() && text.len() <= 160 => text.clone(),
        Some(Value::String(text)) if text.is_empty() => {
            issues.push(Issue {
                path: "model".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            String::new()
        }
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "model".to_string(),
                message: "String must contain at most 160 character(s)".to_string(),
            });
            String::new()
        }
        Some(_) => {
            issues.push(Issue {
                path: "model".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
        None => {
            issues.push(Issue {
                path: "model".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    if issues.is_empty() {
        Ok(GenerationInput { provider, model })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

async fn update_generation(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let input = parse_generation(&body)?;

    // TS: `nextEnv = {...deps.generationEnv, ZYQUOR_LLM_PROVIDER: provider,
    // <provider-specific model var>: model}`. Everything else (paths, keys,
    // variant, revision pass) carries over from the live env.
    let mut next_env = state.generation_environment();
    next_env.set("ZYQUOR_LLM_PROVIDER", Some(input.provider.clone()));
    let model_key = match input.provider.as_str() {
        "command-code" => Some("ZYQUOR_COMMAND_CODE_MODEL"),
        "opencode" => Some("ZYQUOR_OPENCODE_MODEL"),
        "gemini" => Some("ZYQUOR_GEMINI_MODEL"),
        "ollama" => Some("ZYQUOR_OLLAMA_MODEL"),
        _ => None,
    };
    if let Some(key) = model_key {
        next_env.set(key, Some(input.model.clone()));
    }

    // `createGenerationProviderFromEnv(nextEnv)` — a factory failure is a 503,
    // like the TS throw, and leaves the live provider untouched.
    let provider: Arc<dyn DraftGenerationProvider> = Arc::new(
        create_generation_provider_from_env(&next_env.lookup(), ReqwestFetch::new())
            .map_err(|error| ApiError::Generation(error.to_string()))?,
    );
    state.apply_generation_provider(next_env.clone(), provider);

    // `writeSavedGenerationEnv(generationConfigPath, deps.generationEnv)`.
    if let Some(path) = state.generation_config_path() {
        crate::lib_deps::write_saved_generation_env(path, &next_env.lookup())
            .map_err(ApiError::Generation)?;
    }

    // Keep the desktop settings panel in step; otherwise it reports a stale
    // provider (TS: `deps.desktopSettings?.update({llmProvider})`).
    let mut settings_patch = serde_json::Map::new();
    settings_patch.insert(
        "llmProvider".to_string(),
        Value::String(input.provider.clone()),
    );
    crate::routes::settings::update_desktop_settings(&state, settings_patch);

    Ok(Json(json!({
        "generation": generation_value(&state)?,
        "providers": providers_value(),
    })))
}

use std::str::FromStr as _;
