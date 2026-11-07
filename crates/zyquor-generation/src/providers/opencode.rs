//! Opencode CLI provider, ported from
//! `packages/generation/src/providers/opencode.ts`.
//!
//! Includes the failover ladder: when a model is throttled or unavailable, the
//! next approved tag in the ladder is tried. The trigger is deliberately
//! narrow — the CLI's rate-limit and unavailable-model shutters only.
//! Transient network drops never rotate; they surface as a clean failure and
//! the refine layer retries.

use fancy_regex::Regex;

use crate::config::{OPENCODE_MODEL_POOL, safe_opencode_model, safe_opencode_variant};
use crate::parse::parse_json_candidate_texts;
use crate::refine::generate_draft_candidates;
use crate::types::{GenerateDraftCandidatesInput, GenerationResult};

use super::DraftGenerationProvider;
use super::cli::{maybe_write_llm_debug, run_cli};

const DEFAULT_TIMEOUT_MS: u64 = 300_000;
const MAX_OUTPUT_BYTES: usize = 1_000_000;
const MAX_PARSE_COUNT: usize = 32;

// Rate-limit / unavailable-model shutters in the opencode CLI's error output.
const LADDER_ERROR_PATTERN: &str =
    r"(?i)free usage limit reached|model unavailable|insufficient account funds|switch models";

fn pool_from(primary: &str) -> Vec<String> {
    let mut pool = vec![primary.to_string()];
    for candidate in OPENCODE_MODEL_POOL {
        if *candidate != primary {
            pool.push((*candidate).to_string());
        }
    }
    pool
}

fn is_ladder_error(message: &str) -> bool {
    Regex::new(LADDER_ERROR_PATTERN)
        .map(|regex| regex.is_match(message).unwrap_or(false))
        .unwrap_or(false)
}

pub struct OpencodeGenerationProvider {
    command: String,
    model: String,
    variant: String,
    timeout_ms: u64,
    revise: bool,
    pool: Vec<String>,
}

impl OpencodeGenerationProvider {
    pub fn new(
        command: Option<String>,
        model: Option<String>,
        variant: Option<String>,
        timeout_ms: Option<u64>,
        revise: bool,
    ) -> Self {
        let model = safe_opencode_model(model.as_deref());
        let variant = safe_opencode_variant(variant.as_deref());
        Self {
            command: command
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("opencode")
                .to_string(),
            pool: pool_from(&model),
            model,
            variant,
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
            revise,
        }
    }

    fn model_arg(&self, model: &str) -> String {
        // opencode v2.x: the reasoning variant is part of --model
        // (provider/model#variant). The legacy separate --variant/--pure
        // flags are no longer recognized.
        if self.variant.is_empty() {
            model.to_string()
        } else {
            format!("{model}#{}", self.variant)
        }
    }

    async fn run_one(&self, model: &str, prompt: &str) -> GenerationResult<String> {
        let output = run_cli(
            &self.command,
            &["run", "-m", &self.model_arg(model)],
            prompt,
            self.timeout_ms,
            MAX_OUTPUT_BYTES,
            "Opencode",
            "Install opencode (https://opencode.ai) and run opencode auth.",
        )
        .await?;

        // Raw request/response audit hook: ZYQUOR_LLM_DEBUG=1 drops the exact
        // prompt and raw model stdout next to the other artifacts.
        maybe_write_llm_debug(prompt, &output.stdout);

        match output.code {
            Some(0) => Ok(output.stdout),
            code => {
                // opencode v2.x sometimes exits 1 after a complete answer when
                // its session write hits a transient connection drop. The
                // client can also die partway through streaming, leaving
                // truncated JSON on stdout, so parsing here must never throw:
                // a malformed payload goes to the normal error path and the
                // refine layer retries.
                if !output.stdout.is_empty()
                    && parse_json_candidate_texts(&output.stdout, MAX_PARSE_COUNT)
                        .is_some_and(|texts| texts.iter().any(|text| !text.trim().is_empty()))
                {
                    return Ok(output.stdout);
                }
                let details = if output.stderr.is_empty() {
                    output.stdout
                } else {
                    output.stderr
                };
                let details: String = details.chars().take(1000).collect();
                Err(crate::types::GenerationRequestError::transport(format!(
                    "Opencode generation failed with exit code {}: {details}",
                    code.map(|value| value.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                )))
            }
        }
    }

    async fn run_chain(&self, prompt: &str) -> GenerationResult<String> {
        let mut last_error: Option<crate::types::GenerationRequestError> = None;
        for model in &self.pool {
            let failure = match self.run_one(model, prompt).await {
                Ok(output) => return Ok(output),
                Err(error) => error,
            };
            if !is_ladder_error(&failure.message) {
                return Err(failure);
            }
            last_error = Some(failure);
        }
        Err(last_error.unwrap_or_else(|| {
            crate::types::GenerationRequestError::transport(
                "Opencode generation failed on every model in the approved ladder",
            )
        }))
    }
}

impl DraftGenerationProvider for OpencodeGenerationProvider {
    fn name(&self) -> &str {
        "opencode"
    }

    fn model(&self) -> &str {
        &self.model
    }

    fn generate_draft_candidates<'a>(
        &'a self,
        input: &'a GenerateDraftCandidatesInput,
    ) -> super::DraftFuture<'a> {
        Box::pin(async move {
            generate_draft_candidates(
                input,
                &self.model,
                "opencode",
                None::<
                    fn(
                        GenerateDraftCandidatesInput,
                    ) -> std::future::Ready<GenerationResult<String>>,
                >,
                |prompt: String| async move { self.run_chain(&prompt).await },
                self.revise,
            )
            .await
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn default_pool_starts_with_primary() {
        let provider = OpencodeGenerationProvider::new(None, None, None, None, false);
        assert_eq!(
            provider.pool.first().map(String::as_str),
            Some(provider.model.as_str())
        );
        assert!(
            provider
                .pool
                .contains(&"opencode-go/glm-5.3-flash".to_string())
        );
    }

    #[test]
    fn ladder_pattern_matches_only_shutters() {
        assert!(is_ladder_error("Free usage limit reached for this model"));
        assert!(is_ladder_error("model unavailable"));
        assert!(!is_ladder_error("network ECONNRESET mid-stream"));
    }
}
