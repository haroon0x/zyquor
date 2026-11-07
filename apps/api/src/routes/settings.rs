//! Settings routes, ported from `apps/api/src/routes/settings.ts`.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use axum::{Json, Router, extract::State, routing::get};
use serde_json::{Map, Value};
use zyquor_generation::ReqwestFetch;
use zyquor_generation::providers::create_generation_provider_from_env;

use crate::errors::ApiError;
use crate::state::AppState;

const GENERATION_KEYS: &[&str] = &[
    "commandCodePath",
    "opencodePath",
    "opencodeVariant",
    "llmProvider",
    "geminiApiKey",
];

const GENERATION_ENV_KEYS: &[(&str, &str)] = &[
    ("commandCodePath", "ZYQUOR_COMMAND_CODE_PATH"),
    ("opencodePath", "ZYQUOR_OPENCODE_PATH"),
    ("opencodeVariant", "ZYQUOR_OPENCODE_VARIANT"),
    ("geminiApiKey", "ZYQUOR_GEMINI_API_KEY"),
    ("llmProvider", "ZYQUOR_LLM_PROVIDER"),
];

pub fn router() -> Router<AppState> {
    Router::new().route("/settings", get(get_settings).patch(update_settings))
}

/// The desktop-settings store. The TS side owns this through the injected
/// desktop app (`deps.desktopSettings`); the API port keeps the same values
/// in process so the routes + JSON shapes are preserved without it.
fn settings_store() -> &'static Mutex<Map<String, Value>> {
    static STORE: OnceLock<Mutex<Map<String, Value>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Map::new()))
}

/// The configured feedback directory (`feedbackDir`), used by the
/// system-feedback notebook writer. `None` resolves to `<cwd>/feedback`,
/// matching `resolveFeedbackDir(undefined)`.
pub(crate) fn feedback_dir() -> Option<String> {
    let store = settings_store().lock().ok()?;
    store
        .get("feedbackDir")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn mask_settings(settings: &Map<String, Value>) -> Map<String, Value> {
    let mut masked = settings.clone();
    if let Some(value) = masked.get("geminiApiKey").and_then(Value::as_str) {
        if !value.is_empty() {
            let last_four: String = value
                .chars()
                .rev()
                .take(4)
                .collect::<String>()
                .chars()
                .rev()
                .collect();
            let shown = if value.chars().count() <= 4 {
                "****".to_string()
            } else {
                format!("{}{}", "*".repeat(value.chars().count() - 4), last_four)
            };
            masked.insert("geminiApiKey".to_string(), Value::String(shown));
        }
    }
    masked
}

async fn get_settings(State(_state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let settings = settings_store()
        .lock()
        .map_err(|_| crate::errors::ApiError::Internal("settings mutex poisoned".to_string()))?;
    Ok(Json(Value::Object(mask_settings(&settings))))
}

async fn update_settings(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut patch = match body {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        _ => Map::new(),
    };

    let current = settings_store()
        .lock()
        .map_err(|_| crate::errors::ApiError::Internal("settings mutex poisoned".to_string()))?
        .clone();
    let masked_current = mask_settings(&current);

    // Re-submitting the masked key means "unchanged": drop it from the patch.
    let incoming_masked = patch
        .get("geminiApiKey")
        .and_then(Value::as_str)
        .map(str::to_string);
    let stored = current
        .get("geminiApiKey")
        .and_then(Value::as_str)
        .map(str::to_string);
    let masked_value = masked_current
        .get("geminiApiKey")
        .and_then(Value::as_str)
        .map(str::to_string);
    if incoming_masked.is_some() && stored.is_some() && incoming_masked == masked_value {
        patch.remove("geminiApiKey");
    }

    // Empty-string values delete the key.
    patch.retain(|_, value| !matches!(value, Value::String(text) if text.is_empty()));

    let updated = {
        let mut store = settings_store().lock().map_err(|_| {
            crate::errors::ApiError::Internal("settings mutex poisoned".to_string())
        })?;
        for (key, value) in &patch {
            if matches!(value, Value::String(text) if text.is_empty()) {
                store.remove(key);
            } else {
                store.insert(key.clone(), value.clone());
            }
        }
        store.clone()
    };

    let mut browser = state
        .browser
        .lock()
        .map_err(|_| crate::errors::ApiError::Internal("browser mutex poisoned".to_string()))?;
    if let Some(enable_prepare) = patch.get("enableBrowserPrepare").and_then(Value::as_bool) {
        browser.enable_prepare = enable_prepare;
    }
    if let Some(enable_post) = patch.get("enableBrowserPost").and_then(Value::as_bool) {
        browser.enable_post = enable_post;
    }
    if let Some(close_after_post) = patch.get("closeChromeAfterPost").and_then(Value::as_bool) {
        browser.close_after_post = Some(close_after_post);
    }
    if let Some(cdp_port) = patch.get("cdpPort").and_then(Value::as_u64) {
        browser.cdp_url = Some(format!("http://127.0.0.1:{cdp_port}"));
    }
    drop(browser);

    let generation_patch: Vec<&str> = patch
        .keys()
        .map(String::as_str)
        .filter(|key| GENERATION_KEYS.contains(key))
        .collect();

    let mut restart_required = false;
    if !generation_patch.is_empty() {
        let mut overrides: HashMap<String, Option<String>> = HashMap::new();
        for (setting_key, env_key) in GENERATION_ENV_KEYS {
            if generation_patch.contains(setting_key) {
                let next = match updated.get(*setting_key) {
                    Some(Value::Null) | None => None,
                    Some(Value::String(text)) => Some(text.clone()),
                    Some(other) => Some(other.to_string()),
                };
                overrides.insert((*env_key).to_string(), next);
            }
        }
        let merged = crate::lib_deps::merged_generation_env(&|key: &str| std::env::var(key).ok());
        let lookup = |key: &str| match overrides.get(key) {
            Some(value) => value.clone(),
            None => merged(key),
        };
        match create_generation_provider_from_env(&lookup, ReqwestFetch::new()) {
            Ok(_) => {
                restart_required = false;
                if patch.contains_key("llmProvider") {
                    if let Some(config_path) = crate::lib_deps::generation_config_path() {
                        if crate::lib_deps::write_saved_generation_env(&config_path, &lookup)
                            .is_err()
                        {
                            restart_required = true;
                        }
                    }
                }
            }
            Err(_) => {
                restart_required = true;
            }
        }
    }

    let mut masked = mask_settings(&updated);
    masked.insert("restartRequired".to_string(), Value::Bool(restart_required));
    Ok(Json(Value::Object(masked)))
}
