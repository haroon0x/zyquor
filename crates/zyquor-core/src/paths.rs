//! Data and profile path rules, ported from `packages/core/src/paths.ts`.
//!
//! Env lookups are injectable ([`EnvLookup`]) rather than read directly inside
//! the algorithms: Rust 2024 makes `std::env::set_var` unsafe, and the
//! migration forbids unsafe code, so tests drive the `*_with` variants instead
//! of mutating the process environment.

use std::path::{Component, Path, PathBuf};

use url::Url;

/// Reads an environment variable. `None` when unset.
pub type EnvLookup<'a> = &'a dyn Fn(&str) -> Option<String>;

fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

/// Lexically normalise a path the way Node's `path.resolve` does: drop `.`,
/// collapse `..`, and keep an absolute result.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn absolutize(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(path),
            Err(_) => path.to_path_buf(),
        }
    };
    normalize(&joined)
}

/// Resolve a path against the current directory and normalise it, matching
/// Node's `path.resolve(value)` for a single argument.
pub fn resolve_absolute<P: AsRef<Path>>(path: P) -> PathBuf {
    absolutize(path.as_ref())
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|candidate| !candidate.is_empty())
}

fn resolve_data_root_with(env: EnvLookup<'_>) -> PathBuf {
    match non_empty(env("ZYQUOR_DATA_ROOT")).or_else(|| non_empty(env("ZYQUOR_WORKSPACE_ROOT"))) {
        Some(root) => absolutize(Path::new(&root)),
        None => std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
    }
}

fn data_path_with<I, S>(env: EnvLookup<'_>, segments: I) -> PathBuf
where
    I: IntoIterator<Item = S>,
    S: AsRef<Path>,
{
    let joined = segments
        .into_iter()
        .fold(resolve_data_root_with(env), |acc, segment| {
            acc.join(segment.as_ref())
        });
    absolutize(&joined)
}

fn profiles_path_with<I, S>(env: EnvLookup<'_>, segments: I) -> PathBuf
where
    I: IntoIterator<Item = S>,
    S: AsRef<Path>,
{
    let mut all: Vec<PathBuf> = vec![PathBuf::from("profiles")];
    all.extend(segments.into_iter().map(|s| s.as_ref().to_path_buf()));
    data_path_with(env, all)
}

/// `ZYQUOR_DATA_ROOT`, then `ZYQUOR_WORKSPACE_ROOT`, then the current
/// directory.
pub fn resolve_data_root() -> PathBuf {
    resolve_data_root_with(&process_env)
}

pub fn data_path<I, S>(segments: I) -> PathBuf
where
    I: IntoIterator<Item = S>,
    S: AsRef<Path>,
{
    data_path_with(&process_env, segments)
}

pub fn profiles_path<I, S>(segments: I) -> PathBuf
where
    I: IntoIterator<Item = S>,
    S: AsRef<Path>,
{
    profiles_path_with(&process_env, segments)
}

/// [`profiles_path`] with an injectable env lookup.
pub fn profiles_path_with_env<I, S>(env: EnvLookup<'_>, segments: I) -> PathBuf
where
    I: IntoIterator<Item = S>,
    S: AsRef<Path>,
{
    profiles_path_with(env, segments)
}

/// Profiles named in `ZYQUOR_BROWSER_CDP_BASE_PROFILES` (default
/// `personal-main`) stay on the base port.
fn base_port_profiles_with(env: EnvLookup<'_>) -> Vec<String> {
    non_empty(env("ZYQUOR_BROWSER_CDP_BASE_PROFILES"))
        .unwrap_or_else(|| "personal-main".to_string())
        .split(',')
        .map(|name| name.trim().to_lowercase())
        .filter(|name| !name.is_empty())
        .collect()
}

fn per_profile_cdp_url_with(env: EnvLookup<'_>, base: Option<&str>, profile_dir: &str) -> String {
    let raw_base = base.unwrap_or("http://127.0.0.1:9222");
    let Ok(mut url) = Url::parse(raw_base) else {
        return raw_base.to_string();
    };

    let base_port: u16 = url.port().unwrap_or(9222);
    let normalized = profile_dir.replace('\\', "/").to_lowercase();

    let offset: u16 = if normalized.contains("willainotice") {
        1
    } else if !base_port_profiles_with(env)
        .iter()
        .any(|name| normalized.contains(name.as_str()))
    {
        // Match the TypeScript hash exactly: UTF-16 code units, mod 10 at
        // every step.
        let mut h: u32 = 0;
        for unit in normalized.encode_utf16() {
            h = (h.wrapping_mul(31).wrapping_add(u32::from(unit))) % 10;
        }
        u16::try_from(h).unwrap_or(0)
    } else {
        0
    };

    let port = base_port.saturating_add(offset);
    if url.set_port(Some(port)).is_err() {
        return raw_base.to_string();
    }

    let rendered = url.to_string();
    match rendered.strip_suffix('/') {
        Some(trimmed) => trimmed.to_string(),
        None => rendered,
    }
}

/// Per-account posting Chrome runs on its own remote-debugging port so jobs
/// for different accounts can run at the same time. Profiles named in
/// `ZYQUOR_BROWSER_CDP_BASE_PROFILES` (default `personal-main`) sit on the
/// base port, `willainotice` on base+1, anything else on a stable hash offset.
pub fn per_profile_cdp_url(base: Option<&str>, profile_dir: &str) -> String {
    per_profile_cdp_url_with(&process_env, base, profile_dir)
}

#[doc(hidden)]
pub mod testing {
    //! Test hooks for the injectable-env variants.

    use super::*;
    use std::collections::HashMap;

    /// Build an [`EnvLookup`] from a fixed map.
    pub fn env_from<'a>(
        map: &'a HashMap<&'static str, &'static str>,
    ) -> impl Fn(&str) -> Option<String> + 'a {
        move |key| map.get(key).map(|value| (*value).to_string())
    }

    pub fn resolve_data_root_with(env: EnvLookup<'_>) -> PathBuf {
        super::resolve_data_root_with(env)
    }

    pub fn data_path_with<I, S>(env: EnvLookup<'_>, segments: I) -> PathBuf
    where
        I: IntoIterator<Item = S>,
        S: AsRef<Path>,
    {
        super::data_path_with(env, segments)
    }

    pub fn profiles_path_with<I, S>(env: EnvLookup<'_>, segments: I) -> PathBuf
    where
        I: IntoIterator<Item = S>,
        S: AsRef<Path>,
    {
        super::profiles_path_with(env, segments)
    }

    pub fn per_profile_cdp_url_with(
        env: EnvLookup<'_>,
        base: Option<&str>,
        profile_dir: &str,
    ) -> String {
        super::per_profile_cdp_url_with(env, base, profile_dir)
    }
}
