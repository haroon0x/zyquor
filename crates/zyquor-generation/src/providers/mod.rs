//! Generation provider clients, ported from `packages/generation/src/providers/`.
//!
//! Each provider implements [`DraftGenerationProvider`]. The TypeScript
//! `index.ts` factory becomes [`create_generation_provider_from_env`], which
//! returns the [`GenerationProvider`] enum so the concrete HTTP client can
//! remain generic.

use std::future::Future;
use std::pin::Pin;

use zyquor_core::paths::EnvLookup;

use crate::config::{GenerationProviderName, resolve_generation_provider_config};
use crate::types::{
    GenerateDraftCandidatesInput, GeneratedDraftCandidate, GenerationRequestError, GenerationResult,
};

pub mod cli;
pub mod cli_env;
pub mod command_code;
pub mod gemini;
pub mod http;
pub mod ollama;
pub mod opencode;

pub use cli_env::provider_process_env;
pub use command_code::CommandCodeGenerationProvider;
pub use gemini::GeminiGenerationProvider;
pub use http::{
    Fetch, FetchInit, FetchResponse, ReqwestFetch, SleepFn, backoff_ms, post_json, tokio_sleep,
};
pub use ollama::{OllamaGenerationProvider, strip_thinking};
pub use opencode::OpencodeGenerationProvider;

/// Boxed future returned by [`DraftGenerationProvider::generate_draft_candidates`].
pub type DraftFuture<'a> =
    Pin<Box<dyn Future<Output = GenerationResult<Vec<GeneratedDraftCandidate>>> + Send + 'a>>;

/// The `DraftGenerationProvider` interface from `packages/generation/src/types.ts`.
/// Object-safe via boxed futures.
pub trait DraftGenerationProvider: Send + Sync {
    fn name(&self) -> &str;
    fn model(&self) -> &str;
    fn generate_draft_candidates<'a>(
        &'a self,
        input: &'a GenerateDraftCandidatesInput,
    ) -> DraftFuture<'a>;
}

/// Concrete provider selected by [`create_generation_provider_from_env`].
pub enum GenerationProvider<F: Fetch> {
    CommandCode(CommandCodeGenerationProvider),
    Opencode(OpencodeGenerationProvider),
    Gemini(GeminiGenerationProvider<F>),
    Ollama(OllamaGenerationProvider<F>),
}

impl<F: Fetch> DraftGenerationProvider for GenerationProvider<F> {
    fn name(&self) -> &str {
        match self {
            Self::CommandCode(provider) => provider.name(),
            Self::Opencode(provider) => provider.name(),
            Self::Gemini(provider) => provider.name(),
            Self::Ollama(provider) => provider.name(),
        }
    }

    fn model(&self) -> &str {
        match self {
            Self::CommandCode(provider) => provider.model(),
            Self::Opencode(provider) => provider.model(),
            Self::Gemini(provider) => provider.model(),
            Self::Ollama(provider) => provider.model(),
        }
    }

    fn generate_draft_candidates<'a>(
        &'a self,
        input: &'a GenerateDraftCandidatesInput,
    ) -> DraftFuture<'a> {
        match self {
            Self::CommandCode(provider) => provider.generate_draft_candidates(input),
            Self::Opencode(provider) => provider.generate_draft_candidates(input),
            Self::Gemini(provider) => provider.generate_draft_candidates(input),
            Self::Ollama(provider) => provider.generate_draft_candidates(input),
        }
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|candidate| !candidate.trim().is_empty())
}

/// The `createGenerationProviderFromEnv` factory from `packages/generation/src/index.ts`.
/// `env` mirrors `process.env` (injectable for tests); `fetch` backs the two
/// HTTP providers.
pub fn create_generation_provider_from_env<F: Fetch>(
    env: EnvLookup<'_>,
    fetch: F,
) -> GenerationResult<GenerationProvider<F>> {
    let config = resolve_generation_provider_config(env)
        .map_err(|error| GenerationRequestError::configuration(error.to_string()))?;

    match config.provider {
        GenerationProviderName::CommandCode => Ok(GenerationProvider::CommandCode(
            CommandCodeGenerationProvider::new(
                non_empty(env("ZYQUOR_COMMAND_CODE_PATH")),
                config.model,
                None,
            ),
        )),
        GenerationProviderName::Opencode => Ok(GenerationProvider::Opencode(
            OpencodeGenerationProvider::new(
                non_empty(env("ZYQUOR_OPENCODE_PATH")),
                non_empty(env("ZYQUOR_OPENCODE_MODEL")),
                non_empty(env("ZYQUOR_OPENCODE_VARIANT")),
                None,
                config.revision_pass.unwrap_or(false),
            ),
        )),
        GenerationProviderName::Ollama => Ok(GenerationProvider::Ollama(
            OllamaGenerationProvider::new(config.base_url, Some(config.model), fetch),
        )),
        GenerationProviderName::Gemini => {
            let api_key = non_empty(env("ZYQUOR_GEMINI_API_KEY")).ok_or_else(|| {
                GenerationRequestError::configuration(
                    "ZYQUOR_GEMINI_API_KEY is required when ZYQUOR_LLM_PROVIDER=gemini",
                )
            })?;
            Ok(GenerationProvider::Gemini(GeminiGenerationProvider::new(
                api_key,
                config.base_url,
                Some(config.model),
                fetch,
            )))
        }
    }
}
