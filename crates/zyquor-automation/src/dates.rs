//! Date/time helpers matching JavaScript `Date` semantics.
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
pub(crate) fn parse_millis(value: &str) -> Option<i64> {
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
    if let Some(naive) = parse_naive_with(&["%B %-d, %Y", "%b %d, %Y"], text) {
        return naive_to_millis_local(naive);
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
pub(crate) fn iso_from_millis(millis: i64) -> String {
    Utc.timestamp_millis_opt(millis)
        .single()
        .map(|instant| instant.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_default()
}
