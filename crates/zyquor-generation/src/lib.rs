//! Draft generation: provider selection and deterministic quality scoring.
//!
//! Rust port of `packages/generation`. The quality and config modules are
//! ported; the provider HTTP/CLI clients and prompt assembly are not yet
//! (see `docs/rust-migration.md`).

pub mod config;
pub mod quality;

pub use config::{
    COMMAND_CODE_MODELS, DEFAULT_COMMAND_CODE_MODEL, DEFAULT_GEMINI_BASE_URL, DEFAULT_GEMINI_MODEL,
    DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL, DEFAULT_OPENCODE_MODEL,
    DEFAULT_OPENCODE_VARIANT, GEMINI_MODELS, GenerationError, GenerationProviderConfig,
    GenerationProviderName, OLLAMA_MODELS, OPENCODE_MODEL_POOL, OPENCODE_MODELS, OPENCODE_VARIANTS,
    resolve_generation_provider_config, safe_command_code_model, safe_opencode_model,
    safe_opencode_variant,
};
pub use quality::{
    DEFAULT_QUALITY_MIN, DEFAULT_REPLY_QUALITY_MIN, REPLY_DODGE_REASON, format_tweet_text,
    is_clean_tweet_text, is_interrogation_dodge_reply, passes_tweet_quality_floor,
    post_process_tweet_text, quality_minimum, reply_quality_minimum, score_tweet_quality,
};
