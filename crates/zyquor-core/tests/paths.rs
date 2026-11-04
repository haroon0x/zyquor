#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Ported from `packages/core/src/paths.test.ts`.

use std::collections::HashMap;
use std::path::Path;

use zyquor_core::paths::resolve_absolute;
use zyquor_core::paths::testing::{
    data_path_with, env_from, per_profile_cdp_url_with, profiles_path_with, resolve_data_root_with,
};

#[test]
fn returns_cwd_when_neither_env_var_is_set() {
    let env = HashMap::new();
    assert_eq!(
        resolve_data_root_with(&env_from(&env)),
        std::env::current_dir().unwrap()
    );
}

#[test]
fn returns_absolute_path_when_data_root_is_set() {
    let mut env = HashMap::new();
    env.insert("ZYQUOR_DATA_ROOT", "/tmp/zyq-test");
    assert_eq!(
        resolve_data_root_with(&env_from(&env)),
        resolve_absolute("/tmp/zyq-test")
    );
}

#[test]
fn falls_back_to_workspace_root_when_data_root_unset() {
    let mut env = HashMap::new();
    env.insert("ZYQUOR_WORKSPACE_ROOT", "/tmp/zyq-workspace");
    assert_eq!(
        resolve_data_root_with(&env_from(&env)),
        resolve_absolute("/tmp/zyq-workspace")
    );
}

#[test]
fn resolves_relative_paths_against_cwd() {
    let mut env = HashMap::new();
    env.insert("ZYQUOR_DATA_ROOT", "./test-data");
    assert_eq!(
        resolve_data_root_with(&env_from(&env)),
        resolve_absolute(Path::new(".").join("test-data"))
    );
}

#[test]
fn data_path_joins_segments_under_the_data_root() {
    let mut env = HashMap::new();
    env.insert("ZYQUOR_DATA_ROOT", "/tmp/zyq-test");
    assert_eq!(
        data_path_with(&env_from(&env), ["data", "app.json"]),
        resolve_absolute("/tmp/zyq-test/data/app.json")
    );
}

#[test]
fn data_path_uses_cwd_when_no_env_is_set() {
    let env = HashMap::new();
    assert_eq!(
        data_path_with(&env_from(&env), ["data", "app.json"]),
        resolve_absolute("data/app.json")
    );
}

#[test]
fn profiles_path_joins_segments_under_profiles() {
    let mut env = HashMap::new();
    env.insert("ZYQUOR_DATA_ROOT", "/tmp/zyq-test");
    assert_eq!(
        profiles_path_with(&env_from(&env), ["personal-main"]),
        resolve_absolute("/tmp/zyq-test/profiles/personal-main")
    );
}

#[test]
fn profiles_path_returns_profiles_dir_with_no_segments() {
    let mut env = HashMap::new();
    env.insert("ZYQUOR_DATA_ROOT", "/tmp/zyq-test");
    assert_eq!(
        profiles_path_with(&env_from(&env), std::iter::empty::<&str>()),
        resolve_absolute("/tmp/zyq-test/profiles")
    );
}

// --- perProfileCdpUrl ---------------------------------------------------

const BASE: &str = "http://127.0.0.1:9223";

fn empty_env() -> impl Fn(&str) -> Option<String> {
    |_| None
}

#[test]
fn keeps_the_default_personal_main_profile_on_the_base_port() {
    assert_eq!(
        per_profile_cdp_url_with(&empty_env(), Some(BASE), "profiles/personal-main"),
        BASE
    );
}

#[test]
fn gives_each_unlisted_profile_a_stable_distinct_port() {
    let first = per_profile_cdp_url_with(&empty_env(), Some(BASE), "profiles/another-account");
    let second = per_profile_cdp_url_with(&empty_env(), Some(BASE), "profiles/another-account");
    let other = per_profile_cdp_url_with(&empty_env(), Some(BASE), "profiles/third-account");

    assert_eq!(first, second);
    assert!(first.ends_with(":9225"), "expected :9225, got {first}");
    assert_ne!(other, first);
}

#[test]
fn honours_the_configured_base_port_profile_list() {
    let env = |key: &str| {
        (key == "ZYQUOR_BROWSER_CDP_BASE_PROFILES")
            .then(|| "personal-main,reply-loop-test".to_string())
    };
    assert_eq!(
        per_profile_cdp_url_with(&env, Some(BASE), "profiles/reply-loop-test"),
        BASE
    );
}

#[test]
fn matches_profile_names_case_insensitively_through_windows_paths() {
    let env = |key: &str| {
        (key == "ZYQUOR_BROWSER_CDP_BASE_PROFILES").then(|| "reply-loop-test".to_string())
    };
    assert_eq!(
        per_profile_cdp_url_with(
            &env,
            Some(BASE),
            r"C:\Users\example\zyquor-profiles\Reply-Loop-Test"
        ),
        BASE
    );
}

#[test]
fn falls_back_to_the_base_url_when_unparseable() {
    assert_eq!(
        per_profile_cdp_url_with(&empty_env(), Some("not a url"), "profiles/x"),
        "not a url"
    );
}

#[test]
fn defaults_the_base_url_when_none_is_given() {
    assert_eq!(
        per_profile_cdp_url_with(&empty_env(), None, "profiles/personal-main"),
        "http://127.0.0.1:9222"
    );
}
