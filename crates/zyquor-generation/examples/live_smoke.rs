//! Live smoke check for the ported provider clients. Hits the real provider —
//! unlike the unit tests, which use a fake `Fetch`.
//!
//! Usage:
//!   cargo run -p zyquor-generation --example live_smoke -- <idea>
//!
//! Honours the usual env vars: `ZYQUOR_LLM_PROVIDER` (default `auto` → gemini
//! if `ZYQUOR_GEMINI_API_KEY` is set, else ollama), `ZYQUOR_OLLAMA_MODEL`,
//! `ZYQUOR_OLLAMA_BASE_URL`, `ZYQUOR_GEMINI_API_KEY`, ...
//!
//! Only run this when you intend to spend a real model call.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::time::Instant;

use zyquor_generation::types::GenerateDraftCandidatesInput;
use zyquor_generation::{
    DraftGenerationProvider, ReqwestFetch, create_generation_provider_from_env,
};

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|value| !value.is_empty())
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let idea = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "why SQLite is the right default for local-first apps".to_string());

    let fetch = ReqwestFetch::new();
    let provider =
        create_generation_provider_from_env(&env, fetch).expect("provider config should resolve");

    let provider_name = provider.name().to_string();
    let provider_model = provider.model().to_string();
    eprintln!("provider={provider_name} model={provider_model}");

    let input = GenerateDraftCandidatesInput {
        idea,
        count: Some(1),
        ..GenerateDraftCandidatesInput::default()
    };

    let started = Instant::now();
    match provider.generate_draft_candidates(&input).await {
        Ok(candidates) => {
            eprintln!(
                "ok: {} candidate(s) in {:.1?}",
                candidates.len(),
                started.elapsed()
            );
            for candidate in candidates {
                println!(
                    "--- candidate rank={} quality={} ---",
                    candidate.rank, candidate.quality
                );
                println!("{}", candidate.text);
            }
        }
        Err(error) => {
            eprintln!("failed after {:.1?}: {error}", started.elapsed());
            std::process::exit(1);
        }
    }
}
