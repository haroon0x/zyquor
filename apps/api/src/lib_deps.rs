//! Small app-level shared knowledge: generation-config file read/write and
//! environment merging (port of `lib/generation.ts`).

use std::path::{Path, PathBuf};

use zyquor_core::paths::EnvLookup;

use zyquor_generation::resolve_generation_provider_config;

pub fn generation_config_path() -> Option<PathBuf> {
    // Mirrors `defaultGenerationConfigPath()` — dataDir/generation.json.
    Some(zyquor_core::paths::data_path(["generation.json"]))
}

pub fn read_saved_generation_env(config_path: Option<&Path>) -> Vec<(String, String)> {
    let Some(config_path) = config_path else {
        return Vec::new();
    };
    let Ok(contents) = std::fs::read_to_string(config_path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return Vec::new();
    };
    let provider = parsed
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let model = parsed
        .get("model")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    let (Some(provider), Some(model)) = (provider, model) else {
        return Vec::new();
    };
    let revision_pass = parsed
        .get("revisionPass")
        .map(|value| {
            value
                .as_str()
                .map(|text| {
                    ["1", "true", "yes", "on"].contains(&text.trim().to_lowercase().as_str())
                })
                .unwrap_or(false)
        })
        .unwrap_or(false);

    let mut out = vec![("ZYQUOR_LLM_PROVIDER".to_string(), provider.clone())];
    if revision_pass {
        out.push(("ZYQUOR_REVISION_PASS".to_string(), "1".to_string()));
    }
    match provider.as_str() {
        "command-code" => out.push(("ZYQUOR_COMMAND_CODE_MODEL".to_string(), model)),
        "opencode" => out.push(("ZYQUOR_OPENCODE_MODEL".to_string(), model)),
        "gemini" => out.push(("ZYQUOR_GEMINI_MODEL".to_string(), model)),
        "ollama" => out.push(("ZYQUOR_OLLAMA_MODEL".to_string(), model)),
        _ => {}
    }
    out
}

/// Owned snapshot of the generation environment (`deps.generationEnv` in TS:
/// the process env merged with the saved generation config). The snapshot is
/// what `GET /generation` resolves and what `PATCH /generation` /
/// `PATCH /settings` mutate before rebuilding the provider — never the process
/// environment again, so a live change stays live.
// Deliberately not `Debug`: the snapshot holds provider API keys.
#[derive(Clone, Default)]
pub struct GenerationEnvironment {
    values: std::collections::HashMap<String, String>,
}

impl GenerationEnvironment {
    pub fn from_map(values: std::collections::HashMap<String, String>) -> Self {
        Self { values }
    }

    pub fn get(&self, key: &str) -> Option<String> {
        self.values.get(key).cloned()
    }

    /// Set (or delete, with `None`) one env key, like spreading an
    /// `undefined` value over the TS `generationEnv` object.
    pub fn set(&mut self, key: &str, value: Option<String>) {
        match value {
            Some(value) => {
                self.values.insert(key.to_string(), value);
            }
            None => {
                self.values.remove(key);
            }
        }
    }

    /// The env lookup the provider factory / config resolver expects.
    pub fn lookup(&self) -> impl Fn(&str) -> Option<String> + '_ {
        move |key| self.get(key)
    }
}

/// Snapshot the boot generation env the way `app.ts` builds
/// `{...baseGenerationEnv, ...savedGenerationEnv}`: the real process env, then
/// the desktop settings snapshot for keys the process env does not set
/// (the Rust `applySettingsToEnv` equivalent), then the saved config file on
/// top (spread order: saved wins).
pub fn boot_generation_environment(
    settings_env: Option<&std::collections::HashMap<String, String>>,
    config_path: Option<&Path>,
) -> GenerationEnvironment {
    let mut values: std::collections::HashMap<String, String> = std::env::vars().collect();
    if let Some(settings_env) = settings_env {
        for (key, value) in settings_env {
            values.entry(key.clone()).or_insert_with(|| value.clone());
        }
    }
    for (key, value) in read_saved_generation_env(config_path) {
        values.insert(key, value);
    }
    GenerationEnvironment::from_map(values)
}

/// Write the saved generation config file (provider/model/revisionPass after
/// resolving through the loaded config).
pub fn write_saved_generation_env(config_path: &Path, env: EnvLookup<'_>) -> Result<(), String> {
    let config = resolve_generation_provider_config(env).map_err(|error| error.to_string())?;
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let contents = serde_json::json!({
        "provider": config.provider.as_str(),
        "model": config.model,
        "revisionPass": if config.revision_pass.unwrap_or(false) { "1" } else { "0" },
    });
    std::fs::write(
        config_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&contents).map_err(|error| error.to_string())?
        ),
    )
    .map_err(|error| error.to_string())
}

/// The merged lookup used to resolve the generation provider from the real
/// process env + saved config (boot-time helper for routes without state).
pub fn merged_generation_env(base_env: EnvLookup<'_>) -> impl Fn(&str) -> Option<String> + '_ {
    // `saved config overrides base env`, like TS's spread order.
    let saved = read_saved_generation_env(generation_config_path().as_deref());
    let saved = saved.clone();
    move |key| {
        if let Some((_, value)) = saved.iter().find(|(saved_key, _)| saved_key == key) {
            return Some(value.clone());
        }
        base_env(key)
    }
}

/// The `ZYQUOR_REVISION_PASS` flag, truthy-decoded like TS.
pub fn revision_pass_enabled(value: Option<String>) -> bool {
    value
        .map(|value| ["1", "true", "yes", "on"].contains(&value.trim().to_lowercase().as_str()))
        .unwrap_or(false)
}
