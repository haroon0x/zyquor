//! HTTP client against the Zyquor API base URL, mirroring the TypeScript
//! `api()` helper: same URL normalisation, same JSON error extraction, same
//! `Worker request to {url} failed: {detail}` error message.

use std::time::Duration;

use serde::de::DeserializeOwned;
use thiserror::Error;

#[derive(Debug, Error)]
#[error("{message}")]
pub struct ApiError {
    message: String,
    url: String,
}

impl ApiError {
    pub fn message(&self) -> &str {
        &self.message
    }

    pub fn url(&self) -> &str {
        &self.url
    }
}

fn make_error(url: &str, detail: &str) -> ApiError {
    ApiError {
        message: format!("Worker request to {url} failed: {detail}"),
        url: url.to_string(),
    }
}

/// Percent-encode a query component like JS `encodeURIComponent` (RFC 3986
/// unreserved set is a strict superset-safe subset for the ids we encode).
pub fn percent_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct ApiClient {
    base_url: String,
    http: reqwest::Client,
}

impl ApiClient {
    pub fn new(api_url: &str) -> Result<Self, ApiError> {
        let http = reqwest::Client::builder()
            .build()
            .map_err(|error| ApiError {
                message: format!("Worker HTTP client build failed: {error}"),
                url: api_url.to_string(),
            })?;
        Ok(Self {
            base_url: api_url.to_string(),
            http,
        })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    fn join_url(&self, path: &str) -> String {
        let base = if self.base_url.ends_with('/') {
            self.base_url.clone()
        } else {
            format!("{}/", self.base_url)
        };
        let normalized = path.strip_prefix('/').unwrap_or(path);
        format!("{base}{normalized}")
    }

    async fn request<T: DeserializeOwned>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<serde_json::Value>,
        timeout: Option<Duration>,
    ) -> Result<T, ApiError> {
        let url = self.join_url(path);
        let mut builder = self.http.request(method, &url);
        if let Some(value) = body {
            let text = serde_json::to_string(&value)
                .map_err(|error| make_error(&url, &error.to_string()))?;
            builder = builder
                .header("content-type", "application/json")
                .body(text);
        }
        if let Some(duration) = timeout {
            builder = builder.timeout(duration);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| make_error(&url, &error.to_string()))?;
        let status = response.status();
        let text = response
            .text()
            .await
            .map_err(|error| make_error(&url, &error.to_string()))?;
        if !status.is_success() {
            return Err(make_error(&url, &error_detail(&text, status.as_u16())));
        }
        if text.trim().is_empty() {
            return Err(make_error(&url, "empty response body"));
        }
        serde_json::from_str::<T>(&text).map_err(|error| make_error(&url, &error.to_string()))
    }

    pub async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        timeout: Option<Duration>,
    ) -> Result<T, ApiError> {
        self.request(reqwest::Method::GET, path, None, timeout)
            .await
    }

    pub async fn post<T: DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: Option<&B>,
        timeout: Option<Duration>,
    ) -> Result<T, ApiError> {
        let value = body.map(|b| serde_json::to_value(b).unwrap_or(serde_json::Value::Null));
        self.request(reqwest::Method::POST, path, value, timeout)
            .await
    }

    pub async fn patch<T: DeserializeOwned, B: serde::Serialize>(
        &self,
        path: &str,
        body: Option<&B>,
        timeout: Option<Duration>,
    ) -> Result<T, ApiError> {
        let value = body.map(|b| serde_json::to_value(b).unwrap_or(serde_json::Value::Null));
        self.request(reqwest::Method::PATCH, path, value, timeout)
            .await
    }
}

fn error_detail(body: &str, status: u16) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(detail) = value
            .get("error")
            .and_then(serde_json::Value::as_str)
            .or_else(|| value.get("message").and_then(serde_json::Value::as_str))
        {
            return detail.to_string();
        }
    }
    format!("Status {status}")
}
