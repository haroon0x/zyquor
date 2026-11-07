//! Per-profile Chrome launch state (`posting-chrome.json`), ported from
//! `packages/browser/src/index.ts`.
//!
//! The file keeps one small record per profile directory. Two shapes exist in
//! the wild: the legacy single record (`{ "profileDir": …, "pid": … }`)
//! written before per-profile storage, and the current per-profile map. Reads
//! normalise both; writes always emit the map shape. The mapping logic is
//! deliberately forgiving — a corrupt or alien file yields no states rather
//! than an error, matching the TypeScript `try { … } catch { return [] }`.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use zyquor_core::paths::{data_path, resolve_data_root};

/// One launch-state record for a single profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CdpLaunchState {
    pub profile_dir: String,
    pub pid: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_port: Option<u16>,
}

/// `posting-chrome.json` in the data dir.
pub fn cdp_launch_state_file() -> PathBuf {
    data_path(["posting-chrome.json"])
}

pub fn resolve_profile_dir(profile_dir: &str) -> PathBuf {
    let path = PathBuf::from(profile_dir);
    if path.is_absolute() {
        path
    } else {
        resolve_data_root().join(path)
    }
}

fn is_windows_drive_path(value: &str) -> bool {
    // `/[A-Za-z]:[\\/]/`
    let bytes = value.as_bytes();
    if bytes.len() < 3 {
        return false;
    }
    bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// `profileKey` from TypeScript: the path part after the last `/profiles/`.
pub fn profile_key(profile_dir: &str) -> String {
    let normalized = normalize_stored_profile_dir(profile_dir);
    let normalized = normalized.replace('\\', "/");
    match normalized.rfind("/profiles/") {
        Some(index) => normalized[index + "/profiles/".len()..].to_string(),
        None => normalized,
    }
}

/// `normalizeStoredProfileDir`: absolute Windows drive paths stay anchored
/// inside the data dir; everything else resolves as-is.
pub fn normalize_stored_profile_dir(stored: &str) -> String {
    let resolved = resolve_profile_dir(stored);
    let resolved_str = resolved.to_string_lossy().replace('\\', "/");
    if !is_windows_drive_path(&resolved_str) {
        return resolved.to_string_lossy().to_string();
    }
    let normalized = stored.replace('\\', "/");
    match normalized.rfind("/profiles/") {
        Some(index) => {
            let tail = &normalized[index + "/profiles/".len()..];
            zyquor_core::paths::data_path(["profiles", tail])
                .to_string_lossy()
                .replace('\\', "/")
        }
        None => resolved.to_string_lossy().to_string(),
    }
}

/// Read all launch states from `path`. Any failure yields an empty list.
pub fn read_all_cdp_launch_states(path: &Path) -> Vec<CdpLaunchState> {
    let Ok(contents) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&contents) else {
        return Vec::new();
    };
    let Some(record) = parsed.as_object() else {
        return Vec::new();
    };

    // Legacy single-record shape: a top-level `profileDir` string.
    if record
        .get("profileDir")
        .and_then(serde_json::Value::as_str)
        .is_some()
    {
        return vec![parse_state(record, None).unwrap_or(CdpLaunchState {
            profile_dir: String::new(),
            pid: None,
            cdp_url: None,
            cdp_port: None,
        })];
    }

    record
        .values()
        .filter_map(|value| value.as_object())
        .filter_map(|entry| parse_state(entry, None))
        .collect()
}

/// Parse one record's fields.
fn parse_state(
    record: &serde_json::Map<String, serde_json::Value>,
    _fallback: Option<CdpLaunchState>,
) -> Option<CdpLaunchState> {
    let profile_dir = record
        .get("profileDir")
        .and_then(serde_json::Value::as_str)?;
    Some(CdpLaunchState {
        profile_dir: normalize_stored_profile_dir(profile_dir),
        pid: record.get("pid").and_then(serde_json::Value::as_i64),
        cdp_url: record
            .get("cdpUrl")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
        cdp_port: record
            .get("cdpPort")
            .and_then(serde_json::Value::as_u64)
            .and_then(|port| u16::try_from(port).ok()),
    })
}

pub fn read_cdp_launch_state() -> Option<CdpLaunchState> {
    read_all_cdp_launch_states(&cdp_launch_state_file())
        .into_iter()
        .next()
}

pub fn read_cdp_launch_state_for(profile_dir: &str) -> Option<CdpLaunchState> {
    let key = profile_key(profile_dir);
    read_all_cdp_launch_states(&cdp_launch_state_file())
        .into_iter()
        .find(|state| profile_key(&state.profile_dir) == key)
}
/// Persist a per-profile record into `path`. Best-effort: all errors are
/// silently dropped, matching the TypeScript `try { … } catch {}`.
pub fn write_cdp_launch_state_for(path: &Path, state: &CdpLaunchState) {
    let Some(parent) = path.parent() else {
        return;
    };
    if parent.as_os_str().is_empty() || fs::create_dir_all(parent).is_err() {
        return;
    }
    let states = read_all_cdp_launch_states(path);
    // Insertion-order (serde_json preserve_order Map) — same as TS stringify order.
    let mut map = serde_json::Map::new();
    for existing in states {
        map.insert(
            profile_key(&existing.profile_dir),
            serialize_state(&existing),
        );
    }
    map.insert(
        profile_key(&state.profile_dir),
        serialize_state(&normalize_state(state)),
    );
    let _ = fs::write(
        path,
        serde_json::to_string(&map).unwrap_or_else(|_| "{}".to_string()),
    );
}

fn normalize_state(state: &CdpLaunchState) -> CdpLaunchState {
    CdpLaunchState {
        profile_dir: normalize_stored_profile_dir(&state.profile_dir),
        ..state.clone()
    }
}

fn serialize_state(state: &CdpLaunchState) -> serde_json::Value {
    serde_json::json!({
        "profileDir": state.profile_dir,
        "pid": state.pid,
        "cdpUrl": state.cdp_url,
        "cdpPort": state.cdp_port,
    })
}

/// Clear every record (`posting-chrome.json` becomes `{}`).
pub fn clear_cdp_launch_state() {
    let _ = fs::write(cdp_launch_state_file(), "{}");
}

/// Remove the record for one profile.
pub fn clear_cdp_launch_state_for(profile_dir: &str) {
    let path = cdp_launch_state_file();
    let key = profile_key(profile_dir);
    let mut map = serde_json::Map::new();
    for state in read_all_cdp_launch_states(&path) {
        if profile_key(&state.profile_dir) == key {
            continue;
        }
        map.insert(profile_key(&state.profile_dir), serialize_state(&state));
    }
    if map.is_empty() {
        let _ = fs::write(&path, "{}");
    } else {
        let _ = fs::write(
            &path,
            serde_json::to_string(&map).unwrap_or_else(|_| "{}".to_string()),
        );
    }
}
