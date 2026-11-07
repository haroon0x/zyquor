//! Desktop settings: read/write of `settings.json` plus the env map applied
//! at boot, ported from `settings.ts`.
//!
//! Differences from the TypeScript original (documented gaps, per the M6 spec):
//! - **No secret store.** Tauri has no `safeStorage` equivalent in this
//!   configuration, so `geminiApiKey` is kept **as-is (plaintext)** on save.
//!   On load, values starting with `enc:v1:` (written by an old TypeScript
//!   install) have the prefix stripped so the key still works — such values
//!   are treated as plaintext-equivalent and never dropped.
//! - `apply_settings_to_env` keeps the exact env var names and semantics of
//!   `applySettingsToEnv` (set-only-if-absent unless `overwrite`, booleans
//!   rendered as `"1"`/`"0"`), but Rust 2024 makes `std::env::set_var` unsafe
//!   and the workspace forbids unsafe code, so the process environment cannot
//!   be mutated. Instead the settings are stored in an in-process snapshot
//!   (see [`settings_env_value`]). In-process Rust consumers must read
//!   `settings_env_value` instead of `std::env::var`; the API/worker lanes
//!   receive their browser options from `main.rs` explicitly.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::log::log_line;

/// Desktop settings, camelCase on disk to match `settings.json` from the
/// TypeScript app. Every field is optional; unset fields are omitted from
/// the written JSON.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_browser_prepare: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_browser_post: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub close_chrome_after_post: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headless: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_code_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub opencode_variant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub llm_provider: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gemini_api_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chrome_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_port: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_with_windows: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub feedback_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_approve_source_packets: Option<bool>,
}

/// Prefix the old TypeScript app used to mark encrypted `geminiApiKey`
/// values. There is no secret store in M6: on save the key is written
/// as-is (plaintext), and on load a legacy `enc:v1:` prefix is stripped so
/// the key still works.
const ENCRYPTED_PREFIX: &str = "enc:v1:";

static PLAINTEXT_WARNING_LOGGED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static APPLIED_ENV: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn warn_plaintext_once() {
    // Warning (once per process): there is no safeStorage/secret store here.
    if !PLAINTEXT_WARNING_LOGGED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        log_line(
            "warn",
            "settings: secure API key storage is unavailable; API keys will be stored in plaintext",
        );
    }
}

fn applied_env() -> &'static Mutex<HashMap<String, String>> {
    APPLIED_ENV.get_or_init(|| Mutex::new(HashMap::new()))
}

fn settings_path(data_root: &Path) -> PathBuf {
    data_root.join("settings.json")
}

/// Load settings, mirroring `loadSettings`. A missing file yields the empty
/// settings; a file that is not a JSON object (array, scalar, or invalid
/// JSON) is ignored with a warning and yields the empty settings.
pub fn load_settings(data_root: &Path) -> DesktopSettings {
    let path = settings_path(data_root);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return DesktopSettings::default();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        eprintln!("settings: failed to parse settings.json — ignoring");
        return DesktopSettings::default();
    };
    if !parsed.is_object() {
        eprintln!("settings: settings.json is not a JSON object — ignoring");
        return DesktopSettings::default();
    }
    let mut settings: DesktopSettings =
        serde_json::from_value(parsed).unwrap_or_else(|_| DesktopSettings::default());

    // Compat: strip the legacy `enc:v1:` prefix (those values were stored by
    // the old TypeScript app; treat them as plaintext-equivalent, never drop).
    if let Some(key) = settings.gemini_api_key.as_deref() {
        if let Some(stripped) = key.strip_prefix(ENCRYPTED_PREFIX) {
            warn_plaintext_once();
            settings.gemini_api_key = Some(stripped.to_string());
        }
    }
    settings
}

/// Save settings via tmp+rename, pretty-printed with 2 spaces (matching
/// `JSON.stringify(..., 2)`). The `geminiApiKey` is stored as-is
/// (plaintext) — see the module docs.
pub fn save_settings(data_root: &Path, settings: &DesktopSettings) {
    // Warning (once per process): there is no safeStorage/secret store here.
    if settings.gemini_api_key.is_some() {
        warn_plaintext_once();
    }
    let path = settings_path(data_root);
    let tmp = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(settings).unwrap_or_else(|_| "{}".to_string());
    if std::fs::write(&tmp, json).is_err() {
        return;
    }
    let _ = std::fs::rename(&tmp, &path);
}

/// The env map `applySettingsToEnv` builds, with the exact env var names.
fn env_map(settings: &DesktopSettings) -> Vec<(&'static str, String)> {
    let bool_str = |value: Option<bool>| value.map(|b| (u8::from(b)).to_string());
    let map: Vec<(&'static str, String)> = vec![
        (
            "ZYQUOR_ENABLE_BROWSER_PREPARE",
            bool_str(settings.enable_browser_prepare),
        ),
        (
            "ZYQUOR_ENABLE_BROWSER_POST",
            bool_str(settings.enable_browser_post),
        ),
        (
            "ZYQUOR_BROWSER_CLOSE_AFTER_POST",
            bool_str(settings.close_chrome_after_post),
        ),
        ("ZYQUOR_BROWSER_HEADLESS", bool_str(settings.headless)),
        (
            "ZYQUOR_COMMAND_CODE_PATH",
            settings.command_code_path.clone(),
        ),
        ("ZYQUOR_OPENCODE_PATH", settings.opencode_path.clone()),
        ("ZYQUOR_OPENCODE_VARIANT", settings.opencode_variant.clone()),
        ("ZYQUOR_LLM_PROVIDER", settings.llm_provider.clone()),
        ("ZYQUOR_GEMINI_API_KEY", settings.gemini_api_key.clone()),
        ("ZYQUOR_CHROME_PATH", settings.chrome_path.clone()),
        (
            "ZYQUOR_BROWSER_CDP_PORT",
            settings.cdp_port.map(|port| port.to_string()),
        ),
        (
            "ZYQUOR_BROWSER_CDP_URL",
            settings
                .cdp_port
                .map(|port| format!("http://127.0.0.1:{port}")),
        ),
    ]
    .into_iter()
    .filter_map(|(key, value)| value.map(|v| (key, v)))
    .collect();
    map
}

/// Apply settings to env, `set-only-if-absent` unless `overwrite`, with the
/// same `String(Number(bool))` semantics (`"1"`/`"0"`). Because the process
/// environment cannot be mutated without unsafe code (see the module docs),
/// applied values are stored in the in-process snapshot instead; read them
/// back with [`settings_env_value`].
pub fn apply_settings_to_env(settings: &DesktopSettings, overwrite: bool) {
    let mut applied = match applied_env().lock() {
        Ok(applied) => applied,
        Err(_) => return,
    };
    for (key, value) in env_map(settings) {
        if overwrite || std::env::var(key).is_err() && !applied.contains_key(key) {
            applied.insert(key.to_string(), value);
        }
    }
}

/// Effective value of an env var: the process environment wins, then the
/// applied-settings snapshot (see [`apply_settings_to_env`]).
pub fn settings_env_value(key: &str) -> Option<String> {
    if let Ok(value) = std::env::var(key) {
        return Some(value);
    }
    settings_snapshot_value(key)
}

/// Snapshot-only lookup of a setting applied by
/// [`apply_settings_to_env`] / [`apply_desktop_env_defaults`].
pub fn settings_snapshot_value(key: &str) -> Option<String> {
    applied_env().lock().ok()?.get(key).cloned()
}

fn apply_one_setting_or_default(key: &str, value: String) {
    let is_absent = std::env::var(key).is_err()
        && applied_env()
            .lock()
            .map(|applied| !applied.contains_key(key))
            .unwrap_or(true);
    if is_absent {
        if let Ok(mut applied) = applied_env().lock() {
            applied.insert(key.to_string(), value);
        }
    }
}

/// Apply the desktop env defaults, using `??=` semantics (only fill in when
/// the var is unset), writing exactly the literal defaults of the TypeScript
/// `applyDesktopEnvDefaults`.
pub fn apply_desktop_env_defaults(settings: &DesktopSettings) {
    let bool_str = |value: bool| u8::from(value).to_string();
    apply_one_setting_or_default("ZYQUOR_LLM_PROVIDER", "opencode".to_string());
    apply_one_setting_or_default("ZYQUOR_COMMAND_CODE_MODEL", "gpt-5.6-luna".to_string());
    apply_one_setting_or_default(
        "ZYQUOR_OPENCODE_MODEL",
        "opencode/deepseek-v4.1-flash-free".to_string(),
    );
    apply_one_setting_or_default("ZYQUOR_OPENCODE_PATH", "opencode".to_string());
    apply_one_setting_or_default(
        "ZYQUOR_ENABLE_BROWSER_PREPARE",
        bool_str(settings.enable_browser_prepare.unwrap_or(true)),
    );
    apply_one_setting_or_default(
        "ZYQUOR_ENABLE_BROWSER_POST",
        bool_str(settings.enable_browser_post.unwrap_or(true)),
    );
    apply_one_setting_or_default("ZYQUOR_BROWSER_CHANNEL", "chrome".to_string());
    apply_one_setting_or_default(
        "ZYQUOR_BROWSER_CDP_URL",
        format!("http://127.0.0.1:{}", settings.cdp_port.unwrap_or(9222)),
    );
    apply_one_setting_or_default(
        "ZYQUOR_BROWSER_HEADLESS",
        bool_str(settings.headless.unwrap_or(false)),
    );
    apply_one_setting_or_default(
        "ZYQUOR_OLLAMA_BASE_URL",
        "http://127.0.0.1:11434".to_string(),
    );
    apply_one_setting_or_default("ZYQUOR_QUALITY_MIN", "7".to_string());
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "zyquor-settings-{name}-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn load_missing_file_yields_empty_settings() {
        let dir = temp_dir("missing");
        let settings = load_settings(&dir);
        assert_eq!(settings.cdp_port, None);
        assert_eq!(settings.llm_provider, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_garbage_file_yields_empty_settings() {
        let dir = temp_dir("garbage");
        std::fs::write(dir.join("settings.json"), "{not json").expect("write garbage");
        let settings = load_settings(&dir);
        assert_eq!(settings.cdp_port, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_non_object_file_yields_empty_settings() {
        let dir = temp_dir("nonobject");
        std::fs::write(dir.join("settings.json"), "[1, 2, 3]").expect("write array");
        let settings = load_settings(&dir);
        assert_eq!(settings.cdp_port, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_valid_json_round_trips() {
        let dir = temp_dir("valid");
        let settings = DesktopSettings {
            cdp_port: Some(9223),
            llm_provider: Some("opencode".to_string()),
            headless: Some(true),
            gemini_api_key: Some("secret".to_string()),
            ..DesktopSettings::default()
        };
        save_settings(&dir, &settings);
        let loaded = load_settings(&dir);
        assert_eq!(loaded.cdp_port, Some(9223));
        assert_eq!(loaded.llm_provider.as_deref(), Some("opencode"));
        assert_eq!(loaded.headless, Some(true));
        assert_eq!(loaded.gemini_api_key.as_deref(), Some("secret"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_strips_legacy_enc_prefix() {
        let dir = temp_dir("enc");
        std::fs::write(
            dir.join("settings.json"),
            r#"{"geminiApiKey": "enc:v1:c2VjcmV0"}"#,
        )
        .expect("write enc settings");
        let settings = load_settings(&dir);
        assert_eq!(settings.gemini_api_key.as_deref(), Some("c2VjcmV0"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_map_has_exact_names_and_bool_semantics() {
        let settings = DesktopSettings {
            enable_browser_prepare: Some(true),
            enable_browser_post: Some(false),
            close_chrome_after_post: None,
            headless: Some(true),
            command_code_path: None,
            cdp_port: Some(9222),
            ..DesktopSettings::default()
        };
        let map: HashMap<&str, String> = env_map(&settings).into_iter().collect();
        assert_eq!(
            map.get("ZYQUOR_ENABLE_BROWSER_PREPARE").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            map.get("ZYQUOR_ENABLE_BROWSER_POST").map(String::as_str),
            Some("0")
        );
        assert_eq!(map.get("ZYQUOR_BROWSER_CLOSE_AFTER_POST"), None);
        assert_eq!(
            map.get("ZYQUOR_BROWSER_HEADLESS").map(String::as_str),
            Some("1")
        );
        assert_eq!(
            map.get("ZYQUOR_BROWSER_CDP_PORT").map(String::as_str),
            Some("9222")
        );
        assert_eq!(
            map.get("ZYQUOR_BROWSER_CDP_URL").map(String::as_str),
            Some("http://127.0.0.1:9222")
        );
        assert_eq!(map.get("ZYQUOR_COMMAND_CODE_PATH"), None);
    }

    #[test]
    fn save_writes_two_space_pretty_json() {
        let dir = temp_dir("pretty");
        let settings = DesktopSettings {
            cdp_port: Some(9222),
            llm_provider: Some("opencode".to_string()),
            ..DesktopSettings::default()
        };
        save_settings(&dir, &settings);
        let text = std::fs::read_to_string(dir.join("settings.json")).expect("read back");
        assert!(text.contains("  \"cdpPort\": 9222"));
        assert!(text.contains("  \"llmProvider\": \"opencode\""));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
