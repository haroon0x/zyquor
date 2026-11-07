//! Ollama `/api/chat` provider, ported from
//! `packages/generation/src/providers/ollama.ts`, including `stripThinking`.
//!
//! Local models like Gemma frequently leak chain-of-thought (`Thinking...`
//! preambles and `<think>…</think>` blocks) before the answer. The parser is
//! lenient by design: it trims the thinking preamble and returns the first
//! structured content it can find.

use fancy_regex::Regex;
use serde_json::json;

use crate::config::{DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL};
use crate::parse::as_text;
use crate::prompts::{system_prompt, user_prompt};
use crate::refine::generate_draft_candidates;
use crate::types::{GenerateDraftCandidatesInput, GenerationResult};

use super::DraftGenerationProvider;
use super::http::{Fetch, SleepFn, post_json, tokio_sleep};

// All patterns passed here are anchored at `^`, so "replace all" is exactly
// "replace the (single) first match" — the TypeScript `String.replace` semantics.
fn replace_anchored(pattern: &str, text: &str, replacement: &str) -> String {
    match Regex::new(pattern) {
        Ok(regex) => regex.replace_all(text, replacement).into_owned(),
        Err(_) => text.to_string(),
    }
}

/// `stripThinking` from TypeScript.
pub fn strip_thinking(text: &str) -> String {
    let without_tags = match Regex::new(r"(?i)<think\b[^>]*>[\s\S]*?</think\s*>") {
        Ok(regex) => regex.replace_all(text, "").trim().to_string(),
        Err(_) => text.trim().to_string(),
    };

    let mut stripped = without_tags;
    loop {
        let is_thinking = match Regex::new(r"(?i)^Thinking(?:\.\.\.|…|:)") {
            Ok(regex) => regex.is_match(&stripped).unwrap_or(false),
            Err(_) => false,
        };
        if !is_thinking {
            return stripped;
        }

        let content_start =
            Regex::new(r"(?:^|\r?\n)\s*(?:(?:```(?:json)?\s*)?[\[{]|(?:Draft|Candidate)\s*1\s*:)")
                .ok()
                .and_then(|regex| regex.find(&stripped).ok().flatten())
                .map(|found| found.start())
                .unwrap_or(0);
        if content_start > 0 {
            return stripped[content_start..].trim().to_string();
        }

        let without_section = replace_anchored(
            r"(?i)^Thinking(?:\.\.\.|…|:)[^\r\n]*(?:\r?\n(?!\s*$)[^\r\n]*)*\r?\n\s*\r?\n",
            &stripped,
            "",
        )
        .trim()
        .to_string();
        if without_section == stripped {
            return replace_anchored(
                r"(?i)^Thinking(?:\.\.\.|…|:)[^\r\n]*(?:\r?\n)?",
                &stripped,
                "",
            )
            .trim()
            .to_string();
        }
        stripped = without_section;
    }
}

pub struct OllamaGenerationProvider<F: Fetch> {
    base_url: String,
    model: String,
    fetch: F,
    sleep: Box<SleepFn>,
}

impl<F: Fetch> OllamaGenerationProvider<F> {
    pub fn new(base_url: Option<String>, model: Option<String>, fetch: F) -> Self {
        let base_url = base_url.unwrap_or_else(|| DEFAULT_OLLAMA_BASE_URL.to_string());
        Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            model: model.unwrap_or_else(|| DEFAULT_OLLAMA_MODEL.to_string()),
            fetch,
            sleep: Box::new(tokio_sleep),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_sleep(mut self, sleep: Box<SleepFn>) -> Self {
        self.sleep = sleep;
        self
    }

    async fn chat(
        &self,
        messages: &[(String, String)],
        num_predict: u32,
    ) -> GenerationResult<String> {
        let url = format!("{}/api/chat", self.base_url);
        let messages: Vec<serde_json::Value> = messages
            .iter()
            .map(|(role, content)| json!({ "role": role, "content": content }))
            .collect();
        let body = json!({
            "model": self.model,
            "messages": messages,
            "stream": false,
            "format": "json",
            "think": false,
            "options": {
                "temperature": 0.6,
                "num_predict": num_predict
            }
        });

        let response = post_json(&self.fetch, &url, &body, &[], &self.sleep).await?;
        let raw = response
            .get("message")
            .and_then(|message| message.get("content"))
            .map(|content| as_text(Some(content)))
            .unwrap_or_default();
        Ok(strip_thinking(&raw))
    }
}

impl<F: Fetch> DraftGenerationProvider for OllamaGenerationProvider<F> {
    fn name(&self) -> &str {
        "ollama"
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
                "ollama",
                Some(|generation_input: GenerateDraftCandidatesInput| async move {
                    self.chat(
                        &[
                            ("system".to_string(), system_prompt(&generation_input)),
                            ("user".to_string(), user_prompt(&generation_input)),
                        ],
                        900,
                    )
                    .await
                }),
                |prompt: String| async move {
                    self.chat(&[("user".to_string(), prompt)], 900).await
                },
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
    use crate::providers::http::{Fetch, FetchInit, FetchResponse};
    use std::sync::Mutex;

    struct FakeFetch {
        bodies: Mutex<Vec<String>>,
        seen: Mutex<Vec<(String, FetchInit)>>,
    }

    impl FakeFetch {
        fn new(bodies: Vec<String>) -> Self {
            Self {
                bodies: Mutex::new(bodies),
                seen: Mutex::new(Vec::new()),
            }
        }
    }

    impl Fetch for FakeFetch {
        fn fetch<'a>(
            &'a self,
            url: &'a str,
            init: FetchInit,
        ) -> std::pin::Pin<
            Box<dyn std::future::Future<Output = GenerationResult<FetchResponse>> + Send + 'a>,
        > {
            Box::pin(async move {
                self.seen.lock().unwrap().push((url.to_string(), init));
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
    async fn ollama_chat_returns_parsed_candidates() {
        let body = serde_json::json!({
            "message": { "content": "{\"candidates\":[\"draft one\",\"draft two\"]}" }
        })
        .to_string();
        let provider = OllamaGenerationProvider::new(
            Some("http://ollama.local".into()),
            Some("gemma4:e4b".into()),
            FakeFetch::new(vec![body]),
        )
        .with_sleep(instant_sleep());

        let input = GenerateDraftCandidatesInput {
            idea: "rust on embedded".to_string(),
            count: Some(2),
            ..GenerateDraftCandidatesInput::default()
        };
        let candidates = provider.generate_draft_candidates(&input).await.unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].text, "draft one");
        assert_eq!(candidates[0].provider, "ollama");
    }

    #[test]
    fn strip_thinking_removes_think_blocks() {
        assert_eq!(
            strip_thinking("<think>long chain of thought</think>draft one"),
            "draft one"
        );
    }

    #[test]
    fn strip_thinking_drops_thinking_preamble() {
        let input =
            "Thinking: I should write something\nabout GPUs\n\n{\"candidates\":[\"real answer\"]}";
        assert_eq!(strip_thinking(input), "{\"candidates\":[\"real answer\"]}");
    }
}
