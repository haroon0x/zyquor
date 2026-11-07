//! HTTP fetch seam for source adapters, mirroring the `globalThis.fetch`
//! calls scattered through `packages/adapters/src`.
//!
//! Production code uses [`ReqwestFetch`]; tests inject a fake [`Fetch`] so the
//! suite never touches the network. The per-request timeout mirrors the
//! TypeScript `AbortController` timeouts (GDELT 30s, Crawl4AI 30s, GitHub
//! enrich 10s); adapters pass it via [`FetchInit::timeout`].

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use crate::types::{AdapterError, AdapterResult};

/// One outgoing request. Only the subset the adapters use.
#[derive(Debug, Clone, Default)]
pub struct FetchInit {
    pub method: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout: Option<Duration>,
}

impl FetchInit {
    /// A `User-Agent: Zyquor/1.0` GET, the header most adapters set.
    pub fn get() -> Self {
        Self {
            method: "GET".to_string(),
            headers: user_agent_headers(),
            body: None,
            timeout: None,
        }
    }

    /// POST with a JSON body (`content-type: application/json`,
    /// `User-Agent: Zyquor/1.0`).
    pub fn post_json(body: &serde_json::Value) -> Self {
        Self {
            method: "POST".to_string(),
            headers: vec![
                ("content-type".to_string(), "application/json".to_string()),
                ("User-Agent".to_string(), "Zyquor/1.0".to_string()),
            ],
            body: serde_json::to_string(body).ok(),
            timeout: None,
        }
    }
}

/// One incoming response, body already read to a string.
#[derive(Debug, Clone)]
pub struct FetchResponse {
    pub status: u16,
    pub body: String,
}

impl FetchResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// The fetch seam. Object-safe via boxed futures.
pub trait Fetch: Send + Sync {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        init: FetchInit,
    ) -> Pin<Box<dyn Future<Output = AdapterResult<FetchResponse>> + Send + 'a>>;
}

impl<T: ?Sized + Fetch> Fetch for Arc<T> {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        init: FetchInit,
    ) -> Pin<Box<dyn Future<Output = AdapterResult<FetchResponse>> + Send + 'a>> {
        let arc = self.clone();
        Box::pin(async move { (*arc).fetch(url, init).await })
    }
}

/// Convenience constructor for a `User-Agent: Zyquor/1.0` GET request, or
/// with custom headers when provided.
pub fn user_agent_headers() -> Vec<(String, String)> {
    vec![("User-Agent".to_string(), "Zyquor/1.0".to_string())]
}

/// Production [`Fetch`] backed by `reqwest`.
#[derive(Clone, Default)]
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

impl Fetch for ReqwestFetch {
    fn fetch<'a>(
        &'a self,
        url: &'a str,
        init: FetchInit,
    ) -> Pin<Box<dyn Future<Output = AdapterResult<FetchResponse>> + Send + 'a>> {
        Box::pin(async move {
            let method = reqwest::Method::from_bytes(init.method.as_bytes())
                .map_err(|error| AdapterError::new(error.to_string()))?;
            let mut request = self.client.request(method, url);
            for (key, value) in init.headers {
                request = request.header(key, value);
            }
            if let Some(timeout) = init.timeout {
                request = request.timeout(timeout);
            }
            if let Some(body) = init.body {
                request = request.body(body);
            }
            let response = request
                .send()
                .await
                .map_err(|error| AdapterError::new(error.to_string()))?;
            let status = response.status().as_u16();
            let body = response.text().await.unwrap_or_default();
            Ok(FetchResponse { status, body })
        })
    }
}

/// `encodeURIComponent` from JavaScript: unreserved characters pass through,
/// everything else is UTF-8 percent-encoded with uppercase `%XX`.
pub fn encode_uri_component(value: &str) -> String {
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
