//! Date/time helpers matching JavaScript `Date` semantics, shared by the
//! adapters and the aggregator.
//!
//! The offsets chosen here mirror `Date.parse`/`Date.toISOString`:
//! - ISO strings (`2026-11-06T18:00:11.456Z`) are always UTC.
//! - `Month D, YYYY` (`November 6, 2026`) parses as *local* midnight.
//! - RFC-2822 feed dates (`Fri, 06 Nov 2026 12:00:00 GMT`) are UTC in
//!   practice; a trailing zone token is stripped and the remainder parsed
//!   as UTC (JS resolves named zones properly, but `GMT`/`UTC`/`UT` — the
//!   only ones RSS feeds emit — are all zero-offset).

use chrono::{DateTime, Local, NaiveDate, NaiveDateTime, SecondsFormat, TimeZone, Utc};

fn parse_naive_with(formats: &[&str], value: &str) -> Option<NaiveDateTime> {
    formats
        .iter()
        .filter_map(|format| NaiveDateTime::parse_from_str(value, format).ok())
        .next()
}

fn naive_to_millis_utc(naive: NaiveDateTime) -> Option<i64> {
    Some(DateTime::<Utc>::from_naive_utc_and_offset(naive, Utc).timestamp_millis())
}

fn naive_to_millis_local(naive: NaiveDateTime) -> Option<i64> {
    Local
        .from_local_datetime(&naive)
        .single()
        .map(|local| local.timestamp_millis())
}

/// `Date.parse` value in epoch milliseconds, or `None` when JS would return
/// `NaN`.
pub(crate) fn parse_datetime_millis(value: &str) -> Option<i64> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(parsed.timestamp_millis());
    }
    // ISO date-only: JS treats it as UTC midnight.
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") {
        if let Some(naive) = date.and_hms_opt(0, 0, 0) {
            return naive_to_millis_utc(naive);
        }
        return None;
    }
    // "Month D, YYYY" / "Mon D, YYYY": JS parses as local midnight.
    let text = value.trim();
    for format in ["%B %-d, %Y", "%B %d, %Y", "%b %-d, %Y", "%b %d, %Y"] {
        if let Ok(date) = NaiveDate::parse_from_str(text, format) {
            if let Some(naive) = date.and_hms_opt(0, 0, 0) {
                return naive_to_millis_local(naive);
            }
        }
    }
    // RFC-2822-ish feed date: strip a trailing zone token, parse as UTC.
    let stripped = text
        .strip_suffix(" GMT")
        .or_else(|| text.strip_suffix(" UTC"))
        .or_else(|| text.strip_suffix(" UT"))
        .unwrap_or(text);
    if stripped != text {
        if let Some(naive) = parse_naive_with(
            &["%a, %d %b %Y %H:%M:%S", "%a, %d %b %y %H:%M:%S"],
            stripped,
        ) {
            return naive_to_millis_utc(naive);
        }
    }
    None
}

/// Unix milliseconds → `Date.prototype.toISOString()`.
pub(crate) fn iso_from_unix_millis(millis: i64) -> Option<String> {
    Utc.timestamp_millis_opt(millis)
        .single()
        .map(|instant| instant.to_rfc3339_opts(SecondsFormat::Millis, true))
}

/// Unix seconds → `Date.prototype.toISOString()`.
pub(crate) fn iso_from_unix_seconds(seconds: i64) -> Option<String> {
    Utc.timestamp_opt(seconds, 0)
        .single()
        .map(|instant| instant.to_rfc3339_opts(SecondsFormat::Millis, true))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parses_rfc3339_as_millis() {
        assert_eq!(
            parse_datetime_millis("2026-11-06T18:00:11.456Z"),
            Some(1_793_988_011_456)
        );
    }

    #[test]
    fn iso_date_only_is_utc_midnight() {
        assert_eq!(parse_datetime_millis("2026-11-06"), Some(1_793_923_200_000));
    }

    #[test]
    fn month_day_year_round_trips_through_local() {
        // Local-midnight parse, then ISO render: time depends on the machine
        // TZ in both stacks. Only pin the parse/format shape.
        let millis = parse_datetime_millis("November 6, 2026").unwrap();
        let iso = iso_from_unix_millis(millis).unwrap();
        assert_eq!(iso.len(), 24);
        assert!(iso.starts_with("2026-11-"));
    }

    #[test]
    fn rfc2822_gmt_is_utc() {
        assert_eq!(
            parse_datetime_millis("Fri, 06 Nov 2026 12:00:00 GMT"),
            Some(1_793_966_400_000)
        );
    }

    #[test]
    fn rejects_non_dates() {
        assert_eq!(parse_datetime_millis("Jan"), None);
        assert_eq!(parse_datetime_millis(""), None);
        assert_eq!(parse_datetime_millis("not a date"), None);
    }
}
