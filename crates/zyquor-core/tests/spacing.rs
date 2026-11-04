#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

//! Post-gate and spacing parity.

use rand::SeedableRng;
use rand::rngs::StdRng;

use zyquor_core::spacing::{
    MS_PER_MINUTE, NextAutopostInput, PostGateInput, evaluate_post_gate,
    next_autopost_scheduled_for_with_rng,
};

fn gate(
    now: &str,
    last: Option<&str>,
    gap_min: Option<f64>,
) -> zyquor_core::spacing::PostGateResult {
    evaluate_post_gate(&PostGateInput {
        gap_min_minutes: gap_min,
        last_posted_at: last.map(str::to_string),
        now: now.to_string(),
        trace_id: None,
    })
    .unwrap()
}

#[test]
fn allows_the_first_post() {
    let result = gate("2026-01-01T12:00:00.000Z", None, Some(30.0));
    assert!(result.allowed);
    assert_eq!(result.reason, "no-previous-post");
    assert_eq!(result.required_gap_minutes, 0.0);
}

#[test]
fn blocks_inside_the_minimum_gap_and_reports_the_wait() {
    let result = gate(
        "2026-01-01T12:10:00.000Z",
        Some("2026-01-01T12:00:00.000Z"),
        Some(30.0),
    );
    assert!(!result.allowed);
    assert_eq!(result.reason, "minimum-gap");
    assert_eq!(result.wait_minutes, 20.0);
    assert_eq!(result.required_gap_minutes, 30.0);
    assert_eq!(
        result.next_eligible_at.as_deref(),
        Some("2026-01-01T12:30:00.000Z")
    );
}

#[test]
fn allows_once_the_gap_has_elapsed() {
    let result = gate(
        "2026-01-01T12:31:00.000Z",
        Some("2026-01-01T12:00:00.000Z"),
        Some(30.0),
    );
    assert!(result.allowed);
    assert_eq!(result.wait_minutes, 0.0);
}

#[test]
fn clamps_a_too_small_gap_to_five_minutes() {
    let result = gate(
        "2026-01-01T12:00:00.000Z",
        Some("2026-01-01T12:00:00.000Z"),
        Some(1.0),
    );
    assert_eq!(result.required_gap_minutes, 5.0);
}

#[test]
fn treats_an_unparsable_last_post_as_eligible() {
    let result = gate("2026-01-01T12:00:00.000Z", Some("garbage"), Some(30.0));
    assert!(result.allowed);
    assert_eq!(result.reason, "unparsable-last-post");
}

#[test]
fn defaults_the_gap_to_thirty_minutes() {
    let result = gate(
        "2026-01-01T12:00:00.000Z",
        Some("2026-01-01T11:50:00.000Z"),
        None,
    );
    assert_eq!(result.required_gap_minutes, 30.0);
}

fn autopost(input: NextAutopostInput, seed: u64) -> zyquor_core::spacing::NextAutopostResult {
    let mut rng = StdRng::seed_from_u64(seed);
    next_autopost_scheduled_for_with_rng(&input, &mut rng).unwrap()
}

#[test]
fn schedules_within_the_configured_band() {
    let result = autopost(
        NextAutopostInput {
            timestamp: "2026-01-01T12:00:00.000Z".to_string(),
            gap_min_minutes: Some(30.0),
            gap_max_minutes: Some(90.0),
            long_pause_chance: Some(0.0),
            ..Default::default()
        },
        7,
    );

    assert!(result.scheduled_for.starts_with("2026-01-01T12:"));
    assert!((30.0 * MS_PER_MINUTE..=90.0 * MS_PER_MINUTE).contains(&result.gap_ms));
    assert_eq!(result.reason, "fresh");
}

#[test]
fn anchors_the_schedule_after_the_last_scheduled_post() {
    let result = autopost(
        NextAutopostInput {
            timestamp: "2026-01-01T09:00:00.000Z".to_string(),
            last_scheduled_for: Some("2026-01-01T12:00:00.000Z".to_string()),
            gap_min_minutes: Some(30.0),
            gap_max_minutes: Some(60.0),
            long_pause_chance: Some(0.0),
            ..Default::default()
        },
        11,
    );

    assert!(
        result.scheduled_for.as_str() > "2026-01-01T12:00:00.000Z",
        "expected a schedule after the anchor, got {}",
        result.scheduled_for
    );
}

#[test]
fn anti_cluster_uses_the_forty_five_to_ninety_minute_band() {
    let steady = vec![30.0 * MS_PER_MINUTE; 3];
    let result = autopost(
        NextAutopostInput {
            timestamp: "2026-01-01T12:00:00.000Z".to_string(),
            gap_min_minutes: Some(30.0),
            gap_max_minutes: Some(60.0),
            recent_gap_ms: Some(steady),
            long_pause_chance: Some(0.0),
            ..Default::default()
        },
        3,
    );

    assert!(
        result.reason.starts_with("anti-cluster:"),
        "got {}",
        result.reason
    );
    assert!(
        (45.0 * MS_PER_MINUTE..=90.0 * MS_PER_MINUTE).contains(&result.gap_ms),
        "gap {} outside anti-cluster band",
        result.gap_ms
    );
}

#[test]
fn varied_recent_gaps_skip_anti_cluster() {
    let varied = vec![10.0, 60.0, 180.0]
        .into_iter()
        .map(|m| m * MS_PER_MINUTE)
        .collect::<Vec<_>>();
    let result = autopost(
        NextAutopostInput {
            timestamp: "2026-01-01T12:00:00.000Z".to_string(),
            gap_min_minutes: Some(30.0),
            gap_max_minutes: Some(60.0),
            recent_gap_ms: Some(varied),
            long_pause_chance: Some(0.0),
            ..Default::default()
        },
        5,
    );

    assert!(
        !result.reason.starts_with("anti-cluster:"),
        "got {}",
        result.reason
    );
}

#[test]
fn long_pauses_are_respected_when_forced() {
    let result = autopost(
        NextAutopostInput {
            timestamp: "2026-01-01T12:00:00.000Z".to_string(),
            gap_min_minutes: Some(30.0),
            gap_max_minutes: Some(90.0),
            long_pause_chance: Some(1.0),
            long_pause_min_minutes: Some(180.0),
            long_pause_max_minutes: Some(480.0),
            ..Default::default()
        },
        13,
    );

    assert!(
        result.reason.starts_with("long-pause"),
        "got {}",
        result.reason
    );
    assert!((180.0 * MS_PER_MINUTE..=480.0 * MS_PER_MINUTE).contains(&result.gap_ms));
}

#[test]
fn rejects_unparsable_input_timestamps() {
    let mut rng = StdRng::seed_from_u64(1);
    let error = next_autopost_scheduled_for_with_rng(
        &NextAutopostInput {
            timestamp: "nope".to_string(),
            ..Default::default()
        },
        &mut rng,
    )
    .unwrap_err();
    assert_eq!(error.to_string(), "could not parse timestamp: nope");
}
