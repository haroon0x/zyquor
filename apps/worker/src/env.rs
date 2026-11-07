//! Environment access and `.env` loading, ported from the TypeScript
//! worker's `process.env` reads and `loadDotEnv()`.
//!
//! Rust 2024 makes `std::env::set_var` unsafe, so instead of mutating the
//! process environment we load `.env` into a snapshot once and read from it
//! (process env still wins, matching the TypeScript "never override" rule).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

static DOT_ENV: OnceLock<HashMap<String, String>> = OnceLock::new();

fn find_dot_env(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(dir) = current {
        let candidate = dir.join(".env");
        if candidate.is_file() {
            return Some(candidate);
        }
        current = dir.parent();
    }
    None
}

fn is_valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn strip_quotes(value: &str) -> &str {
    let trimmed = if let Some(rest) = value.strip_prefix('"') {
        rest
    } else if let Some(rest) = value.strip_prefix('\'') {
        rest
    } else {
        value
    };
    if let Some(rest) = trimmed.strip_suffix('"') {
        rest
    } else if let Some(rest) = trimmed.strip_suffix('\'') {
        rest
    } else {
        trimmed
    }
}

fn parse_dot_env(text: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        let key = trimmed[..eq].trim();
        if !is_valid_key(key) {
            continue;
        }
        let raw = trimmed[eq + 1..].trim();
        map.insert(key.to_string(), strip_quotes(raw).to_string());
    }
    map
}

/// Load `.env` searching from the current directory upwards, mirroring the
/// TypeScript `loadDotEnv()` walk. Idempotent; safe to call more than once.
pub fn load_dot_env() {
    if DOT_ENV.get().is_some() {
        return;
    }
    let map = match std::env::current_dir() {
        Ok(cwd) => match find_dot_env(&cwd) {
            Some(path) => match std::fs::read_to_string(&path) {
                Ok(text) => parse_dot_env(&text),
                Err(_) => HashMap::new(),
            },
            None => HashMap::new(),
        },
        Err(_) => HashMap::new(),
    };
    let _ = DOT_ENV.set(map);
}

/// Read an environment variable, process env first, then the `.env` snapshot.
pub fn env_var(key: &str) -> Option<String> {
    match std::env::var(key) {
        Ok(value) => Some(value),
        Err(_) => DOT_ENV.get().and_then(|map| map.get(key).cloned()),
    }
}

/// `process.env[key] === "1"`.
pub fn env_flag(key: &str) -> bool {
    env_var(key).as_deref() == Some("1")
}

/// Parse a numeric env var. `None` when unset or unparsable (the TypeScript
/// `Number(...)` `NaN` path, which the spacing maths then defaults).
pub fn env_f64(key: &str) -> Option<f64> {
    env_var(key).and_then(|value| value.parse::<f64>().ok())
}

/// Spacing inputs in TypeScript pass `Number(env ?? fallback)`, so an unset
/// var uses the worker fallback while a set-but-invalid var becomes `NaN` and
/// falls back to the spacing default. `None` represents the `NaN` sentinel.
pub fn env_spacing_f64(key: &str, fallback: f64) -> Option<f64> {
    match env_var(key) {
        None => Some(fallback),
        Some(value) => value.parse::<f64>().ok(),
    }
}

/// Interval env var for `passMs`-style options. Unset uses `fallback`;
/// set-but-invalid uses `u64::MAX` (effectively "never due", matching the
/// `now - last >= NaN` → `false` TypeScript behaviour).
pub fn env_interval_ms_or_never(key: &str, fallback: u64) -> Option<u64> {
    match env_var(key) {
        None => Some(fallback),
        Some(value) => Some(value.parse::<u64>().unwrap_or(u64::MAX)),
    }
}

/// Poll-interval env var. Invalid values fall back to `fallback` (Node's
/// `setTimeout(NaN)` firing immediately is not usefully reproducible).
pub fn env_poll_ms(key: &str, fallback: u64) -> u64 {
    match env_var(key) {
        Some(value) => value.parse::<u64>().unwrap_or(fallback),
        None => fallback,
    }
}
