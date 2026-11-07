//! Environment for provider CLI subprocesses, ported from
//! `packages/generation/src/providers/cli-env.ts`.
//!
//! The child gets the parent environment minus every `ZYQUOR_`-prefixed key, so
//! deployment-specific flags never leak into the model CLIs.

use std::ffi::OsString;

pub fn provider_process_env() -> Vec<(OsString, OsString)> {
    std::env::vars_os()
        .filter(|(key, _)| !key.to_string_lossy().starts_with("ZYQUOR_"))
        .collect()
}
