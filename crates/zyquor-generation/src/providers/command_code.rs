//! Command Code CLI provider, ported from
//! `packages/generation/src/providers/command-code.ts`.

use crate::refine::generate_draft_candidates;
use crate::types::{GenerateDraftCandidatesInput, GenerationResult};

use super::DraftGenerationProvider;
use super::cli::run_cli;

const DEFAULT_TIMEOUT_MS: u64 = 180_000;
const MAX_OUTPUT_BYTES: usize = 1_000_000;

pub struct CommandCodeGenerationProvider {
    command: String,
    model: String,
    timeout_ms: u64,
}

impl CommandCodeGenerationProvider {
    pub fn new(command: Option<String>, model: String, timeout_ms: Option<u64>) -> Self {
        Self {
            command: command
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("command-code")
                .to_string(),
            model,
            timeout_ms: timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS),
        }
    }

    async fn run(&self, prompt: &str) -> GenerationResult<String> {
        let output = run_cli(
            &self.command,
            &[
                "--skip-onboarding",
                "--permission-mode",
                "plan",
                "--model",
                &self.model,
                "--print",
            ],
            prompt,
            self.timeout_ms,
            MAX_OUTPUT_BYTES,
            "Command Code",
            "Install it and run command-code login.",
        )
        .await?;

        match output.code {
            Some(0) => Ok(output.stdout),
            code => {
                let details = if output.stderr.is_empty() {
                    output.stdout
                } else {
                    output.stderr
                };
                let details: String = details.chars().take(1000).collect();
                Err(crate::types::GenerationRequestError::transport(format!(
                    "Command Code generation failed with exit code {}: {details}",
                    code.map(|value| value.to_string())
                        .unwrap_or_else(|| "unknown".to_string())
                )))
            }
        }
    }
}

impl DraftGenerationProvider for CommandCodeGenerationProvider {
    fn name(&self) -> &str {
        "command-code"
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
                "command-code",
                None::<
                    fn(
                        GenerateDraftCandidatesInput,
                    ) -> std::future::Ready<GenerationResult<String>>,
                >,
                |prompt: String| async move { self.run(&prompt).await },
                false,
            )
            .await
        })
    }
}
