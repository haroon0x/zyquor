#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Parity tests for `packages/accounts`.

use std::collections::HashMap;

use zyquor_accounts::{
    Account, AccountError, assert_dedicated_profile_dir_with, is_account_runnable,
};
use zyquor_core::PostingMode;

fn account(enabled: bool, posting_mode: PostingMode) -> Account {
    Account {
        id: "acct_1".to_string(),
        handle: "someone".to_string(),
        display_name: "Someone".to_string(),
        profile_dir: "profiles/someone".to_string(),
        style_profile_id: "style_1".to_string(),
        posting_mode,
        enabled,
        daily_post_limit: Some(5),
        quiet_hours_start: None,
        quiet_hours_end: None,
        created_at: "2026-01-01T00:00:00.000Z".to_string(),
        updated_at: "2026-01-01T00:00:00.000Z".to_string(),
    }
}

fn no_env(_: &str) -> Option<String> {
    None
}

#[test]
fn runnable_requires_enabled_and_a_posting_mode() {
    assert!(is_account_runnable(&account(true, PostingMode::Autopost)));
    assert!(is_account_runnable(&account(
        true,
        PostingMode::ReviewRequired
    )));
    assert!(!is_account_runnable(&account(false, PostingMode::Autopost)));
    assert!(!is_account_runnable(&account(true, PostingMode::DraftOnly)));
}

#[test]
fn accepts_relative_profiles_dirs() {
    assert_eq!(
        assert_dedicated_profile_dir_with(&no_env, "profiles/personal-main"),
        Ok(())
    );
}

#[test]
fn accepts_absolute_paths_under_profiles() {
    assert_eq!(
        assert_dedicated_profile_dir_with(&no_env, "/home/user/zyquor/profiles/someone"),
        Ok(())
    );
}

#[test]
fn accepts_paths_under_the_configured_data_root() {
    let mut env = HashMap::new();
    env.insert("ZYQUOR_DATA_ROOT", "/tmp/zyq-test");
    let lookup = |key: &str| env.get(key).map(|value| (*value).to_string());

    assert_eq!(
        assert_dedicated_profile_dir_with(&lookup, "/tmp/zyq-test/profiles/someone"),
        Ok(())
    );
}

#[test]
fn rejects_paths_outside_profiles() {
    let error = assert_dedicated_profile_dir_with(&no_env, "/home/user/not-profiles/someone")
        .expect_err("expected rejection");
    assert!(matches!(error, AccountError::OutsideProfiles(_)));
    assert_eq!(
        error.to_string(),
        "Profile directory must live under profiles/: /home/user/not-profiles/someone"
    );
}

#[test]
fn refuses_the_everyday_chrome_profile() {
    // Outside `profiles/`, the location check fires first, exactly as in the
    // TypeScript implementation.
    let outside =
        assert_dedicated_profile_dir_with(&no_env, "/home/user/.config/google-chrome/Default")
            .expect_err("expected rejection");
    assert!(matches!(outside, AccountError::OutsideProfiles(_)));

    // Under `profiles/`, the everyday-profile ban is what rejects it.
    let everyday = assert_dedicated_profile_dir_with(&no_env, "profiles/.config/chromium")
        .expect_err("expected rejection");
    assert!(matches!(everyday, AccountError::EverydayProfile(_)));
}
