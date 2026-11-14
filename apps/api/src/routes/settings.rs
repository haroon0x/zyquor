//! Settings routes, ported from `apps/api/src/routes/settings.ts`.
//!
//! The desktop settings live behind the injected [`DesktopSettingsPlane`]
//! (`deps.desktopSettings` in TS) when the Tauri shell is running; the
//! standalone API keeps the same routes with an in-process store fallback
//! (documented deviation: TS registers these routes only with desktopSettings).

use std::sync::{Mutex, OnceLock};

use axum::{Json, Router, extract::State, routing::get};
use serde_json::{Map, Value};
use zyquor_generation::ReqwestFetch;
use zyquor_generation::providers::create_generation_provider_from_env;

use crate::errors::ApiError;
use crate::state::AppState;

const SENSITIVE_KEYS: &[&str] = &["geminiApiKey"];

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

/// The process-level store used when no desktop settings plane was injected,
/// and kept in step (a mirror) while one is, so no-arg legacy readers such as
/// [`feedback_dir`] resolve the injected values too.
fn settings_store() -> &'static Mutex<Map<String, Value>> {
    static STORE: OnceLock<Mutex<Map<String, Value>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(Map::new()))
}

fn fallback_store() -> Map<String, Value> {
    settings_store()
        .lock()
        .map(|store| store.clone())
        .unwrap_or_default()
}

/// Replace the fallback/mirror store with a full snapshot.
pub(crate) fn seed_fallback_store(settings: Map<String, Value>) {
    if let Ok(mut store) = settings_store().lock() {
        *store = settings;
    }
}

/// Read the effective desktop settings: the injected plane when present, the
/// process-level fallback otherwise. Injected reads refresh the mirror store.
pub(crate) fn read_desktop_settings(state: &AppState) -> Map<String, Value> {
    match state.desktop_settings() {
        Some(plane) => {
            let settings = plane.get();
            seed_fallback_store(settings.clone());
            settings
        }
        None => fallback_store(),
    }
}

/// Write a patch through the injected plane when present, else merge it into
/// the fallback store. Returns the full updated settings.
pub(crate) fn update_desktop_settings(
    state: &AppState,
    patch: Map<String, Value>,
) -> Map<String, Value> {
    match state.desktop_settings() {
        Some(plane) => {
            let settings = plane.update(patch);
            seed_fallback_store(settings.clone());
            settings
        }
        None => {
            let Ok(mut store) = settings_store().lock() else {
                return Map::new();
            };
            for (key, value) in &patch {
                store.insert(key.clone(), value.clone());
            }
            store.clone()
        }
    }
}

/// Write one desktop setting (`desktopSettings.update({ [key]: value })`).
pub(crate) fn write_setting(state: &AppState, key: &str, value: Value) {
    let mut patch = Map::new();
    patch.insert(key.to_string(), value);
    let _ = update_desktop_settings(state, patch);
}

/// Read a boolean desktop setting. `None` matches the TS
/// `settings.get().<key> === true` check on an unset value.
pub(crate) fn read_bool(state: &AppState, key: &str) -> Option<bool> {
    read_desktop_settings(state)
        .get(key)
        .and_then(Value::as_bool)
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
    for key in SENSITIVE_KEYS {
        if let Some(value) = masked.get(*key).and_then(Value::as_str) {
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
                masked.insert((*key).to_string(), Value::String(shown));
            }
        }
    }
    masked
}

async fn get_settings(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let settings = read_desktop_settings(&state);
    Ok(Json(Value::Object(mask_settings(&settings))))
}

async fn update_settings(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut patch = match body {
        Value::Object(map) => map,
        _ => Map::new(),
    };

    let current = read_desktop_settings(&state);
    let masked_current = mask_settings(&current);

    // Re-submitting the masked key means "unchanged": drop it from the patch.
    for key in SENSITIVE_KEYS {
        let incoming_masked = patch.get(*key).and_then(Value::as_str).map(str::to_string);
        let stored = current
            .get(*key)
            .and_then(Value::as_str)
            .map(str::to_string);
        let masked_value = masked_current
            .get(*key)
            .and_then(Value::as_str)
            .map(str::to_string);
        if incoming_masked.is_some() && stored.is_some() && incoming_masked == masked_value {
            patch.remove(*key);
        }
    }

    // Empty-string values delete the key (the injected plane repeats this for
    // its own direct callers, like the TS `update`).
    patch.retain(|_, value| !matches!(value, Value::String(text) if text.is_empty()));

    let updated = update_desktop_settings(&state, patch.clone());

    {
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
    }

    let generation_patch: Vec<&str> = patch
        .keys()
        .map(String::as_str)
        .filter(|key| GENERATION_KEYS.contains(key))
        .collect();

    let mut restart_required = false;
    if !generation_patch.is_empty() {
        // TS: `nextEnv = {...deps.generationEnv}` then overwrite the patched
        // generation keys (`undefined` removes the key).
        let mut next_env = state.generation_environment();
        for (setting_key, env_key) in GENERATION_ENV_KEYS {
            if !generation_patch.contains(setting_key) {
                continue;
            }
            let next = match updated.get(*setting_key) {
                Some(Value::Null) | None => None,
                Some(Value::String(text)) => Some(text.clone()),
                Some(other) => Some(other.to_string()),
            };
            next_env.set(env_key, next);
        }
        match create_generation_provider_from_env(&next_env.lookup(), ReqwestFetch::new()) {
            Ok(provider) => {
                // Hot-swap the live provider + env together.
                state.apply_generation_provider(next_env.clone(), std::sync::Arc::new(provider));
                restart_required = false;
                // Persist to the same file GET /generation reads, otherwise the
                // saved generation config silently overrides this panel on the
                // next boot.
                if patch.contains_key("llmProvider") {
                    if let Some(config_path) = state.generation_config_path() {
                        if crate::lib_deps::write_saved_generation_env(
                            config_path,
                            &next_env.lookup(),
                        )
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
