//! Failure artifact helpers (screenshot/trace files under the artifacts dir).
//! The file naming `prepare-<iso-stamp>.png` matches the TypeScript layout.

use std::path::{Path, PathBuf};

use chrono::{SecondsFormat, Utc};

use zyquor_core::paths::data_path;

/// The artifacts directory (`dataPath("data", "artifacts")`).
pub fn default_artifacts_dir() -> PathBuf {
    data_path(["data", "artifacts"])
}

/// `new Date().toISOString().replace(/[:.]/g, "-")`-style stamp.
pub fn artifact_stamp() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn artifact_path(dir: &Path, prefix: &str) -> PathBuf {
    let stamp = artifact_stamp();
    dir.join(format!("{prefix}-{stamp}.png"))
}

pub fn ensure_artifacts_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())
}
