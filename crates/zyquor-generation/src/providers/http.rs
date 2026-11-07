//! Minimal HTTP client seam for the generation providers, mirroring
//! `packages/generation/src/types.ts` (`FetchLike`) and
//! `packages/generation/src/providers/http.ts`.
//!
//! Production code uses [`ReqwestFetch`]; tests inject a fake [`Fetch`] so the
//! suite never touches the network. The retry policy (status allowlist,
//! attempt cap, `retry-after`/`x-ratelimit-reset` handling) is ported
//! byte-for-byte in behaviour from TypeScript.

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::Value;

use crate::types::{GenerationRequestError, GenerationResult};

/// One outgoing request. Mirrors the subset of `RequestInit` the providers use.
#[derive(Debug, Clone)]
pub struct FetchInit {
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

/// One incoming response, body already read to a string (the TypeScript side
/// does the same: `response.json()` / `response.text()`).
#[derive(Debug, Clone)]
pub struct FetchResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl FetchResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// Case-insensitive header lookup, matching the TypeScript `Headers.get`.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// The `FetchLike` seam. Object-safe via boxed futures.
pub trait Fetch: Send + Sync {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        init: FetchInit,
    ) -> Pin<Box<dyn Future<Output = GenerationResult<FetchResponse>> + Send + 'a>>;
}

/// Sleep hook so tests can replace `tokio::time::sleep` with an instant no-op.
/// The returned future is `'static` (it owns its duration).
pub type SleepFn = dyn Fn(Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync;

/// Default sleep: `tokio::time::sleep`.
pub fn tokio_sleep(duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send>> {
    Box::pin(tokio::time::sleep(duration))
}

const RETRY_STATUSES: &[u16] = &[429, 500, 502, 503, 504];
const MAX_ATTEMPTS: u32 = 4;
const BASE_BACKOFF_MS: u64 = 2000;
const MAX_BACKOFF_MS: u64 = 70_000;
const NEAR_RESET_THRESHOLD_MS: u64 = 90_000;

fn is_retryable(status: u16) -> bool {
    RETRY_STATUSES.contains(&status)
}

/// `Number(value)` from JavaScript, for the numeric header fields.
fn parse_js_number(value: &str) -> Option<f64> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed
        .parse::<f64>()
        .ok()
        .filter(|number| number.is_finite())
}

/// Backoff in milliseconds for `attempt` (1-based), ported from `backoffMs`.
/// `now_ms` is the current time in `Date.now()` milliseconds.
pub fn backoff_ms(
    attempt: u32,
    retry_after: Option<&str>,
    rate_limit_reset: Option<&str>,
    now_ms: u64,
) -> u64 {
    if let Some(seconds) = retry_after.and_then(parse_js_number) {
        if seconds > 0.0 {
            return ((seconds * 1000.0).min(MAX_BACKOFF_MS as f64)) as u64;
        }
    }

    let mut wait_from_reset: Option<u64> = None;
    if let Some(reset_value) = rate_limit_reset.and_then(parse_js_number) {
        // Epoch seconds vs epoch milliseconds: values under 1e12 are seconds.
        let reset_at = if reset_value > 0.0 && reset_value < 1_000_000_000_000.0 {
            reset_value * 1000.0
        } else {
            reset_value
        };
        let now = now_ms as f64;
        if reset_at.is_finite() && reset_at > now {
            let wait_ms = reset_at - now;
            wait_from_reset = Some(if wait_ms <= NEAR_RESET_THRESHOLD_MS as f64 {
                (wait_ms + 500.0) as u64
            } else {
                MAX_BACKOFF_MS
            });
        }
    }

    wait_from_reset.unwrap_or_else(|| {
        let exponential = BASE_BACKOFF_MS as f64 * 2_f64.powi(attempt as i32 - 1);
        exponential.min(MAX_BACKOFF_MS as f64) as u64
    })
}

/// `postJson` from TypeScript: POST JSON with bounded retries on transient
/// statuses. Non-retryable responses break the loop immediately; the final
/// error message keeps the TypeScript shape (`Generation request failed: ...`).
pub async fn post_json(
    fetch: &dyn Fetch,
    url: &str,
    body: &Value,
    headers: &[(String, String)],
    sleep: &SleepFn,
) -> GenerationResult<Value> {
    let serialized = serde_json::to_string(body)
        .map_err(|error| GenerationRequestError::invalid_response(error.to_string()))?;

    let mut last_status: u16 = 0;
    let mut last_detail = String::new();

    for attempt in 1..=MAX_ATTEMPTS {
        // TypeScript spreads headers over the default content-type, so a
        // provider-supplied `content-type` wins; mirror that instead of
        // sending both.
        let mut all_headers: Vec<(String, String)> =
            vec![("content-type".to_string(), "application/json".to_string())];
        for (key, value) in headers {
            all_headers.retain(|(existing, _)| !existing.eq_ignore_ascii_case(key));
            all_headers.push((key.clone(), value.clone()));
        }

        let response = fetch
            .fetch(
                url,
                FetchInit {
                    method: "POST".to_string(),
                    headers: all_headers,
                    body: Some(serialized.clone()),
                },
            )
            .await?;

        if response.ok() {
            return serde_json::from_str(&response.body)
                .map_err(|error| GenerationRequestError::invalid_response(error.to_string()));
        }

        last_status = response.status;
        last_detail = response.body.clone();

        if !is_retryable(response.status) || attempt == MAX_ATTEMPTS {
            break;
        }

        sleep(Duration::from_millis(backoff_ms(
            attempt,
            response.header("retry-after"),
            response.header("x-ratelimit-reset"),
            now_epoch_millis(),
        )))
        .await;
    }

    let detail = if last_detail.is_empty() {
        String::new()
    } else {
        format!(" {last_detail}")
    };
    Err(GenerationRequestError::transport(format!(
        "Generation request failed: {last_status}{detail}"
    )))
}

fn now_epoch_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Production [`Fetch`] backed by `reqwest`.
#[derive(Clone)]
pub struct ReqwestFetch {
    client: reqwest::Client,
}

impl ReqwestFetch {
    pub fn new() -> Self {
        Self {
            client: reqwest::Client::new(),
        }
    }
}

impl Default for ReqwestFetch {
    fn default() -> Self {
        Self::new()
    }
}

impl Fetch for ReqwestFetch {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        init: FetchInit,
    ) -> Pin<Box<dyn Future<Output = GenerationResult<FetchResponse>> + Send + 'a>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(init.method.as_bytes())
                .map_err(|error| GenerationRequestError::transport(error.to_string()))?;
            let mut request = self.client.request(method, url);
            for (key, value) in init.headers {
                request = request.header(key, value);
            }
            if let Some(body) = init.body {
                request = request.body(body);
            }
            let response = request
                .send()
                .await
                .map_err(|error| GenerationRequestError::transport(error.to_string()))?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .map(|(name, value)| {
                    (
                        name.as_str().to_string(),
                        value.to_str().unwrap_or("").to_string(),
                    )
                })
                .collect();
            let body = response.text().await.unwrap_or_default();
            Ok(FetchResponse {
                status,
                headers,
                body,
            })
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    struct FakeFetch {
        responses: std::sync::Mutex<Vec<FetchResponse>>,
        calls: std::sync::Mutex<u32>,
    }

    impl Fetch for FakeFetch {
        fn fetch<'a>(
            &'a self,
            _url: &'a str,
            _init: FetchInit,
        ) -> Pin<Box<dyn Future<Output = GenerationResult<FetchResponse>> + Send + 'a>> {
            Box::pin(async move {
                *self.calls.lock().unwrap() += 1;
                let response = self.responses.lock().unwrap().remove(0);
                Ok(response)
            })
        }
    }

    fn instant_sleep() -> Box<SleepFn> {
        Box::new(|_| Box::pin(async {}))
    }

    fn response(status: u16, body: &str) -> FetchResponse {
        FetchResponse {
            status,
            headers: vec![],
            body: body.to_string(),
        }
    }

    #[tokio::test]
    async fn post_json_retries_retryable_status() {
        let fetch = FakeFetch {
            responses: std::sync::Mutex::new(vec![
                response(429, "slow down"),
                response(200, "{\"ok\":true}"),
            ]),
            calls: std::sync::Mutex::new(0),
        };
        let sleep = instant_sleep();
        let value = post_json(
            &fetch,
            "http://example.test",
            &serde_json::json!({"a": 1}),
            &[],
            &sleep,
        )
        .await
        .unwrap();
        assert_eq!(value, serde_json::json!({"ok": true}));
        assert_eq!(*fetch.calls.lock().unwrap(), 2);
    }

    #[tokio::test]
    async fn post_json_does_not_retry_client_errors() {
        let fetch = FakeFetch {
            responses: std::sync::Mutex::new(vec![response(400, "bad request")]),
            calls: std::sync::Mutex::new(0),
        };
        let sleep = instant_sleep();
        let error = post_json(
            &fetch,
            "http://example.test",
            &serde_json::json!({"a": 1}),
            &[],
            &sleep,
        )
        .await
        .unwrap_err();
        assert!(error.message.contains("Generation request failed: 400"));
        assert_eq!(*fetch.calls.lock().unwrap(), 1);
    }

    #[test]
    fn backoff_prefers_retry_after_seconds() {
        assert_eq!(backoff_ms(1, Some("3"), None, 1_000), 3000);
        assert_eq!(backoff_ms(1, Some("120"), None, 1_000), MAX_BACKOFF_MS);
        assert_eq!(backoff_ms(1, Some("junk"), None, 1_000), 2000);
    }

    #[test]
    fn backoff_uses_rate_limit_reset_seconds_or_millis() {
        // Reset far in the future: hits the cap rather than waiting forever.
        assert_eq!(
            backoff_ms(1, None, Some("9999999999"), 1_000),
            MAX_BACKOFF_MS
        );
        // Reset within the threshold: waits the difference (rounded down) + 500.
        let now = 10_000;
        let reset_secs = (now + 30_000) as f64 / 1000.0;
        assert_eq!(
            backoff_ms(1, None, Some(&reset_secs.to_string()), now),
            30_500
        );
        // Reset already in the past: exponential backoff.
        assert_eq!(backoff_ms(2, None, Some("1"), now), 4000);
    }

    #[test]
    fn backoff_is_exponential_without_headers() {
        assert_eq!(backoff_ms(1, None, None, 0), 2000);
        assert_eq!(backoff_ms(2, None, None, 0), 4000);
        assert_eq!(backoff_ms(3, None, None, 0), 8000);
        assert_eq!(backoff_ms(10, None, None, 0), MAX_BACKOFF_MS);
    }
}
