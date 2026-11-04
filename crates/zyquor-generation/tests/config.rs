#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Parity tests for `packages/generation/src/config.ts`.

use std::collections::HashMap;

use zyquor_generation::{
    DEFAULT_COMMAND_CODE_MODEL, DEFAULT_GEMINI_MODEL, DEFAULT_OLLAMA_MODEL, DEFAULT_OPENCODE_MODEL,
    GenerationError, GenerationProviderName, resolve_generation_provider_config,
};

fn resolve(pairs: &[(&'static str, &'static str)]) -> zyquor_generation::GenerationProviderConfig {
    let map: HashMap<&'static str, &'static str> = pairs.iter().copied().collect();
    let lookup = move |key: &str| map.get(key).map(|value| (*value).to_string());
    resolve_generation_provider_config(&lookup).unwrap()
}

#[test]
fn auto_prefers_gemini_then_ollama() {
    let gemini = resolve(&[("ZYQUOR_GEMINI_API_KEY", "key")]);
    assert_eq!(gemini.provider, GenerationProviderName::Gemini);
    assert!(gemini.configured);

    let ollama = resolve(&[]);
    assert_eq!(ollama.provider, GenerationProviderName::Ollama);
    assert!(ollama.configured);
}

#[test]
fn an_unconfigured_gemini_key_reports_unconfigured() {
    let config = resolve(&[("ZYQUOR_LLM_PROVIDER", "gemini")]);
    assert!(!config.configured);
    assert_eq!(config.model, DEFAULT_GEMINI_MODEL);
}

#[test]
fn disallowed_models_fall_back_to_the_defaults() {
    assert_eq!(
        resolve(&[
            ("ZYQUOR_LLM_PROVIDER", "opencode"),
            ("ZYQUOR_OPENCODE_MODEL", "some/other-model"),
        ])
        .model,
        DEFAULT_OPENCODE_MODEL
    );
    assert_eq!(
        resolve(&[
            ("ZYQUOR_LLM_PROVIDER", "command-code"),
            ("ZYQUOR_COMMAND_CODE_MODEL", "unknown"),
        ])
        .model,
        DEFAULT_COMMAND_CODE_MODEL
    );
    assert_eq!(
        resolve(&[("ZYQUOR_LLM_PROVIDER", "ollama")]).model,
        DEFAULT_OLLAMA_MODEL
    );
    assert_eq!(
        resolve(&[("ZYQUOR_LLM_PROVIDER", "gemini")]).model,
        DEFAULT_GEMINI_MODEL
    );
}

#[test]
fn allowlisted_models_are_kept() {
    let config = resolve(&[
        ("ZYQUOR_LLM_PROVIDER", "opencode"),
        ("ZYQUOR_OPENCODE_MODEL", "opencode/deepseek-v4.1-flash"),
    ]);
    assert_eq!(config.model, "opencode/deepseek-v4.1-flash");
}

#[test]
fn revision_pass_accepts_the_same_truthy_values() {
    for value in ["1", "true", "yes", "on", " TRUE "] {
        let config = resolve(&[
            ("ZYQUOR_LLM_PROVIDER", "opencode"),
            ("ZYQUOR_REVISION_PASS", value),
        ]);
        assert_eq!(config.revision_pass, Some(true), "value {value}");
    }
    let off = resolve(&[
        ("ZYQUOR_LLM_PROVIDER", "opencode"),
        ("ZYQUOR_REVISION_PASS", "0"),
    ]);
    assert_eq!(off.revision_pass, Some(false));
}

#[test]
fn an_unknown_provider_is_rejected() {
    let map: HashMap<&'static str, &'static str> =
        [("ZYQUOR_LLM_PROVIDER", "gpt5")].into_iter().collect();
    let lookup = move |key: &str| map.get(key).map(|value| (*value).to_string());
    let error = resolve_generation_provider_config(&lookup).unwrap_err();
    assert_eq!(
        error,
        GenerationError::UnsupportedProvider("gpt5".to_string())
    );
}

#[test]
fn provider_names_use_the_wire_spellings() {
    assert_eq!(GenerationProviderName::CommandCode.as_str(), "command-code");
    assert_eq!(
        "opencode".parse::<GenerationProviderName>().unwrap(),
        GenerationProviderName::Opencode
    );
}
