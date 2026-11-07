//! `zyquor poll-mentions` — cron shim for the mention flow.
//!
//! Port of `scripts/poll-x-mentions.mjs`: a thin client over the Zyquor API.
//! All scraping, dedupe, drafting and memory grounding happen inside
//! `POST /replies/mentions/scan-and-draft`; this command only calls the
//! local API, never writes to the database itself, and never auto-posts.
//! `--dry` (or `DRY_RUN=1`) lists mentions without drafting.

use crate::cli;

fn dry_run(args: &[String]) -> bool {
    args.iter().any(|arg| arg == "--dry") || std::env::var("DRY_RUN").as_deref() == Ok("1")
}

fn demo_queue_path() -> std::path::PathBuf {
    std::env::var("ZYQUOR_DEMO_QUEUE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| cli::repo_data_dir().join("demo-checks.jsonl"))
}

/// Extract an external (non-x.com) URL from mention text, mirroring
/// `externalUrlFromText` in the TypeScript script.
pub fn external_url_from_text(text: &str) -> Option<String> {
    let normalized = strip_x_links(text);
    if let Some(url) = find_http_url(&normalized) {
        return Some(trim_trailing_punct(url));
    }
    find_short_link(&normalized)
}

fn strip_x_links(text: &str) -> String {
    let lower = text.to_lowercase();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    let bytes = text.as_bytes();
    while index < text.len() {
        let rest = &lower[index..];
        if rest.starts_with("https://x.com/")
            || rest.starts_with("http://x.com/")
            || rest.starts_with("https://twitter.com/")
            || rest.starts_with("http://twitter.com/")
        {
            let mut end = index;
            while end < text.len() {
                let c = bytes[end] as char;
                if c.is_whitespace() || c == ')' {
                    break;
                }
                end += 1;
            }
            index = end;
            continue;
        }
        let mut next = text[index..].chars().next().unwrap_or(' ');
        let len = next.len_utf8();
        if next == ')' {
            // Kept: belongs to the surrounding sentence, the matcher skips it.
            output.push(next);
            index += len;
            continue;
        }
        let _ = &mut next;
        output.push_str(&text[index..index + len]);
        index += len;
    }
    output
}

fn find_http_url(text: &str) -> Option<&str> {
    let lower = text.to_lowercase();
    let start = lower.find("http://").or_else(|| lower.find("https://"))?;
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == ')' || c == '"')
        .unwrap_or(rest.len());
    Some(&rest[..end])
}

fn find_short_link(text: &str) -> Option<String> {
    for token in text.split_whitespace() {
        let token = token.trim_matches(|c: char| c == '(' || c == '"' || c == '\'');
        let lower = token.to_lowercase();
        if lower.starts_with("t.co/") && token.len() > 5 {
            return Some(format!("https://{token}"));
        }
        if lower.starts_with("www.") && token.contains('.') {
            let host = token.split('/').next().unwrap_or("");
            if host.matches('.').count() >= 1 {
                return Some(format!("https://{token}"));
            }
        }
    }
    None
}

fn trim_trailing_punct(url: &str) -> String {
    url.trim_end_matches(['.', ',', ';', ':', '!', '?'])
        .to_string()
}

fn enqueue_demo_check(
    path: &std::path::Path,
    url: &str,
    reply_to_url: &str,
    handle: &str,
    account_id: &str,
) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let record = serde_json::json!({
        "url": url,
        "replyToUrl": reply_to_url,
        "handle": handle,
        "accountId": account_id,
    });
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(
            file,
            "{}",
            serde_json::to_string(&record).unwrap_or_default()
        );
    }
}

async fn resolve_api_url() -> Result<String, String> {
    if let Ok(value) = std::env::var("ZYQUOR_API_URL") {
        if !value.is_empty() {
            return Ok(value.trim_end_matches('/').to_string());
        }
    }
    for port in ["3000", "3001"] {
        let candidate = format!("http://127.0.0.1:{port}");
        let probe = cli::http(&candidate);
        if probe.get_json("/health", 3_000).await.is_ok() {
            return Ok(candidate);
        }
    }
    Err("Zyquor API not reachable on 127.0.0.1:3000 or 3001. Set ZYQUOR_API_URL.".to_string())
}

async fn resolve_account_id(api_url: &str) -> Result<String, String> {
    if let Ok(value) = std::env::var("ZYQUOR_MENTIONS_ACCOUNT_ID") {
        if !value.is_empty() {
            return Ok(value);
        }
    }
    let probe = cli::http(api_url);
    let value = probe.get_json("/accounts", 10_000).await?;
    let accounts = value.get("accounts").and_then(serde_json::Value::as_array);
    let Some(accounts) = accounts else {
        return Err(
            "No Zyquor account exists. Set ZYQUOR_MENTIONS_ACCOUNT_ID or create an account."
                .to_string(),
        );
    };
    let account = accounts
        .iter()
        .find(|account| account.get("enabled").and_then(serde_json::Value::as_bool) == Some(true))
        .or_else(|| accounts.first());
    let Some(account) = account else {
        return Err(
            "No Zyquor account exists. Set ZYQUOR_MENTIONS_ACCOUNT_ID or create an account."
                .to_string(),
        );
    };
    let id = account
        .get("id")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let handle = account
        .get("handle")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    println!("Drafting for account {id} (@{handle}); set ZYQUOR_MENTIONS_ACCOUNT_ID to override.");
    Ok(id.to_string())
}

pub async fn run(args: &[String]) -> Result<i32, String> {
    if !cli::repo_root().join("package.json").is_file()
        && !cli::repo_root().join("Cargo.toml").is_file()
    {
        eprintln!("Run this script from within the zyquor repo.");
        return Ok(1);
    }
    let api_url = match resolve_api_url().await {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return Ok(1);
        }
    };
    let account_id = match resolve_account_id(&api_url).await {
        Ok(value) => value,
        Err(error) => {
            eprintln!("{error}");
            return Ok(1);
        }
    };
    let is_dry = dry_run(args);
    println!(
        "{api_url}  account={account_id}{}",
        if is_dry { "  [DRY RUN]" } else { "" }
    );

    let probe = cli::http(&api_url);
    if is_dry {
        let path = format!(
            "/replies/mentions?accountId={}",
            percent_encode(&account_id)
        );
        let value = probe.get_json(&path, 90_000).await?;
        let scanned = value
            .get("scanned")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let ads_skipped = value
            .get("adsSkipped")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        let mentions = value
            .get("mentions")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        println!(
            "Scanned {scanned} mention article(s) ({ads_skipped} promoted skipped). {} fresh within 48h.",
            mentions.len()
        );
        for mention in &mentions {
            let author = mention
                .get("authorHandle")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?");
            let url = mention
                .get("url")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("?");
            let flags = [
                if mention.get("drafted").and_then(serde_json::Value::as_bool) == Some(true) {
                    Some("drafted")
                } else {
                    None
                },
                if mention.get("posted").and_then(serde_json::Value::as_bool) == Some(true) {
                    Some("posted")
                } else {
                    None
                },
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(", ");
            println!(
                "  @{author}: {url}{}",
                if flags.is_empty() {
                    String::new()
                } else {
                    format!("  [{flags}]")
                }
            );
            let text = mention
                .get("text")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            println!("    {}", text.chars().take(140).collect::<String>());
        }
        println!("DRY_RUN only lists what would be drafted. Run without DRY_RUN to create drafts.");
        return Ok(0);
    }

    let body = serde_json::json!({ "accountId": account_id });
    let result = probe
        .post_json("/replies/mentions/scan-and-draft", Some(&body), 120_000)
        .await?;
    let scanned = result
        .get("scanned")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    let ads_skipped = result
        .get("adsSkipped")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    println!("Scanned {scanned} mention article(s) ({ads_skipped} promoted skipped).");
    let created = result
        .get("created")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let skipped = result
        .get("skipped")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let queue = demo_queue_path();
    let mut demo_checks = 0_usize;
    for entry in &created {
        let draft = entry.get("draft");
        let reply_to = draft.and_then(|draft| draft.get("replyTo"));
        let text = reply_to
            .and_then(|reply_to| reply_to.get("text"))
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                draft
                    .and_then(|draft| draft.get("sourceInput"))
                    .and_then(serde_json::Value::as_str)
            })
            .unwrap_or("");
        if let Some(external) = external_url_from_text(text) {
            let reply_url = reply_to
                .and_then(|reply_to| reply_to.get("url"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let handle = reply_to
                .and_then(|reply_to| reply_to.get("authorHandle"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            enqueue_demo_check(&queue, &external, reply_url, handle, &account_id);
            demo_checks += 1;
        }
        let author = reply_to
            .and_then(|reply_to| reply_to.get("authorHandle"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("?");
        let url = reply_to
            .and_then(|reply_to| reply_to.get("url"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("?");
        println!("  drafted @{author}: {url}");
    }
    for item in &skipped {
        let url = item
            .get("url")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("?");
        let reason = item
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("?");
        println!("  skipped {url}: {reason}");
    }
    if demo_checks > 0 {
        println!("Enqueued {demo_checks} external page URL(s) for demo-check.");
    }
    println!(
        "Created {} reply draft(s). Review them in the app before approving; nothing auto-posts.",
        created.len()
    );
    Ok(0)
}

fn percent_encode(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            other => output.push_str(&format!("%{other:02X}")),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_skips_x_links() {
        assert_eq!(
            external_url_from_text("see https://x.com/a/status/1 and https://example.com/a."),
            Some("https://example.com/a".to_string())
        );
        assert_eq!(external_url_from_text("no links here"), None);
        assert_eq!(
            external_url_from_text("try t.co/abc123 for details"),
            Some("https://t.co/abc123".to_string())
        );
    }
}
