//! `zyquor reply-loop [--once] [--dry]` — reply runner.
//!
//! Port of `scripts/reply-loop.mjs`: discovers reply targets from the home
//! feed (via the API) and X search (via the logged-in CDP Chrome), drafts
//! best-of-N via the API, screens candidates with the deterministic slop
//! filter, and only then approves and posts through the gated job path.
//! Mentions are deliberately not part of this loop. Failed drafts are
//! retried after `ZYQUOR_REPLY_LOOP_RETRY_HOURS` (default 6h), matching the
//! CHANGELOG retry-hours semantics. Approval/posting requires
//! `ZYQUOR_ENABLE_BROWSER_PREPARE=1`.

use std::io::Write;

use crate::cli;

const DEFAULT_QUERIES: &[&str] = &[
    "coding agents",
    "claude code",
    "ai agents",
    "self hosted",
    "postgres",
    "local first",
];

#[derive(Debug, Clone)]
pub struct Target {
    pub url: String,
    pub text: String,
    pub author: String,
}

#[derive(Debug, Default)]
struct State {
    seen: std::collections::HashMap<String, (String, String)>,
    authors: Vec<String>,
    query_index: usize,
}

fn data_dir() -> std::path::PathBuf {
    cli::ts_data_dir()
}

fn read_state() -> State {
    let path = data_dir().join("reply-loop-state.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return State::default();
    };
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let mut seen = std::collections::HashMap::new();
    if let Some(object) = value.get("seen").and_then(serde_json::Value::as_object) {
        for (key, entry) in object {
            let at = entry
                .get("at")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            let reason = entry
                .get("reason")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            seen.insert(key.clone(), (at.to_string(), reason.to_string()));
        }
    }
    let authors = value
        .get("authors")
        .and_then(serde_json::Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let query_index = value
        .get("queryIndex")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0) as usize;
    State {
        seen,
        authors,
        query_index,
    }
}

fn save_state(state: &State) {
    let mut entries: Vec<(&String, &(String, String))> = state.seen.iter().collect();
    entries.sort_by(|a, b| b.1.0.cmp(&a.1.0));
    entries.truncate(400);
    let mut seen = serde_json::Map::new();
    for (key, (at, reason)) in entries {
        seen.insert(key.clone(), serde_json::json!({"at": at, "reason": reason}));
    }
    let value = serde_json::json!({"seen": seen, "authors": state.authors, "queryIndex": state.query_index});
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(
        data_dir().join("reply-loop-state.json"),
        serde_json::to_string_pretty(&value).unwrap_or_default(),
    );
}

fn log(message: &str) {
    let stamp = chrono::Utc::now().format("%H:%M:%S");
    println!("[reply-loop {stamp}] {message}");
}

fn record(entry: &serde_json::Value) {
    let _ = std::fs::create_dir_all(data_dir());
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir().join("reply-loop.jsonl"))
    {
        let _ = writeln!(file, "{}", serde_json::to_string(entry).unwrap_or_default());
    }
}

fn is_transient(reason: &str) -> bool {
    reason.starts_with("draft_failed") || reason.starts_with("post_failed")
}

/// Whether `url` counts as seen, with retry-hours semantics for transient
/// failures: a transient failure only blocks for `retry_after_ms`.
fn is_seen(state: &State, url: &str, retry_after_ms: i64) -> bool {
    let Some((at, reason)) = state.seen.get(url) else {
        return false;
    };
    if is_transient(reason) {
        let parsed = chrono::DateTime::parse_from_rfc3339(at).map(|time| time.timestamp_millis());
        match parsed {
            Ok(ms) => chrono::Utc::now().timestamp_millis() - ms < retry_after_ms,
            Err(_) => true,
        }
    } else {
        true
    }
}

fn mark_seen(state: &mut State, url: &str, reason: &str) {
    state
        .seen
        .insert(url.to_string(), (now_iso(), reason.to_string()));
    save_state(state);
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn contains_word(text: &str, word: &str) -> bool {
    let lower = text.to_lowercase();
    let word = word.to_lowercase();
    let mut start = 0;
    while let Some(found) = lower[start..].find(&word) {
        let index = start + found;
        let before_ok = index == 0
            || !lower[..index]
                .chars()
                .last()
                .map(|c| c.is_ascii_alphanumeric() || c == '_')
                .unwrap_or(false);
        let after = index + word.len();
        let after_ok = after >= lower.len()
            || !lower[after..]
                .chars()
                .next()
                .map(|c| c.is_ascii_alphanumeric() || c == '_')
                .unwrap_or(false);
        if before_ok && after_ok {
            return true;
        }
        start = index + word.len().max(1);
    }
    false
}

/// Reply screen, mirroring `slopReasons` in the TypeScript script.
pub fn slop_reasons(text: &str, target: &str) -> Vec<String> {
    let t = text.trim();
    let mut reasons = Vec::new();
    let chars = t.chars().count();
    if chars < 60 {
        reasons.push("too_short".to_string());
    }
    if chars > 279 {
        reasons.push("too_long".to_string());
    }
    if t.contains('?') && !target.contains('?') {
        reasons.push("question_not_asked".to_string());
    }
    if prompt_dodge(t) {
        reasons.push("prompt_dodge".to_string());
    }
    if advice(t) {
        reasons.push("advice".to_string());
    }
    if formula(text) {
        reasons.push("formula_contrast".to_string());
    }
    if [
        "delve",
        "leverage",
        "seamless",
        "robust",
        "game-changer",
        "game changer",
        "unlock",
        "revolutionary",
        "journey",
        "ecosystem",
        "quiet upside",
    ]
    .iter()
    .any(|word| contains_word(t, word))
    {
        reasons.push("slop_word".to_string());
    }
    let numbers = number_tokens(t);
    let known = number_tokens(target);
    if numbers.iter().any(|number| !known.contains(number)) {
        reasons.push("invented_number".to_string());
    }
    if experience_claim(t) {
        reasons.push("invented_experience".to_string());
    }
    if t.chars()
        .next()
        .map(|c| c.is_ascii_lowercase())
        .unwrap_or(false)
    {
        reasons.push("lowercase_opener".to_string());
    }
    if t.to_lowercase().contains("point ") && !target.to_lowercase().contains("point ") {
        reasons.push("invented_point".to_string());
    }
    reasons
}

fn number_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut last_digit = false;
    for ch in text.chars() {
        if ch.is_ascii_digit() || (ch == '.' && last_digit) {
            current.push(ch);
            last_digit = ch.is_ascii_digit();
        } else {
            if !current.is_empty() && last_digit {
                tokens.push(current.clone());
            }
            current.clear();
            last_digit = false;
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn prompt_dodge(text: &str) -> bool {
    let lower = text.trim_start().to_lowercase();
    let openers = [
        "explain",
        "describe",
        "tell me",
        "show me",
        "walk me",
        "can you",
        "could you",
        "would you",
        "please explain",
        "please describe",
        "please show",
        "please make",
        "please write",
        "please do",
        "what is",
        "what are",
        "what does",
        "what kind of",
        "how do",
        "how does",
        "how would",
        "how to",
        "why do",
        "why does",
        "why is",
        "why are",
        "which one",
        "which part",
        "which api",
        "which class",
        "which tool",
        "which module",
        "make me",
        "write me",
    ];
    openers
        .iter()
        .any(|opener| lower == *opener || lower.starts_with(&format!("{opener} ")))
}

fn advice(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "you should",
        "you need to",
        "you'll want to",
        "make sure",
        "be sure to",
        "try to",
        "consider",
        "just use",
        "worth a look",
        "worth checking",
        "start with",
        "avoid",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn formula(text: &str) -> bool {
    let lower = text.to_lowercase();
    let negations = [
        "isn't", "aren't", "wasn't", "doesn't", "don't", "won't", "can't",
    ];
    let mut is_formula_a = false;
    for negation in negations {
        let mut start = 0;
        while let Some(found) = lower[start..].find(negation) {
            let index = start + found;
            let tail = &lower[index..];
            if ["it's", "it is", "that's", "they're", "the real"]
                .iter()
                .any(|marker| tail.contains(marker))
            {
                is_formula_a = true;
            }
            start = index + negation.len();
        }
    }
    let formula_b = {
        let mut found_b = false;
        let mut start = 0;
        while let Some(index) = lower[start..].find("not") {
            let tail = &lower[start + index + 3..];
            if tail.contains("but") {
                found_b = true;
                break;
            }
            start = start + index + 3;
        }
        found_b
    };
    is_formula_a
        || formula_b
        || (lower.contains("the real ") && lower.contains(" is"))
        || (lower.contains(',')
            && ["doesn't", "isn't", "hasn't", "won't", "can't"]
                .iter()
                .any(|n| lower.contains(n)))
}

fn experience_claim(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "i've used",
        "i have used",
        "i've run",
        "i have run",
        "i've shipped",
        "i have shipped",
        "i've built",
        "i have built",
        "i've tried",
        "i have tried",
        "i've migrated",
        "i've deployed",
        "i've maintained",
        "i've worked",
        "in my experience",
        "in my team",
        "in my company",
        "at my company",
        "at my last job",
        "we use",
        "we run",
        "we shipped",
        "we built",
        "we tried",
        "when i ran",
        "when i tried",
        "when i used",
        "my team uses",
        "my team runs",
        "my team shipped",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

/// Target screen, mirroring `acceptableTarget`.
pub fn acceptable_target(text: &str) -> Option<&'static str> {
    let trimmed = text.trim();
    if trimmed.chars().count() < 70 {
        return Some("thin_text");
    }
    if trimmed.to_lowercase().contains("http://") || trimmed.to_lowercase().contains("https://") {
        return Some("has_link");
    }
    let bait = [
        "who should i follow",
        "drop your",
        "say hi",
        "tag someone",
        "what are you building",
        "am i the only",
        "follow train",
        "engagement",
    ];
    if bait
        .iter()
        .any(|marker| trimmed.to_lowercase().contains(marker))
    {
        return Some("bait");
    }
    if trimmed.starts_with('@') {
        return Some("reply_shaped");
    }
    None
}

async fn feed_targets(api: &cli::Http, account_id: &str) -> Vec<Target> {
    let path = format!("/replies/feed?accountId={}", percent_encode(account_id));
    let value = api.get_json(&path, 200_000).await;
    match value {
        Ok(value) => {
            let rows = value
                .get("tweets")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            log(&format!("feed: {} rows", rows.len()));
            rows.iter()
                .map(|row| Target {
                    url: row
                        .get("url")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    text: row
                        .get("text")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    author: row
                        .get("authorHandle")
                        .and_then(serde_json::Value::as_str)
                        .or_else(|| row.get("author").and_then(serde_json::Value::as_str))
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        }
        Err(error) => {
            log(&format!(
                "feed failed: {}",
                error.chars().take(120).collect::<String>()
            ));
            Vec::new()
        }
    }
}

async fn search_targets(queries: &[String], cdp_url: &str) -> Vec<Target> {
    let mut found = Vec::new();
    for query in queries {
        let full = format!("{query} -filter:replies lang:en");
        let rows = search_one(&full, cdp_url).await;
        log(&format!("search \"{full}\": {} rows", rows.len()));
        found.extend(rows);
    }
    found
}

async fn search_one(query: &str, cdp_url: &str) -> Vec<Target> {
    let Ok(session) = zyquor_browser::Session::connect(cdp_url).await else {
        return Vec::new();
    };
    let Ok(page) = session.new_page().await else {
        return Vec::new();
    };
    let search_url = format!(
        "https://x.com/search?q={}&src=typed_query&f=live",
        percent_encode(query)
    );
    let _ = page.goto(&search_url, 45_000).await;
    tokio::time::sleep(std::time::Duration::from_millis(6_500)).await;
    let _ = page.mouse_wheel(0.0, 1_800.0).await;
    let _ = page.scroll_by(1_800).await;
    tokio::time::sleep(std::time::Duration::from_millis(2_000)).await;
    // Art`-icle extraction mirrors the Playwright evaluate in the TS script.
    let rows: Vec<SearchRow> = page
        .evaluate(
            r#"(() => {
        return [...document.querySelectorAll("article[data-testid='tweet']")].map((article) => {
            const link = article.querySelector("a[href*='/status/']");
            const text = article.querySelector("[data-testid='tweetText']");
            const time = article.querySelector("time");
            const handle = article.querySelector("[data-testid='User-Name'] a[href^='/']");
            return {
                url: link ? new URL(link.getAttribute("href"), "https://x.com").toString() : "",
                text: text ? text.innerText.replace(/\s+/g, " ").trim() : "",
                at: time ? time.getAttribute("datetime") : "",
                author: handle ? handle.getAttribute("href").replace("/", "") : ""
            };
        }).filter((row) => row.url && row.text);
    })()"#,
        )
        .await
        .unwrap_or_default();
    session.close_owned_pages().await;
    rows.into_iter()
        .map(|row| Target {
            url: row.url,
            text: row.text,
            author: row.author,
        })
        .collect()
}

#[allow(dead_code)]
#[derive(Debug, serde::Deserialize)]
struct SearchRow {
    url: String,
    text: String,
    #[serde(default)]
    at: String,
    #[serde(default)]
    author: String,
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

pub async fn run(args: &[String]) -> Result<i32, String> {
    let once = args.iter().any(|arg| arg == "--once");
    let dry = args.iter().any(|arg| arg == "--dry");
    let account_id = cli::env_or("ZYQUOR_REPLY_ACCOUNT_ID", "account_personal");
    let cdp_url = cli::cdp_url();
    let interval_ms: u64 = std::env::var("ZYQUOR_REPLY_LOOP_INTERVAL_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(30 * 60 * 1000);
    let max_posts: usize = std::env::var("ZYQUOR_REPLY_LOOP_MAX_POSTS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1);
    let min_quality: f64 = std::env::var("ZYQUOR_REPLY_LOOP_MIN_QUALITY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(5.0);
    let count: usize = std::env::var("ZYQUOR_REPLY_LOOP_CANDIDATES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(4);
    let max_per_day: usize = std::env::var("ZYQUOR_REPLY_LOOP_MAX_PER_DAY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(20);
    let retry_after_ms: i64 = (std::env::var("ZYQUOR_REPLY_LOOP_RETRY_HOURS")
        .ok()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(6.0)
        * 3_600_000.0) as i64;

    let api_url = cli::resolve_api_url().await;
    let api = cli::http(&api_url);
    let version = api.get_json("/health", 5_000).await.ok();
    let model = version
        .as_ref()
        .and_then(|v| v.get("generation"))
        .and_then(|g| g.get("model"))
        .and_then(|m| m.as_str())
        .unwrap_or("unknown");
    log(&format!(
        "api {api_url} model={model} dry={dry} once={once}"
    ));
    cli::browser_lane_banner("reply-loop");
    let _ = std::fs::create_dir_all(data_dir());
    let mut state = read_state();

    loop {
        match run_cycle(
            &api,
            &mut state,
            &account_id,
            &cdp_url,
            &CycleConfig {
                max_posts,
                min_quality,
                count,
                max_per_day,
                retry_after_ms,
                dry,
            },
        )
        .await
        {
            Ok(posted) => log(&format!("cycle done, posted {posted}")),
            Err(error) => log(&format!(
                "cycle crashed: {}",
                error.chars().take(200).collect::<String>()
            )),
        }
        if once {
            break;
        }
        log(&format!("sleeping {} min", interval_ms / 60_000));
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
    Ok(0)
}

struct CycleConfig {
    max_posts: usize,
    min_quality: f64,
    count: usize,
    max_per_day: usize,
    retry_after_ms: i64,
    dry: bool,
}

async fn replies_in_last_day(api: &cli::Http) -> usize {
    let Ok(value) = api.get_json("/performance", 15_000).await else {
        return 0;
    };
    let history = value
        .get("history")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let since = chrono::Utc::now().timestamp_millis() - 24 * 60 * 60 * 1000;
    history
        .iter()
        .filter(|row| {
            row.get("tweetType").and_then(serde_json::Value::as_str) == Some("reply")
                && chrono::DateTime::parse_from_rfc3339(
                    row.get("postedAt")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or(""),
                )
                .map(|time| time.timestamp_millis() >= since)
                .unwrap_or(false)
        })
        .count()
}

async fn run_cycle(
    api: &cli::Http,
    state: &mut State,
    account_id: &str,
    cdp_url: &str,
    cfg: &CycleConfig,
) -> Result<u8, String> {
    let recent = replies_in_last_day(api).await;
    if recent >= cfg.max_per_day {
        log(&format!(
            "reply cap reached ({recent}/{} in the last 24h)",
            cfg.max_per_day
        ));
        return Ok(0);
    }

    let configured: Vec<String> = std::env::var("ZYQUOR_REPLY_LOOP_QUERIES")
        .ok()
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|q| !q.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    let pool: Vec<String> = if configured.is_empty() {
        DEFAULT_QUERIES.iter().map(|q| q.to_string()).collect()
    } else {
        configured
    };
    let start = state.query_index % pool.len();
    let queries = vec![pool[start].clone(), pool[(start + 1) % pool.len()].clone()];
    state.query_index = (start + 2) % pool.len();

    let feed = feed_targets(api, account_id).await;
    let search = search_targets(&queries, cdp_url).await;
    let all: Vec<Target> = feed
        .into_iter()
        .chain(search)
        .filter(|row| !row.url.is_empty() && !row.text.is_empty())
        .collect();
    let seen_authors: Vec<String> = state.authors.iter().rev().take(3).cloned().collect();
    let mut posted = 0_usize;

    for item in &all {
        if posted >= cfg.max_posts {
            break;
        }
        if is_seen(state, &item.url, cfg.retry_after_ms) {
            continue;
        }
        if item.author.eq_ignore_ascii_case("haroon0x") {
            continue;
        }
        if seen_authors.contains(&item.author.to_lowercase()) {
            continue;
        }
        if let Some(reason) = acceptable_target(&item.text) {
            mark_seen(state, &item.url, reason);
            record(
                &serde_json::json!({"at": now_iso(), "url": item.url, "author": item.author, "decision": "skip_target", "reason": reason}),
            );
            continue;
        }

        log(&format!("drafting {} {}", item.author, item.url));
        let draft_body = serde_json::json!({"accountId": account_id, "url": item.url, "count": cfg.count, "useMemory": false});
        let draft_value = match api
            .post_json("/replies/from-url", Some(&draft_body), 400_000)
            .await
        {
            Ok(value) => value,
            Err(error) => {
                let reason = format!(
                    "draft_failed:{}",
                    error.chars().take(80).collect::<String>()
                );
                mark_seen(state, &item.url, &reason);
                record(
                    &serde_json::json!({"at": now_iso(), "url": item.url, "author": item.author, "decision": "skip_target", "reason": reason}),
                );
                log(&format!("  {reason}"));
                continue;
            }
        };
        let draft_id = draft_value
            .get("draft")
            .and_then(|d| d.get("id"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let candidates_raw = draft_value
            .get("candidates")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        #[derive(Clone)]
        struct ReplyCandidate {
            id: String,
            text: String,
            quality: f64,
        }
        let candidates: Vec<ReplyCandidate> = candidates_raw
            .iter()
            .map(|item| ReplyCandidate {
                id: item
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                text: item
                    .get("text")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                quality: item
                    .get("score")
                    .and_then(|score| score.get("quality"))
                    .and_then(serde_json::Value::as_f64)
                    .unwrap_or(0.0),
            })
            .collect();
        let mut scored: Vec<(ReplyCandidate, Vec<String>)> = candidates
            .iter()
            .map(|candidate| (candidate.clone(), slop_reasons(&candidate.text, &item.text)))
            .collect();
        scored.sort_by(|a, b| {
            b.0.quality
                .partial_cmp(&a.0.quality)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let chosen = scored
            .iter()
            .find(|(candidate, reasons)| reasons.is_empty() && candidate.quality >= cfg.min_quality)
            .cloned();

        let rejected: Vec<serde_json::Value> = scored.iter()
            .filter(|(candidate, _)| chosen.as_ref().map(|(chosen, _)| chosen.id != candidate.id).unwrap_or(true))
            .map(|(candidate, reasons)| serde_json::json!({"text": candidate.text.chars().take(160).collect::<String>(), "quality": candidate.quality, "reasons": reasons})).collect();
        record(&serde_json::json!({
            "at": now_iso(),
            "url": item.url,
            "author": item.author,
            "target": item.text.chars().take(240).collect::<String>(),
            "draftId": draft_id,
            "decision": if chosen.is_some() { "candidate_chosen" } else { "queue_for_review" },
            "chosen": chosen.as_ref().map(|(candidate, _)| serde_json::json!({"text": candidate.text, "quality": candidate.quality})),
            "rejected": rejected,
        }));

        let Some((chosen_candidate, _)) = chosen else {
            mark_seen(state, &item.url, "no_candidate_passed_screen");
            log(&format!(
                "  no candidate passed the screen ({} drafted, kept for review)",
                candidates.len()
            ));
            continue;
        };
        log(&format!(
            "  chosen q{:.0}: {}",
            chosen_candidate.quality,
            chosen_candidate.text.chars().take(90).collect::<String>()
        ));
        if cfg.dry {
            log("  dry run, not approving");
            continue;
        }
        if !cli::browser_prepare_enabled() {
            log("  browser lanes disabled, not approving");
            continue;
        }
        let Some(id) = draft_id.clone() else {
            continue;
        };
        if api
            .post_json(
                &format!("/drafts/{id}/select"),
                Some(&serde_json::json!({"candidateId": chosen_candidate.id})),
                30_000,
            )
            .await
            .is_err()
        {
            let reason = "post_failed:select failed".to_string();
            mark_seen(state, &item.url, &reason);
            record(
                &serde_json::json!({"at": now_iso(), "url": item.url, "author": item.author, "draftId": id, "decision": "error", "reason": reason}),
            );
            continue;
        }
        let approve = api.post_json(&format!("/drafts/{id}/approve"),
            Some(&serde_json::json!({"editedText": chosen_candidate.text, "screened": true, "mode": "review_required"})), 30_000).await;
        let job_id = approve.ok().and_then(|value| {
            value
                .get("job")
                .and_then(|job| job.get("id"))
                .and_then(|v| v.as_str())
                .map(str::to_string)
        });
        let Some(job_id) = job_id else {
            let reason = "post_failed:no job returned".to_string();
            mark_seen(state, &item.url, &reason);
            record(
                &serde_json::json!({"at": now_iso(), "url": item.url, "author": item.author, "draftId": id, "decision": "error", "reason": reason}),
            );
            continue;
        };
        match api
            .post_json(&format!("/jobs/{job_id}/post"), None, 420_000)
            .await
        {
            Ok(post_result) => {
                let post_url = post_result
                    .get("history")
                    .and_then(|history| history.get("postUrl"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                mark_seen(state, &item.url, "posted");
                state.authors.push(item.author.to_lowercase());
                if state.authors.len() > 20 {
                    state.authors = state.authors[state.authors.len() - 20..].to_vec();
                }
                record(
                    &serde_json::json!({"at": now_iso(), "url": item.url, "author": item.author, "target": item.text.chars().take(240).collect::<String>(), "draftId": id, "decision": "posted", "jobId": job_id, "postUrl": post_url}),
                );
                log(&format!(
                    "  POSTED {}",
                    post_result
                        .get("history")
                        .and_then(|h| h.get("postUrl"))
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("(no url)")
                ));
                posted += 1;
            }
            Err(error) => {
                let reason = format!(
                    "post_failed:{}",
                    error.chars().take(120).collect::<String>()
                );
                mark_seen(state, &item.url, &reason);
                record(
                    &serde_json::json!({"at": now_iso(), "url": item.url, "author": item.author, "draftId": id, "decision": "error", "reason": reason}),
                );
                log(&format!("  {reason}"));
                if error.contains("HTTP 429") {
                    break;
                }
            }
        }
    }
    save_state(state);
    Ok(posted as u8)
}

#[allow(dead_code)]
async fn result_err(_api: &cli::Http, _body: &serde_json::Value) -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screen_catches_dodge_and_advice() {
        let reasons = slop_reasons("Explain how this works?", "Some target text?");
        assert!(
            reasons.contains(&"prompt_dodge".to_string())
                || reasons.contains(&"advice".to_string())
        );
    }

    #[test]
    fn target_screen() {
        assert_eq!(acceptable_target("short"), Some("thin_text"));
        assert_eq!(
            acceptable_target(
                "@hi there this is long enough text about something interesting to reply to"
            ),
            Some("reply_shaped")
        );
        assert_eq!(
            acceptable_target(
                "This is a long enough post about queues and latency that should count as a target for a reply."
            ),
            None
        );
    }

    #[test]
    fn retry_hours_expiry() {
        let mut state = State::default();
        let past = (chrono::Utc::now() - chrono::Duration::hours(7))
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        state.seen.insert(
            "https://x.com/a/status/1".to_string(),
            (past, "draft_failed:boom".to_string()),
        );
        assert!(!is_seen(&state, "https://x.com/a/status/1", 6 * 3_600_000));
        state.seen.insert(
            "https://x.com/a/status/2".to_string(),
            (now_iso(), "posted".to_string()),
        );
        assert!(is_seen(&state, "https://x.com/a/status/2", 6 * 3_600_000));
    }
}
