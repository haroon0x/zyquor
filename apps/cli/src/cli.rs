//! Shared helpers: env access, strict argv parsing, HTTP, repo paths.
//!
//! The TypeScript scripts read `process.env` directly and call `fetch()`
//! with `AbortSignal.timeout()`. These helpers mirror that surface without
//! pulling in clap: unknown flags are an error.

use std::path::PathBuf;
use std::time::Duration;

pub fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

pub fn env_or(name: &str, default: &str) -> String {
    env(name).unwrap_or_else(|| default.to_string())
}

pub fn env_flag(name: &str) -> bool {
    env(name).as_deref() == Some("1")
}

/// Numeric env with TypeScript `Number(...)` leniency: invalid → fallback.
pub fn env_number(name: &str, fallback: f64) -> f64 {
    env(name)
        .and_then(|value| value.parse::<f64>().ok())
        .unwrap_or(fallback)
}

#[allow(dead_code)]
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value.is_finite() {
        value.clamp(min, max)
    } else {
        min
    }
}

#[allow(dead_code)]
pub fn clamp_usize(value: f64, min: f64, max: f64) -> usize {
    clamp(value, min, max) as usize
}

/// Repo root: walk up from the current directory to the first ancestor that
/// looks like the zyquor checkout (Cargo workspace + apps/web or .git).
pub fn repo_root() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut current = Some(cwd.as_path());
    while let Some(dir) = current {
        if dir.join("Cargo.toml").is_file() && dir.join(".git").exists() {
            return dir.to_path_buf();
        }
        if dir.join("apps").join("web").is_dir() {
            return dir.to_path_buf();
        }
        current = dir.parent();
    }
    cwd
}

/// `<repo>/apps/api/data`, mirroring the scripts' `dataDir`.
pub fn ts_data_dir() -> PathBuf {
    repo_root().join("apps").join("api").join("data")
}

/// `<repo>/data`, the post-migration data root.
pub fn repo_data_dir() -> PathBuf {
    repo_root().join("data")
}

pub fn print_usage() {
    println!(
        "Usage: zyquor [start|api|worker|web|post-loop|reply-loop|overseer|open-profile [--manual]|check-login|backfill-timeline [--dry-run]|poll-mentions [--dry]|seed-account [handle] [display name...]|lessons [--dry]|tweet-eval|smoke-generation]"
    );
}

fn known_flags(command: &str) -> &'static [&'static str] {
    match command {
        "post-loop" | "reply-loop" => &["--once", "--dry", "--force", "--help", "-h"],
        "overseer" => &["--interval-ms", "--dry", "--once", "--help", "-h"],
        "open-profile" => &["--manual", "--help", "-h"],
        "backfill-timeline" => &["--dry-run", "--help", "-h"],
        "poll-mentions" => &["--dry", "--help", "-h"],
        "lessons" => &["--dry", "--help", "-h"],
        "seed-account" => &["--help", "-h"],
        _ => &["--help", "-h"],
    }
}

pub fn has_help(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--help" || arg == "-h")
}

/// Validate flags for `command`. `--interval-ms` consumes a value. Positionals
/// are allowed only for `seed-account`. Returns the positional args.
pub fn check_flags(command: &str, args: &[String]) -> Result<Vec<String>, String> {
    let known = known_flags(command);
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--interval-ms" {
            if index + 1 >= args.len() {
                return Err("missing value for --interval-ms".to_string());
            }
            let _ = args[index + 1]
                .parse::<u64>()
                .map_err(|_| format!("invalid --interval-ms value: {}", args[index + 1]))?;
            index += 2;
            continue;
        }
        if arg.starts_with("--") || (arg.starts_with('-') && arg.len() > 1) {
            if known.contains(&arg.as_str()) {
                index += 1;
                continue;
            }
            return Err(format!("unknown flag: {arg}"));
        }
        if command == "seed-account" {
            positionals.push(arg.clone());
            index += 1;
            continue;
        }
        return Err(format!("unexpected argument: {arg}"));
    }
    Ok(positionals)
}

/// Fetch with a timeout, mirroring `fetch(..., { signal: AbortSignal.timeout(ms) })`.
pub struct Http {
    pub client: reqwest::Client,
    pub base: String,
}

pub fn http(base: &str) -> Http {
    Http {
        client: reqwest::Client::builder()
            .build()
            .unwrap_or_else(|_| reqwest::Client::new()),
        base: base.trim_end_matches('/').to_string(),
    }
}

impl Http {
    pub async fn get_json(&self, path: &str, timeout_ms: u64) -> Result<serde_json::Value, String> {
        self.request_json("GET", path, None, timeout_ms).await
    }

    pub async fn post_json(
        &self,
        path: &str,
        body: Option<&serde_json::Value>,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, String> {
        self.request_json("POST", path, body, timeout_ms).await
    }

    /// POST with no body, returning (status, value).
    #[allow(dead_code)]
    pub async fn post_empty(
        &self,
        path: &str,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, String> {
        self.request_json("POST", path, None, timeout_ms).await
    }

    pub async fn delete_json(
        &self,
        path: &str,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, String> {
        self.request_json("DELETE", path, None, timeout_ms).await
    }

    /// Raw status + text (for jobs post/delete where the body shape varies).
    pub async fn request_raw(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
        timeout_ms: u64,
    ) -> Result<(u16, String), String> {
        let url = format!("{}{}", self.base, path);
        let mut request = match method {
            "GET" => self.client.get(&url),
            "POST" => self.client.post(&url),
            "DELETE" => self.client.delete(&url),
            _ => self.client.request(
                reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET),
                &url,
            ),
        };
        request = request.timeout(Duration::from_millis(timeout_ms));
        if let Some(value) = body {
            request = request
                .header("content-type", "application/json")
                .body(serde_json::to_string(value).unwrap_or_default());
        }
        let response = request.send().await.map_err(|error| error.to_string())?;
        let status = response.status().as_u16();
        let text = response.text().await.unwrap_or_default();
        Ok((status, text))
    }

    async fn request_json(
        &self,
        method: &str,
        path: &str,
        body: Option<&serde_json::Value>,
        timeout_ms: u64,
    ) -> Result<serde_json::Value, String> {
        let (status, text) = self.request_raw(method, path, body, timeout_ms).await?;
        let value: serde_json::Value =
            serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
        if !(200..300).contains(&status) {
            let detail = value
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(&text);
            let mut error = format!("HTTP {status} {detail}");
            if !detail.is_empty() {
                let _ = &mut error;
            }
            return Err(error);
        }
        Ok(value)
    }
}

/// Probe `<base>/health` once (3s), mirroring `resolveApiUrl`.
pub async fn health_url(base: &str) -> bool {
    let probe = http(base);
    probe.get_json("/health", 3_000).await.is_ok()
}

/// Resolve the API base: explicit ZYQUOR_API_URL, else first healthy of 3001/3000.
pub async fn resolve_api_url() -> String {
    let configured = env("ZYQUOR_API_URL").unwrap_or_default();
    let configured = configured.trim_end_matches('/').to_string();
    if !configured.is_empty() {
        return configured;
    }
    for candidate in ["http://127.0.0.1:3001", "http://127.0.0.1:3000"] {
        if health_url(candidate).await {
            return candidate.to_string();
        }
    }
    "http://127.0.0.1:3001".to_string()
}

pub fn api_url_for_zyquor() -> String {
    let port = env("ZYQUOR_API_PORT_OVERRIDE").unwrap_or_else(|| "3001".to_string());
    env("ZYQUOR_API_URL_OVERRIDE").unwrap_or_else(|| format!("http://127.0.0.1:{port}"))
}

pub fn cdp_url() -> String {
    env("ZYQUOR_BROWSER_CDP_URL").unwrap_or_else(|| "http://127.0.0.1:9222".to_string())
}

/// `true` when the browser prepare lane is enabled (`ZYQUOR_ENABLE_BROWSER_PREPARE=1`).
pub fn browser_prepare_enabled() -> bool {
    env_flag("ZYQUOR_ENABLE_BROWSER_PREPARE")
}

/// Print the posting-disabled banner; called by the loops on startup.
pub fn browser_lane_banner(loop_name: &str) {
    if !browser_prepare_enabled() {
        println!(
            "[{loop_name}] browser lanes disabled (ZYQUOR_ENABLE_BROWSER_PREPARE != 1); \
             drafts are created and screened, but nothing is approved or posted"
        );
    }
}

#[allow(dead_code)]
pub fn exit_with(code: i32) -> ! {
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_bounds_and_nan() {
        assert_eq!(clamp(3.0, 1.0, 5.0), 3.0);
        assert_eq!(clamp(f64::NAN, 1.0, 5.0), 1.0);
        assert_eq!(clamp_usize(11.0, 1.0, 10.0), 10);
    }

    #[test]
    fn check_flags_rejects_unknown_and_accepts_known() {
        let args = vec!["--once".to_string(), "--dry".to_string()];
        assert!(check_flags("post-loop", &args).is_ok());
        let bad = vec!["--nope".to_string()];
        assert_eq!(
            check_flags("post-loop", &bad),
            Err("unknown flag: --nope".to_string())
        );
        let interval = vec!["--interval-ms".to_string(), "5000".to_string()];
        assert!(check_flags("overseer", &interval).is_ok());
        let missing = vec!["--interval-ms".to_string()];
        assert!(check_flags("overseer", &missing).is_err());
        let seed = vec![
            "business".to_string(),
            "My".to_string(),
            "Brand".to_string(),
        ];
        assert_eq!(check_flags("seed-account", &seed), Ok(seed.clone()));
    }
}
