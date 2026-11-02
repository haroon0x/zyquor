//! Post-gate and autopost spacing, ported from `packages/core/src/spacing.ts`.
//!
//! The scheduling maths deliberately keeps the TypeScript shape (f64
//! milliseconds, one-decimal rounding) so recorded outputs stay comparable
//! during the migration.

use chrono::{DateTime, SecondsFormat, Utc};
use rand::Rng;
use serde::Serialize;

pub const MS_PER_MINUTE: f64 = 60_000.0;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SpacingError {
    #[error("could not parse timestamp: {0}")]
    InvalidTimestamp(String),
}

fn parse_ms(value: &str) -> Option<f64> {
    DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|parsed| parsed.timestamp_millis() as f64)
}

fn iso_from_ms(ms: f64) -> Option<String> {
    if !ms.is_finite() {
        return None;
    }
    let millis = ms.round() as i64;
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|dt| dt.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// `Math.round(value * 10) / 10`
fn round1(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostGateResult {
    pub allowed: bool,
    pub next_eligible_at: Option<String>,
    pub reason: String,
    pub required_gap_minutes: f64,
    pub wait_minutes: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NextAutopostResult {
    pub scheduled_for: String,
    pub gap_ms: f64,
    pub gap_minutes: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct PostGateInput {
    pub gap_min_minutes: Option<f64>,
    pub last_posted_at: Option<String>,
    pub now: String,
    pub trace_id: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct NextAutopostInput {
    pub last_scheduled_for: Option<String>,
    pub timestamp: String,
    pub gap_min_minutes: Option<f64>,
    pub gap_max_minutes: Option<f64>,
    pub jitter_ratio: Option<f64>,
    pub recent_gap_ms: Option<Vec<f64>>,
    pub trace_id: Option<String>,
    pub long_pause_chance: Option<f64>,
    pub long_pause_min_minutes: Option<f64>,
    pub long_pause_max_minutes: Option<f64>,
}

struct AntiCluster {
    apply: bool,
    range: (f64, f64),
}

fn apply_anti_cluster(recent_gap_ms: Option<&[f64]>) -> AntiCluster {
    let Some(gaps) = recent_gap_ms.filter(|gaps| gaps.len() >= 3) else {
        return AntiCluster {
            apply: false,
            range: (0.0, 0.0),
        };
    };

    let tail = &gaps[gaps.len() - 3..];
    let max = tail.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let min = tail.iter().copied().fold(f64::INFINITY, f64::min);
    let mean = tail.iter().sum::<f64>() / tail.len() as f64;
    let spread = max - min;
    let variance = if mean > 0.0 { spread / mean } else { 0.0 };

    if variance >= 0.4 {
        AntiCluster {
            apply: false,
            range: (0.0, 0.0),
        }
    } else {
        AntiCluster {
            apply: true,
            range: (45.0 * MS_PER_MINUTE, 90.0 * MS_PER_MINUTE),
        }
    }
}

struct PickedGap {
    gap_ms: f64,
    reason: &'static str,
}

fn pick_random_gap<R: Rng + ?Sized>(
    rng: &mut R,
    min_ms: f64,
    max_ms: f64,
    last_gap_ms: Option<f64>,
    anti_cluster_range: Option<(f64, f64)>,
) -> PickedGap {
    let (low, high) = anti_cluster_range.unwrap_or((min_ms, max_ms));

    for _ in 0..8 {
        let candidate = low + rng.random::<f64>() * (high - low);
        match last_gap_ms.filter(|gap| *gap > 0.0) {
            None => {
                return PickedGap {
                    gap_ms: candidate.round(),
                    reason: "fresh",
                };
            }
            Some(last) => {
                let ratio = candidate / last;
                if (0.7..=1.4).contains(&ratio) {
                    continue;
                }
                return PickedGap {
                    gap_ms: candidate.round(),
                    reason: "diverse-from-last",
                };
            }
        }
    }

    PickedGap {
        gap_ms: ((low + high) / 2.0).round(),
        reason: "fallback-mid",
    }
}

pub fn evaluate_post_gate(input: &PostGateInput) -> Result<PostGateResult, SpacingError> {
    let now_ms =
        parse_ms(&input.now).ok_or_else(|| SpacingError::InvalidTimestamp(input.now.clone()))?;

    let Some(last_posted_at) = input.last_posted_at.as_deref() else {
        return Ok(PostGateResult {
            allowed: true,
            next_eligible_at: None,
            reason: "no-previous-post".to_string(),
            required_gap_minutes: 0.0,
            wait_minutes: 0.0,
        });
    };

    let Some(last_ms) = parse_ms(last_posted_at) else {
        return Ok(PostGateResult {
            allowed: true,
            next_eligible_at: None,
            reason: "unparsable-last-post".to_string(),
            required_gap_minutes: 0.0,
            wait_minutes: 0.0,
        });
    };

    let gap_minutes = match input.gap_min_minutes.filter(|value| value.is_finite()) {
        Some(value) => value.max(5.0),
        None => 30.0,
    };
    let required_gap_ms = gap_minutes * MS_PER_MINUTE;
    let reason = "minimum-gap";

    let next_eligible_ms = last_ms + required_gap_ms;
    let allowed = now_ms >= next_eligible_ms;
    let wait_ms = (next_eligible_ms - now_ms).max(0.0);

    Ok(PostGateResult {
        allowed,
        next_eligible_at: iso_from_ms(next_eligible_ms),
        reason: reason.to_string(),
        required_gap_minutes: round1(required_gap_ms / MS_PER_MINUTE),
        wait_minutes: round1(wait_ms / MS_PER_MINUTE),
    })
}

pub fn next_autopost_scheduled_for(
    input: &NextAutopostInput,
) -> Result<NextAutopostResult, SpacingError> {
    next_autopost_scheduled_for_with_rng(input, &mut rand::rng())
}

pub fn next_autopost_scheduled_for_with_rng<R: Rng + ?Sized>(
    input: &NextAutopostInput,
    rng: &mut R,
) -> Result<NextAutopostResult, SpacingError> {
    let now_ms = parse_ms(&input.timestamp)
        .ok_or_else(|| SpacingError::InvalidTimestamp(input.timestamp.clone()))?;

    let gap_min_minutes = match input.gap_min_minutes.filter(|value| value.is_finite()) {
        Some(value) => value.max(5.0),
        None => 30.0,
    };
    let gap_max_minutes = match input.gap_max_minutes.filter(|value| value.is_finite()) {
        Some(value) => value.max(gap_min_minutes + 5.0),
        None => (gap_min_minutes + 5.0).max(90.0),
    };

    let min_ms = gap_min_minutes * MS_PER_MINUTE;
    let max_ms = gap_max_minutes * MS_PER_MINUTE;

    let last_ms = match input.last_scheduled_for.as_deref() {
        Some(value) => {
            parse_ms(value).ok_or_else(|| SpacingError::InvalidTimestamp(value.to_string()))?
        }
        None => now_ms,
    };
    let anchor = last_ms.max(now_ms);

    let recent = input.recent_gap_ms.as_deref();
    let last_gap_ms = recent.and_then(|gaps| gaps.last().copied());

    let boost = apply_anti_cluster(recent);
    let picked = pick_random_gap(
        rng,
        min_ms,
        max_ms,
        last_gap_ms,
        boost.apply.then_some(boost.range),
    );

    let mut gap_ms = picked.gap_ms;
    let mut long_pause = false;

    // Occasionally insert a long multi-hour pause. Humans post in clusters
    // separated by long silent stretches, so a steady band with no long gaps
    // reads as mechanical.
    let long_pause_chance = match input.long_pause_chance.filter(|value| value.is_finite()) {
        Some(value) => value.clamp(0.0, 1.0),
        None => 0.15,
    };
    let long_pause_min_ms = input
        .long_pause_min_minutes
        .filter(|value| value.is_finite())
        .unwrap_or(180.0)
        * MS_PER_MINUTE;
    let long_pause_max_ms = input
        .long_pause_max_minutes
        .filter(|value| value.is_finite())
        .unwrap_or(480.0)
        * MS_PER_MINUTE;

    if rng.random::<f64>() < long_pause_chance && long_pause_max_ms > long_pause_min_ms {
        let long_gap_ms =
            long_pause_min_ms + rng.random::<f64>() * (long_pause_max_ms - long_pause_min_ms);
        gap_ms = long_gap_ms.round();
        long_pause = true;
    } else if gap_ms < min_ms {
        gap_ms = min_ms;
    } else if gap_ms > max_ms * 1.2 {
        gap_ms = max_ms * 1.2;
    }

    let scheduled_for = iso_from_ms(anchor + gap_ms)
        .ok_or_else(|| SpacingError::InvalidTimestamp(input.timestamp.clone()))?;
    let gap_minutes = round1(gap_ms / MS_PER_MINUTE);
    let reason = if long_pause {
        format!("long-pause {}m", (gap_ms / MS_PER_MINUTE).round())
    } else if boost.apply {
        format!("anti-cluster: {}", picked.reason)
    } else {
        picked.reason.to_string()
    };

    Ok(NextAutopostResult {
        scheduled_for,
        gap_ms,
        gap_minutes,
        reason,
    })
}
