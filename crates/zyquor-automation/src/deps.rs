//! Environment-derived configuration, in one place.
//!
//! The TypeScript implementation reads `process.env` in three different files
//! (`qualityMinimum` in draft paths, host caps and the daily target in
//! ingest). [`AutomationDeps`] builds all of those values once from the
//! injected environment lookup and hands the same batch to every module, so
//! no call site reaches for the environment itself.

use zyquor_core::paths::EnvLookup;
use zyquor_generation::quality_minimum;

const DEFAULT_MAX_SAME_HOST_POSTS_PER_DAY: i64 = 100;
const DEFAULT_MAX_GITHUB_POSTS_PER_DAY: i64 = 100;

fn js_number(value: Option<String>) -> Option<f64> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        // `Number("") === 0` in JavaScript.
        return Some(0.0);
    }
    trimmed.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn env_positive_int(env: EnvLookup<'_>, name: &str, fallback: i64) -> i64 {
    match js_number(env(name)) {
        Some(parsed) if parsed.fract() == 0.0 && parsed > 0.0 => parsed as i64,
        _ => fallback,
    }
}

fn js_int_or(value: Option<f64>, default: i64) -> i64 {
    value.map(|float| float.floor() as i64).unwrap_or(default)
}

/// The environment-derived values the automation modules read.
#[derive(Debug, Clone)]
pub struct AutomationDeps {
    /// Quality floor for auto-approval (`ZYQUOR_QUALITY_MIN`).
    pub quality_min: f64,
    /// Posts/day cap per non-GitHub host (`ZYQUOR_MAX_SAME_HOST_POSTS_PER_DAY`).
    pub max_same_host_posts_per_day: i64,
    /// Posts/day cap for github.com (`ZYQUOR_MAX_GITHUB_POSTS_PER_DAY`).
    pub max_github_posts_per_day: i64,
    /// Daily packet target bounds (`ZYQUOR_DAILY_PACKET_MIN/MAX`).
    pub daily_packet_min: usize,
    pub daily_packet_max: usize,
    /// Engagement minimum sample before the dead-source derate (`ZYQUOR_DEAD_SOURCE_MIN_SAMPLE`).
    pub dead_source_min_sample: i64,
}

impl AutomationDeps {
    /// Build from the injected environment lookup.
    pub fn from_env(env: EnvLookup<'_>) -> Self {
        let min = js_int_or(js_number(env("ZYQUOR_DAILY_PACKET_MIN")), 6).clamp(1, 20) as usize;
        let max = js_int_or(js_number(env("ZYQUOR_DAILY_PACKET_MAX")), 10)
            .clamp(1, 20)
            .max(min as i64) as usize;
        Self {
            quality_min: quality_minimum(env),
            max_same_host_posts_per_day: env_positive_int(
                env,
                "ZYQUOR_MAX_SAME_HOST_POSTS_PER_DAY",
                DEFAULT_MAX_SAME_HOST_POSTS_PER_DAY,
            ),
            max_github_posts_per_day: env_positive_int(
                env,
                "ZYQUOR_MAX_GITHUB_POSTS_PER_DAY",
                DEFAULT_MAX_GITHUB_POSTS_PER_DAY,
            ),
            daily_packet_min: min,
            daily_packet_max: max,
            dead_source_min_sample: env_positive_int(env, "ZYQUOR_DEAD_SOURCE_MIN_SAMPLE", 5),
        }
    }

    /// Per-host daily caps, matching `sameHostPostCap` in ingest.ts.
    pub fn same_host_post_cap(&self, host: &str) -> i64 {
        if host == "github.com" {
            self.max_github_posts_per_day
        } else {
            self.max_same_host_posts_per_day
        }
    }

    /// `dailyPacketTarget` from ingest.ts: a deterministic pseudo-random day
    /// number in `[daily_packet_min, daily_packet_max]` for the given
    /// `today` (UTC date, YYYY-MM-DD).
    pub fn daily_packet_target(&self, today: &str) -> usize {
        let mut hash: u32 = 2_166_136_261;
        for byte in today.bytes() {
            hash = (hash ^ (byte as u32)).wrapping_mul(16_777_619);
        }
        let state = hash.wrapping_add(0x6d2b79f5);
        let mut mixed = (state ^ (state >> 15)).wrapping_mul(1 | state);
        mixed = mixed.wrapping_add((mixed ^ (mixed >> 7)).wrapping_mul(61 | mixed)) ^ mixed;
        let unit = (mixed ^ (mixed >> 14)) as f64 / 4_294_967_296.0;
        self.daily_packet_min
            + (unit * (self.daily_packet_max - self.daily_packet_min + 1) as f64).floor() as usize
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn empty_env() -> impl Fn(&str) -> Option<String> + 'static {
        |_| None
    }

    #[test]
    fn defaults_match_typescript() {
        let deps = AutomationDeps::from_env(&empty_env());
        assert_eq!(deps.quality_min, 7.0);
        assert_eq!(deps.daily_packet_min, 6);
        assert_eq!(deps.daily_packet_max, 10);
        assert_eq!(deps.same_host_post_cap("github.com"), 100);
        assert_eq!(deps.dead_source_min_sample, 5);
    }

    #[test]
    fn daily_target_is_bounded_and_in_range() {
        let deps = AutomationDeps::from_env(&empty_env());
        for day in 0..30 {
            let today = format!("2026-11-{:02}", day + 1);
            let target = deps.daily_packet_target(&today);
            assert!((6..=10).contains(&target), "got {target}");
        }
    }
}
