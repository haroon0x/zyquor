//! Account config helpers, ported from `packages/accounts`.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use zyquor_core::PostingMode;
use zyquor_core::paths::{EnvLookup, profiles_path_with_env, resolve_absolute};

const BLOCKED_PROFILE_FRAGMENTS: &[&str] = &[
    ".config/google-chrome",
    ".config/chromium",
    "Library/Application Support/Google/Chrome",
    "AppData/Local/Google/Chrome",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub handle: String,
    pub display_name: String,
    pub profile_dir: String,
    pub style_profile_id: String,
    pub posting_mode: PostingMode,
    pub enabled: bool,
    pub daily_post_limit: Option<i64>,
    pub quiet_hours_start: Option<String>,
    pub quiet_hours_end: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum AccountError {
    #[error("Profile directory must live under profiles/: {0}")]
    OutsideProfiles(String),
    #[error("Refusing to use everyday browser profile: {0}")]
    EverydayProfile(String),
}

pub fn is_account_runnable(account: &Account) -> bool {
    account.enabled && account.posting_mode != PostingMode::DraftOnly
}

fn process_env(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

pub fn assert_dedicated_profile_dir(profile_dir: &str) -> Result<(), AccountError> {
    assert_dedicated_profile_dir_with(&process_env, profile_dir)
}

/// [`assert_dedicated_profile_dir`] with an injectable env lookup, so tests do
/// not have to mutate the process environment.
pub fn assert_dedicated_profile_dir_with(
    env: EnvLookup<'_>,
    profile_dir: &str,
) -> Result<(), AccountError> {
    let normalized = profile_dir.replace('\\', "/");

    let profiles_root = profiles_path_with_env(env, std::iter::empty::<&str>());
    let resolved = resolve_absolute(profile_dir);
    let prefix = format!("{}/", profiles_root.to_string_lossy());
    let is_under_data_root_profiles = resolved.to_string_lossy().starts_with(&prefix);

    if !is_under_data_root_profiles
        && !normalized.starts_with("profiles/")
        && !normalized.contains("/profiles/")
    {
        return Err(AccountError::OutsideProfiles(profile_dir.to_string()));
    }

    if BLOCKED_PROFILE_FRAGMENTS
        .iter()
        .any(|fragment| normalized.contains(fragment))
    {
        return Err(AccountError::EverydayProfile(profile_dir.to_string()));
    }

    Ok(())
}
