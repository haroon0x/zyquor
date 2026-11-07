//! `zyquor smoke-generation` — live generation probe.
//!
//! Port of `scripts/smoke-generation.mjs`: resolve the provider config from
//! env, generate candidates for one idea, print the same JSON shape
//! (`ok`, `generation`, `candidates` on success; `ok:false`, `error` on
//! failure) and exit non-zero when generation fails.

use zyquor_generation::types::GenerateDraftCandidatesInput;
use zyquor_generation::{
    DraftGenerationProvider, ReqwestFetch, create_generation_provider_from_env,
    resolve_generation_provider_config,
};

fn env_lookup(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

pub async fn run() -> Result<i32, String> {
    let config = resolve_generation_provider_config(&env_lookup)
        .map_err(|error| format!("generation config failed: {error}"))?;

    let idea = std::env::var("ZYQUOR_SMOKE_IDEA")
        .unwrap_or_else(|_| "Make local automation auditable.".to_string());
    let count: usize = std::env::var("ZYQUOR_SMOKE_COUNT")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(2);

    let fetch = ReqwestFetch::new();
    let provider = create_generation_provider_from_env(&env_lookup, fetch)
        .map_err(|error| error.message.clone())?;

    let input = GenerateDraftCandidatesInput {
        idea,
        count: Some(count),
        ..GenerateDraftCandidatesInput::default()
    };

    match provider.generate_draft_candidates(&input).await {
        Ok(candidates) => {
            if candidates.is_empty() {
                let value = serde_json::json!({
                    "ok": false,
                    "generation": config,
                    "error": "generation smoke expected at least one candidate",
                });
                println!(
                    "{}",
                    serde_json::to_string_pretty(&value).unwrap_or_default()
                );
                return Ok(1);
            }
            let rendered: Vec<serde_json::Value> = candidates
                .iter()
                .map(|candidate| {
                    serde_json::json!({
                        "text": candidate.text,
                        "score": {
                            "provider": candidate.provider,
                            "model": candidate.model,
                            "rank": candidate.rank,
                            "quality": candidate.quality,
                        },
                    })
                })
                .collect();
            let value = serde_json::json!({
                "ok": true,
                "generation": config,
                "candidates": rendered,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            );
            Ok(0)
        }
        Err(error) => {
            let value = serde_json::json!({
                "ok": false,
                "generation": config,
                "error": error.message,
            });
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_default()
            );
            Ok(1)
        }
    }
}
