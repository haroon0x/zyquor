//! Provider selection and model allowlists, ported from
//! `packages/generation/src/config.ts`.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use zyquor_core::paths::EnvLookup;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GenerationProviderName {
    #[serde(rename = "command-code")]
    CommandCode,
    #[serde(rename = "opencode")]
    Opencode,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "ollama")]
    Ollama,
}

impl GenerationProviderName {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::CommandCode => "command-code",
            Self::Opencode => "opencode",
            Self::Gemini => "gemini",
            Self::Ollama => "ollama",
        }
    }
}

impl std::str::FromStr for GenerationProviderName {
    type Err = GenerationError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "command-code" => Ok(Self::CommandCode),
            "opencode" => Ok(Self::Opencode),
            "gemini" => Ok(Self::Gemini),
            "ollama" => Ok(Self::Ollama),
            other => Err(GenerationError::UnsupportedProvider(other.to_string())),
        }
    }
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GenerationError {
    #[error("Unsupported LLM provider: {0}")]
    UnsupportedProvider(String),
    #[error("{0}")]
    MissingCredential(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationProviderConfig {
    pub provider: GenerationProviderName,
    pub model: String,
    pub configured: bool,
    pub base_url: Option<String>,
    pub revision_pass: Option<bool>,
}

pub const DEFAULT_COMMAND_CODE_MODEL: &str = "gpt-5.6-luna";
pub const COMMAND_CODE_MODELS: &[&str] = &[DEFAULT_COMMAND_CODE_MODEL];

pub const DEFAULT_OPENCODE_MODEL: &str = "opencode/glm-5.3-flash-free";
pub const DEFAULT_OPENCODE_VARIANT: &str = "high";

// Owner-approved ladder (2026-10-29): glm 5.3 flash free first; if it is rate
// limited, glm 5.3 flash paid; then deepseek v4.1 flash paid. beam, iceman,
// flint, mimo, and nemotron tags are banned, and so is free-tag rotation
// outside this ladder.
pub const OPENCODE_MODELS: &[&str] = &[
    "opencode/glm-5.3-flash-free",
    "opencode-go/glm-5.3-flash",
    "opencode/deepseek-v4.1-flash",
];

/// Failover order the provider walks when the active tag is rate limited.
pub const OPENCODE_MODEL_POOL: &[&str] =
    &["opencode-go/glm-5.3-flash", "opencode/deepseek-v4.1-flash"];

pub const OPENCODE_VARIANTS: &[&str] = &["low", "high", "max"];

pub const DEFAULT_GEMINI_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const DEFAULT_GEMINI_MODEL: &str = "gemini-3.6-flash";
pub const GEMINI_MODELS: &[&str] = &[
    "gemini-3.6-flash",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-1.5-flash",
];

pub const DEFAULT_OLLAMA_BASE_URL: &str = "http://127.0.0.1:11434";
pub const DEFAULT_OLLAMA_MODEL: &str = "gemma4:e4b";
pub const OLLAMA_MODELS: &[&str] = &[
    "gemma4:e4b",
    "llama3.1",
    "llama3.1:8b",
    "qwen3:8b",
    "qwen2.5:7b",
    "mistral:7b",
];

fn warn(message: String) {
    // The TypeScript version uses console.warn; stderr is the closest match.
    eprintln!("{message}");
}

pub fn safe_opencode_model(model: Option<&str>) -> String {
    let Some(model) = model.filter(|value| !value.is_empty()) else {
        return DEFAULT_OPENCODE_MODEL.to_string();
    };
    if OPENCODE_MODELS.contains(&model) {
        return model.to_string();
    }
    warn(format!(
        "generation: Opencode model \"{model}\" is not on the DeepSeek Flash allowlist; using \"{DEFAULT_OPENCODE_MODEL}\""
    ));
    DEFAULT_OPENCODE_MODEL.to_string()
}

pub fn safe_opencode_variant(variant: Option<&str>) -> String {
    let Some(variant) = variant.filter(|value| !value.is_empty()) else {
        return DEFAULT_OPENCODE_VARIANT.to_string();
    };
    if OPENCODE_VARIANTS.contains(&variant) {
        return variant.to_string();
    }
    warn(format!(
        "generation: Opencode variant \"{variant}\" is not supported; using \"{DEFAULT_OPENCODE_VARIANT}\""
    ));
    DEFAULT_OPENCODE_VARIANT.to_string()
}

pub fn safe_command_code_model(model: Option<&str>) -> String {
    match model {
        Some(value) if !value.is_empty() && value != DEFAULT_COMMAND_CODE_MODEL => {
            warn(format!(
                "generation: Command Code model \"{value}\" is not supported; using \"{DEFAULT_COMMAND_CODE_MODEL}\""
            ));
            DEFAULT_COMMAND_CODE_MODEL.to_string()
        }
        _ => DEFAULT_COMMAND_CODE_MODEL.to_string(),
    }
}

fn truthy(value: Option<String>) -> bool {
    matches!(
        value.unwrap_or_default().trim().to_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|candidate| !candidate.is_empty())
}

pub fn resolve_generation_provider_config(
    env: EnvLookup<'_>,
) -> Result<GenerationProviderConfig, GenerationError> {
    let requested = non_empty(env("ZYQUOR_LLM_PROVIDER"))
        .unwrap_or_else(|| "auto".to_string())
        .to_lowercase();

    let provider = if requested == "auto" {
        if non_empty(env("ZYQUOR_GEMINI_API_KEY")).is_some() {
            GenerationProviderName::Gemini
        } else {
            GenerationProviderName::Ollama
        }
    } else {
        requested.parse::<GenerationProviderName>()?
    };

    let revision_pass = truthy(env("ZYQUOR_REVISION_PASS"));

    Ok(match provider {
        GenerationProviderName::CommandCode => GenerationProviderConfig {
            provider,
            model: safe_command_code_model(non_empty(env("ZYQUOR_COMMAND_CODE_MODEL")).as_deref()),
            configured: true,
            base_url: None,
            revision_pass: None,
        },
        GenerationProviderName::Opencode => GenerationProviderConfig {
            provider,
            model: safe_opencode_model(non_empty(env("ZYQUOR_OPENCODE_MODEL")).as_deref()),
            configured: true,
            base_url: None,
            revision_pass: Some(revision_pass),
        },
        GenerationProviderName::Gemini => GenerationProviderConfig {
            provider,
            model: non_empty(env("ZYQUOR_GEMINI_MODEL"))
                .unwrap_or_else(|| DEFAULT_GEMINI_MODEL.to_string()),
            base_url: Some(
                non_empty(env("ZYQUOR_GEMINI_BASE_URL"))
                    .unwrap_or_else(|| DEFAULT_GEMINI_BASE_URL.to_string()),
            ),
            configured: non_empty(env("ZYQUOR_GEMINI_API_KEY")).is_some(),
            revision_pass: None,
        },
        GenerationProviderName::Ollama => GenerationProviderConfig {
            provider,
            model: non_empty(env("ZYQUOR_OLLAMA_MODEL"))
                .unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.to_string()),
            base_url: Some(
                non_empty(env("ZYQUOR_OLLAMA_BASE_URL"))
                    .unwrap_or_else(|| DEFAULT_OLLAMA_BASE_URL.to_string()),
            ),
            configured: true,
            revision_pass: None,
        },
    })
}
