//! Generation config routes, ported from `apps/api/src/routes/generation.ts`.

use axum::{Json, Router, extract::State, routing::get};
use serde_json::{Value, json};

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
    // Mirrors `resolveGenerationProviderConfig(deps.generationEnv)` where the
    // Rust env is the merged saved-config + process env.
    let env_lookup = crate::lib_deps::merged_generation_env(&|key: &str| std::env::var(key).ok());
    let config = zyquor_generation::resolve_generation_provider_config(&env_lookup)
        .map_err(|error| ApiError::Generation(error.to_string()))?;
    let _ = state;
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
    // Build the next merged env: saved layer is rewritten from the new
    // provider/model, the base layer stays `process.env`.
    let provider = input.provider.clone();
    let model = input.model.clone();

    // Provider resolution errors surface as 503, like the TS
    // `createGenerationProviderFromEnv` throw.
    let next_env = |key: &str| -> Option<String> {
        match key {
            "ZYQUOR_LLM_PROVIDER" => Some(provider.clone()),
            "ZYQUOR_COMMAND_CODE_MODEL" if provider == "command-code" => Some(model.clone()),
            "ZYQUOR_OPENCODE_MODEL" if provider == "opencode" => Some(model.clone()),
            "ZYQUOR_GEMINI_MODEL" if provider == "gemini" => Some(model.clone()),
            "ZYQUOR_OLLAMA_MODEL" if provider == "ollama" => Some(model.clone()),
            _ => std::env::var(key).ok(),
        }
    };
    // Validate through the same factory the state build uses; the provider
    // instance itself is immutable in `AppState`, so a failed factory is the
    // only surfaced error and a success means the saved file can be written.
    let _probe = zyquor_generation::create_generation_provider_from_env(
        &next_env,
        zyquor_generation::ReqwestFetch::new(),
    )
    .map_err(|error| ApiError::Generation(error.to_string()))?;

    // `writeSavedGenerationEnv(generationConfigPath, nextEnv)`.
    if let Some(path) = crate::lib_deps::generation_config_path() {
        crate::lib_deps::write_saved_generation_env(&path, &next_env)
            .map_err(ApiError::Generation)?;
    }
    let _ = state;

    // The desktop settings update has no Rust counterpart in `AppState`.
    Ok(Json(json!({
        "generation": generation_value(&state)?,
        "providers": providers_value(),
    })))
}

use std::str::FromStr as _;
