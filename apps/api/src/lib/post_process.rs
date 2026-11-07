//! Post-process tracing, ported from `apps/api/src/lib/post-process.ts`.
use std::sync::atomic::{AtomicU64, Ordering};

static TRACE_SEQ: AtomicU64 = AtomicU64::new(0);

fn millis_base36(value: u128) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut buf = [0u8; 32];
    let mut index = buf.len();
    let mut current = value;
    while current > 0 {
        index -= 1;
        let digit = (current % 36) as u8;
        buf[index] = if digit < 10 {
            b'0' + digit
        } else {
            b'a' + (digit - 10)
        };
        current /= 36;
    }
    String::from_utf8_lossy(&buf[index..]).to_string()
}

fn head(text: &str) -> String {
    text.chars().take(60).collect()
}

/// Port of `tracePostProcessTweetText(label, text, preserveCase)`.
pub fn trace_post_process_tweet_text(label: &str, text: &str, preserve_case: bool) -> String {
    let seq = TRACE_SEQ.fetch_add(1, Ordering::SeqCst) + 1;
    let millis = chrono::Utc::now().timestamp_millis();
    let millis_text = if millis < 0 {
        format!("-{}", millis_base36(millis.unsigned_abs() as u128))
    } else {
        millis_base36(millis as u128)
    };
    let trace_id = format!("pp-{millis_text}-{seq}");
    let after = if preserve_case {
        zyquor_generation::format_tweet_text(text)
    } else {
        zyquor_generation::post_process_tweet_text(text)
    };
    let before_has_upper = text.chars().any(|c| c.is_ascii_uppercase());
    let after_has_upper = after.chars().any(|c| c.is_ascii_uppercase());
    let changed = text != after;
    eprintln!(
        "[trace={trace_id}] [post-process] label={label} beforeLen={} afterLen={} changed={changed} beforeHasUpper={before_has_upper} afterHasUpper={after_has_upper} beforeHead={} afterHead={}",
        text.len(),
        after.len(),
        serde_json::to_string(&head(text)).unwrap_or_else(|_| "\"\"".to_string()),
        serde_json::to_string(&head(&after)).unwrap_or_else(|_| "\"\"".to_string()),
    );
    after
}
