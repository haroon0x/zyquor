//! Count parsing for engagement numbers, ported from `parseCount` /
//! `extractUnitCount` in `packages/browser/src/index.ts`.

/// `parseCount` — human counts like `"1.2K"`, `"3.4M"` → integer amounts.
pub fn parse_count(value: Option<&str>) -> Option<i64> {
    let value = value?;
    let cleaned = value
        .replace(',', "")
        .replace(char::is_whitespace, "")
        .to_lowercase();
    let cleaned = cleaned.chars().collect::<String>();
    let chars = cleaned.chars();
    let number: String = chars
        .clone()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let suffix: String = cleaned.chars().skip(number.len()).collect();
    if number.is_empty() {
        return None;
    }
    let num: f64 = number.parse().ok()?;
    let multiplier = match suffix.as_str() {
        "" => 1,
        "k" => 1_000,
        "m" => 1_000_000,
        "b" => 1_000_000_000,
        _ => return None,
    };
    Some((num * multiplier as f64).round() as i64)
}

/// `extractUnitCount` — first non-null parse of the pattern over the
/// sources (aria labels, containers, body text).
pub fn extract_unit_count(sources: &[String], pattern: &str) -> Option<i64> {
    let regex = fancy_regex::Regex::new(pattern).ok()?;
    for source in sources {
        let caps = match regex.captures(source) {
            Ok(Some(caps)) => caps,
            _ => continue,
        };
        if let Some(found) = caps.get(1) {
            if let Some(parsed) = parse_count(Some(found.as_str())) {
                return Some(parsed);
            }
        }
    }
    None
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parses_human_counts() {
        assert_eq!(parse_count(Some("1.2K")), Some(1_200));
        assert_eq!(parse_count(Some("3.4m")), Some(3_400_000));
        assert_eq!(parse_count(Some("1,234")), Some(1_234));
        assert_eq!(parse_count(Some("42")), Some(42));
        assert_eq!(parse_count(Some("1.5B")), Some(1_500_000_000));
        assert_eq!(parse_count(Some("junk")), None);
        assert_eq!(parse_count(None), None);
    }

    #[test]
    fn extracts_first_matching_count() {
        let sources = vec!["5.3M views".to_string(), "1.2K replies".to_string()];
        assert_eq!(
            extract_unit_count(&sources, r"(?i)([\d.,]+\s*[kmb]?)\s*views?\b"),
            Some(5_300_000)
        );
        assert_eq!(
            extract_unit_count(&sources, r"(?i)([\d.,]+\s*[kmb]?)\s*repl\w*\b"),
            Some(1_200)
        );
    }
}
