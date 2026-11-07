//! XML/HTML helpers shared by the feed parsers (`rss.rs`, `techcrunch.rs`,
//! `arxiv.rs`, `model_releases.rs`), ported from the duplicated helpers in
//! the TypeScript adapters.
//!
//! Each helper ports a specific TypeScript regex/replace so behavior matches
//! the JavaScript original exactly (same pattern, same order of operations).

use fancy_regex::Regex;

/// Compile-time-constant regex; a bad pattern yields no match (same
/// best-effort posture as elsewhere in the crate).
fn compile(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}

/// `value.replace(pattern, replacement)` with all occurrences.
pub(crate) fn replace_all(pattern: &str, value: &str, replacement: &str) -> String {
    match compile(pattern).and_then(|regex| regex.try_replacen(value, 0, replacement).ok()) {
        Some(replaced) => replaced.to_string(),
        None => value.to_string(),
    }
}

/// First capturing group of the first match, if any.
pub(crate) fn first_group(pattern: &str, value: &str) -> Option<String> {
    capture_groups(pattern, value).and_then(|mut groups| groups.drain(..).next())
}

/// Captured groups of the first match, if any.
pub(crate) fn capture_groups(pattern: &str, value: &str) -> Option<Vec<String>> {
    compile(pattern).and_then(|regex| {
        regex.captures(value).ok().flatten().map(|caps| {
            (1..caps.len())
                .map(|i| {
                    caps.get(i)
                        .map(|matched| matched.as_str().to_string())
                        .unwrap_or_default()
                })
                .collect()
        })
    })
}

/// First group of every match (JS `matchAll`).
pub(crate) fn all_first_groups(pattern: &str, value: &str) -> Vec<String> {
    let Some(regex) = compile(pattern) else {
        return Vec::new();
    };
    regex
        .captures_iter(value)
        .filter_map(Result::ok)
        .filter_map(|caps| caps.get(1).map(|matched| matched.as_str().to_string()))
        .collect()
}

/// `String.split(pattern)` without capture-group interleaving (unused for
/// captures — see `deepseek_updates`' `split_keep_captures` for those).
pub(crate) fn split_pattern(pattern: &str, value: &str) -> Vec<String> {
    match compile(pattern) {
        Some(regex) => regex
            .split(value)
            .filter_map(Result::ok)
            .map(|chunk| chunk.to_string())
            .collect(),
        None => vec![value.to_string()],
    }
}

/// `String.replace(/^<!\[CDATA\[/, "").replace(/\]\]>$/, "")` from `rss.ts`.
pub(crate) fn strip_cdata(value: &str) -> String {
    let without_open = value.strip_prefix("<![CDATA[").unwrap_or(value);
    without_open
        .strip_suffix("]]>")
        .unwrap_or(without_open)
        .to_string()
}

/// `decodeXml` from `rss.ts`: the five named entities, `&amp;` first.
pub(crate) fn decode_xml(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

/// `decodeXml` from `model_releases.ts` / `xai-news.ts` / `deepseek-updates.ts`
/// (adds `&#x27;`).
pub(crate) fn decode_xml_apos(value: &str) -> String {
    decode_xml(value).replace("&#x27;", "'")
}

/// `extractXmlTag` from `rss.ts` (case-sensitive): first match of
/// `<tag[^>]*>([\s\S]*?)</tag>`, CDATA stripped and trimmed.
pub(crate) fn extract_xml_tag(xml: &str, tag: &str) -> String {
    first_group(&format!("<{tag}[^>]*>([\\s\\S]*?)</{tag}>"), xml)
        .map(|value| strip_cdata(&value).trim().to_string())
        .unwrap_or_default()
}

/// `extractTag` from `techcrunch.ts`/`arxiv.ts` (trim only, case-sensitive).
pub(crate) fn extract_tag_trim(xml: &str, tag: &str) -> String {
    first_group(&format!("<{tag}[^>]*>([\\s\\S]*?)</{tag}>"), xml)
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

/// Attribute extraction from `rss.ts`/`techcrunch.ts` (`(?i)` flag, requires
/// whitespace before the attribute name).
pub(crate) fn extract_attribute(xml: &str, tag: &str, attribute: &str) -> String {
    first_group(
        &format!(r#"(?i)<{tag}[^>]*\s{attribute}=["']([^"']+)["'][^>]*>"#),
        xml,
    )
    .map(|value| value.trim().to_string())
    .unwrap_or_default()
}

/// `extractRssImageUrl` from `rss.ts`/`techcrunch.ts`: first of
/// media:content, media:thumbnail, enclosure `url`, kept only when the
/// extension is an image extension (optionally with `?` query).
pub(crate) fn extract_rss_image_url(xml: &str) -> String {
    let media_url = extract_attribute(xml, "media:content", "url");
    let media_url = if media_url.is_empty() {
        extract_attribute(xml, "media:thumbnail", "url")
    } else {
        media_url
    };
    let media_url = if media_url.is_empty() {
        extract_attribute(xml, "enclosure", "url")
    } else {
        media_url
    };
    if media_url.is_empty() {
        return String::new();
    }
    // `/\.(avif|gif|jpe?g|png|webp)(\?|$)/i` — the extension runs to end or `?`.
    let lower = media_url.to_lowercase();
    let has_ext = [".avif", ".gif", ".jpg", ".jpeg", ".png", ".webp"]
        .iter()
        .any(|ext| lower.contains(&format!("{ext}?")) || lower.ends_with(ext));
    if has_ext {
        decode_xml(&media_url)
    } else {
        String::new()
    }
}

/// `stripHtml` from `arxiv.ts`/`hiring.ts`: tags to spaces, entities decoded
/// (incl. `&#x27;`), whitespace collapsed and trimmed.
pub(crate) fn strip_html(html: &str) -> String {
    replace_all(
        r"\s+",
        &replace_entities_arxiv(&replace_all(r"<[^>]+>", html, " ")),
        " ",
    )
    .trim()
    .to_string()
}

fn replace_entities_arxiv(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
}

/// `stripTags` from the HTML adapters: remove `<script>…</script>` and
/// `<style>…</style>` blocks (→ `" "`), then replace remaining tags with
/// `replacement` (`" "` or `"\n"`).
pub(crate) fn strip_tags(value: &str, replacement: &str) -> String {
    let without_scripts = replace_all(r"<script[\s\S]*?</script>", value, " ");
    let without_styles = replace_all(r"<style[\s\S]*?</style>", &without_scripts, " ");
    replace_all(r"<[^>]+>", &without_styles, replacement)
}

/// `cleanText` from the HTML adapters: whitespace collapsed, trimmed.
pub(crate) fn clean_text_whitespace(value: &str) -> String {
    replace_all(r"\s+", value, " ").trim().to_string()
}
