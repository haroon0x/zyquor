//! Gemini `generateContent` provider, ported from
//! `packages/generation/src/providers/gemini.ts`.

use serde_json::{Value, json};

use crate::config::{DEFAULT_GEMINI_BASE_URL, DEFAULT_GEMINI_MODEL};
use crate::parse::as_text;
use crate::prompts::{system_prompt, user_prompt};
use crate::refine::generate_draft_candidates;
use crate::types::{GenerateDraftCandidatesInput, GenerationResult};

use super::DraftGenerationProvider;
use super::http::{Fetch, SleepFn, post_json, tokio_sleep};

fn percent_encode(value: &str) -> String {
    // Matches JavaScript `encodeURIComponent`: unreserved characters pass
    // through, everything else is UTF-8 percent-encoded.
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => encoded.push(byte as char),
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

pub struct GeminiGenerationProvider<F: Fetch> {
    api_key: String,
    base_url: String,
    model: String,
    fetch: F,
    sleep: Box<SleepFn>,
}

impl<F: Fetch> GeminiGenerationProvider<F> {
    pub fn new(api_key: String, base_url: Option<String>, model: Option<String>, fetch: F) -> Self {
        let base_url = base_url.unwrap_or_else(|| DEFAULT_GEMINI_BASE_URL.to_string());
        Self {
            api_key,
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.unwrap_or_else(|| DEFAULT_GEMINI_MODEL.to_string()),
            fetch,
            sleep: Box::new(tokio_sleep),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_sleep(mut self, sleep: Box<SleepFn>) -> Self {
        self.sleep = sleep;
        self
    }

    async fn generate(&self, prompt: String, system: Option<String>) -> GenerationResult<String> {
        let url = format!(
            "{}/models/{}:generateContent?key={}",
            self.base_url,
            percent_encode(&self.model),
            percent_encode(&self.api_key)
        );
        let mut body = json!({
            "contents": [
                {
                    "role": "user",
                    "parts": [{ "text": prompt }]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0.65,
                "maxOutputTokens": 900
            }
        });
        if let Some(system) = system {
            body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
        }

        let response = post_json(&self.fetch, &url, &body, &[], &self.sleep).await?;
        let text = response
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|candidates| candidates.first())
            .and_then(|candidate| candidate.get("content"))
            .and_then(|content| content.get("parts"))
            .and_then(Value::as_array)
            .map(|parts| {
                parts
                    .iter()
                    .map(|part| as_text(part.get("text")))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        Ok(text.trim().to_string())
    }
}

impl<F: Fetch> DraftGenerationProvider for GeminiGenerationProvider<F> {
    fn name(&self) -> &str {
        "gemini"
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
                "gemini",
                Some(
                    |generation_input: GenerateDraftCandidatesInput| async move {
                        self.generate(
                            user_prompt(&generation_input),
                            Some(system_prompt(&generation_input)),
                        )
                        .await
                    },
                ),
                |prompt: String| async move { self.generate(prompt, None).await },
                false,
            )
            .await
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::providers::http::{FetchInit, FetchResponse};
    use std::sync::Mutex;

    struct FakeFetch {
        bodies: Mutex<Vec<String>>,
    }

    impl Fetch for FakeFetch {
        fn fetch<'a>(
            &'a self,
            _url: &'a str,
            _init: FetchInit,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = GenerationResult<FetchResponse>> + Send + 'a>,
        > {
            Box::pin(async move {
                let body = self.bodies.lock().unwrap().remove(0);
                Ok(FetchResponse {
                    status: 200,
                    headers: vec![],
                    body,
                })
            })
        }
    }

    fn instant_sleep() -> Box<SleepFn> {
        Box::new(|_| Box::pin(async {}))
    }

    #[tokio::test]
    async fn gemini_joins_parts_and_returns_candidates() {
        let body = serde_json::json!({
            "candidates": [
                { "content": { "parts": [
                    { "text": "{\"candidates\":[\"draft one\",\"draft two\"]}" }
                ] } }
            ]
        })
        .to_string();
        let provider = GeminiGenerationProvider::new(
            "test-key".into(),
            Some("http://gemini.local".into()),
            Some("gemini-3.6-flash".into()),
            FakeFetch {
                bodies: Mutex::new(vec![body]),
            },
        )
        .with_sleep(instant_sleep());

        let input = GenerateDraftCandidatesInput {
            idea: "rust on embedded".to_string(),
            count: Some(2),
            ..GenerateDraftCandidatesInput::default()
        };
        let candidates = provider.generate_draft_candidates(&input).await.unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].provider, "gemini");
    }
}
