//! Source-text cleaning primitives shared by `packet.rs` and `quality.rs`,
//! ported from `context.ts` (`cleanSentence`, `truncateText`).

use fancy_regex::Regex;

/// `value.replace(pattern, replacement)` with all occurrences.
pub(crate) fn replace_all(pattern: &str, value: &str, replacement: &str) -> String {
    match Regex::new(pattern) {
        Ok(regex) => match regex.try_replacen(value, 0, replacement) {
            Ok(replaced) => replaced.to_string(),
            Err(_) => value.to_string(),
        },
        Err(_) => value.to_string(),
    }
}

/// `value.replace(pattern, replacement)` for the first occurrence only.
pub(crate) fn replace_first(pattern: &str, value: &str, replacement: &str) -> String {
    match Regex::new(pattern) {
        Ok(regex) => match regex.try_replacen(value, 1, replacement) {
            Ok(replaced) => replaced.to_string(),
            Err(_) => value.to_string(),
        },
        Err(_) => value.to_string(),
    }
}

/// `String.fromCodePoint` equivalent for a parsed numeric code point.
/// Out-of-range values degrade to `U+FFFD` (the JS call would throw).
fn from_code_point(code: u32) -> char {
    char::from_u32(code).unwrap_or('\u{FFFD}')
}

/// `cleanSentence` from `context.ts`: strip tags, decode entities and
/// markdown links, normalize quotes, collapse whitespace, and drop relics
/// like `SourcePacket`.
pub(crate) fn clean_sentence(value: &str) -> String {
    let cleaned = replace_all(r"<[^>]*>", value, " ");
    let cleaned = replace_hex_entities(&cleaned);
    let cleaned = replace_decimal_entities(&cleaned);
    let cleaned = cleaned
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace(['\u{2018}', '\u{2019}'], "'")
        .replace(['\u{201C}', '\u{201D}'], "\"");
    let cleaned = replace_all(r"[\p{Extended_Pictographic}\uFE0F\u200D]", &cleaned, " ");
    let cleaned = replace_all(r"\\\//", &cleaned, "/");
    let cleaned = replace_all(r"\[([^\]]+)\]\((https?://[^)]+)\)", &cleaned, "$1 $2");
    let collapsed = replace_all(r"\s+", &cleaned, " ");
    let collapsed = replace_all(r"(?i)\bSourcePacket\b", &collapsed, "");
    let collapsed = replace_all(r"(?i)\bsource packet\b", &collapsed, "");
    collapsed.trim().to_string()
}

fn replace_hex_entities(value: &str) -> String {
    replace_numeric_entities(value, r"(?i)&#x([0-9a-f]+);", 16)
}

fn replace_decimal_entities(value: &str) -> String {
    replace_numeric_entities(value, r"&#(\d+);", 10)
}

fn replace_numeric_entities(value: &str, pattern: &str, radix: u32) -> String {
    let Some(regex) = Regex::new(pattern).ok() else {
        return value.to_string();
    };
    let mut out = String::new();
    let mut last = 0_usize;
    for caps in regex.captures_iter(value).filter_map(Result::ok) {
        let Some(whole) = caps.get(0) else {
            continue;
        };
        out.push_str(&value[last..whole.start()]);
        let digits = caps.get(1).map(|d| d.as_str()).unwrap_or("");
        if let Ok(code) = u32::from_str_radix(digits, radix) {
            out.push(from_code_point(code));
        }
        last = whole.end();
    }
    out.push_str(&value[last..]);
    out
}

/// `truncateText` from `context.ts`: clean, then cut to at most `max_length`
/// chars with a final period.
pub(crate) fn truncate_text(value: &str, max_length: usize) -> String {
    let clean = clean_sentence(value);
    if clean.chars().count() <= max_length {
        return clean;
    }
    let end = if max_length == 0 {
        clean.chars().count().saturating_sub(1)
    } else {
        max_length - 1
    };
    let cut: String = clean.chars().take(end).collect();
    format!("{}.", cut.trim_end())
}
