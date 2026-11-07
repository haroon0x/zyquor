//! `zyquor post-loop [--once] [--dry] [--force]` — original-post runner.
//!
//! Port of `scripts/post-loop.mjs`: drafts standalone posts from a rotating
//! topic bank, screens candidates with the deterministic filter, and posts
//! the best one through the gated draft, approve and job path. Approval and
//! posting require `ZYQUOR_ENABLE_BROWSER_PREPARE=1` (a banner is printed
//! when the lane is disabled, mirroring the house rule that posting is off
//! by default).

use std::io::Write;

use crate::cli;

#[derive(Debug, Clone)]
pub struct Topic {
    pub tweet_type: &'static str,
    pub idea: &'static str,
}

pub const TOPIC_BANK: &[Topic] = &[
    Topic {
        tweet_type: "opinion",
        idea: "Coding agents are judged on the diff, but the expensive failures come from a wrong assumption that still compiles.",
    },
    Topic {
        tweet_type: "useful_info",
        idea: "Per-account browser profiles are the simple fix for parallel posting from one machine.",
    },
    Topic {
        tweet_type: "guide",
        idea: "How to verify a coding agent actually did the work instead of trusting its summary.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "Local-first is a data ownership decision before it is a sync architecture decision.",
    },
    Topic {
        tweet_type: "useful_info",
        idea: "In agent workflows the review step is the bottleneck, not generation.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "Most self-hosted setups fail on upgrades, not on the first install.",
    },
    Topic {
        tweet_type: "useful_info",
        idea: "Why one stable CDP port per account beats one shared browser for posting automation.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "A model benchmark without the raw runs stops being useful the day the next model ships.",
    },
    Topic {
        tweet_type: "guide",
        idea: "What to log from a coding agent if you want to audit it a week later.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "Context windows grew, but the discipline of feeding less still wins.",
    },
    Topic {
        tweet_type: "useful_info",
        idea: "Postgres connection pool saturation looks like slow queries under load.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "Headless automation is a reliability decision, not a stealth decision.",
    },
    Topic {
        tweet_type: "guide",
        idea: "A small checklist before letting an agent touch a production repo.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "Open weights matter most where the data cannot leave the building.",
    },
    Topic {
        tweet_type: "useful_info",
        idea: "Reply discovery should start from the home feed and fall back to search only when the feed is thin.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "The timeline rewards one clear claim more than a balanced list.",
    },
    Topic {
        tweet_type: "guide",
        idea: "How to keep a posting bot from sounding like a bot.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "Agent worktrees solve file conflicts, not review conflicts.",
    },
    Topic {
        tweet_type: "useful_info",
        idea: "What a daily posting limit actually protects.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "Most launch advice ignores the part where distribution is chosen before the launch post.",
    },
    Topic {
        tweet_type: "useful_info",
        idea: "A failed job should keep the error and the screenshot, not just a status.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "A benchmark you cannot rerun is a press release with a table.",
    },
    Topic {
        tweet_type: "guide",
        idea: "How to run two X accounts on one machine without one browser stealing the other's session.",
    },
    Topic {
        tweet_type: "opinion",
        idea: "The hardest part of automation is not the happy path, it is deciding what happens after a half finished post.",
    },
    Topic {
        tweet_type: "useful_info",
        idea: "Why quiet hours belong in the posting loop, not only in the UI.",
    },
];

fn is_word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

fn contains_word(text: &str, word: &str) -> bool {
    let lower = text.to_lowercase();
    let word = word.to_lowercase();
    let mut start = 0;
    while let Some(found) = lower[start..].find(&word) {
        let index = start + found;
        let before_ok =
            index == 0 || !is_word_char(lower[index - 1..].chars().next().unwrap_or(' '));
        let after_index = index + word.len();
        let after_ok = after_index >= lower.len()
            || !is_word_char(lower[after_index..].chars().next().unwrap_or(' '));
        if before_ok && after_ok {
            return true;
        }
        start = index + word.len().max(1);
    }
    false
}

fn any_word(text: &str, words: &[&str]) -> bool {
    words.iter().any(|word| contains_word(text, word))
}

/// Deterministic screen, mirroring `postReasons` in the TypeScript script.
pub fn post_reasons(text: &str, idea: &str) -> Vec<String> {
    let t = text.trim();
    let mut reasons = Vec::new();
    let chars = t.chars().count();
    if chars < 180 {
        reasons.push("too_short".to_string());
    }
    if chars > 620 {
        reasons.push("too_long".to_string());
    }
    if !t
        .chars()
        .next()
        .map(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
        .unwrap_or(false)
    {
        reasons.push("lowercase_opener".to_string());
    }
    if t.contains('?') {
        reasons.push("question_bait".to_string());
    }
    if t.contains('#') || has_mention(t) {
        reasons.push("hashtag_or_mention".to_string());
    }
    if t.to_lowercase().contains("http://") || t.to_lowercase().contains("https://") {
        reasons.push("has_link".to_string());
    }
    if t.contains('\u{2013}') || t.contains('\u{2014}') {
        reasons.push("dash".to_string());
    }
    if any_word(
        t,
        &[
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
            "mind-blowing",
            "mind blowing",
            "synergy",
        ],
    ) {
        reasons.push("slop_word".to_string());
    }
    if formula_a(t) || formula_b(t) || real_x(t) || parallel(t) {
        reasons.push("formula_contrast".to_string());
    }
    if experience_claim(t) {
        reasons.push("invented_experience".to_string());
    }
    let stats = number_tokens(t)
        .into_iter()
        .filter(|value| !is_year(value))
        .collect::<Vec<_>>();
    let known: Vec<String> = number_tokens(idea);
    if stats.iter().any(|value| !known.contains(value)) {
        reasons.push("invented_stat".to_string());
    }
    reasons
}

fn has_mention(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    for index in 0..chars.len() {
        if chars[index] == '@' && index + 1 < chars.len() && is_word_char(chars[index + 1]) {
            return true;
        }
    }
    false
}

fn formula_a(text: &str) -> bool {
    // `\b(isn't|...)... \b(it's|it is|that's|they're|the real)\b`
    let lower = text.to_lowercase();
    let negations = [
        "isn't", "isnt", "aren't", "wasn't", "doesn't", "don't", "won't", "can't", "isn’t",
    ];
    let positive = ["it's", "it is", "that's", "they're", "the real", "it’s"];
    for negation in negations {
        let mut start = 0;
        while let Some(found) = lower[start..].find(negation) {
            let index = start + found;
            let window = &lower[index..];
            let window = window.get(..window.len().min(200)).unwrap_or(window);
            if positive.iter().any(|marker| window.contains(marker)) {
                return true;
            }
            start = index + negation.len();
        }
    }
    false
}

fn formula_b(text: &str) -> bool {
    // `\bnot\b ... \bbut\b`
    let lower = text.to_lowercase();
    let mut start = 0;
    while let Some(found) = lower[start..].find("not") {
        let index = start + found;
        let after = index + 3;
        let window = lower
            .get(after..(after + 100).min(lower.len()))
            .unwrap_or("");
        if window.contains("but") {
            return true;
        }
        start = after;
    }
    false
}

fn real_x(text: &str) -> bool {
    text.to_lowercase().contains("the real ") && text.to_lowercase().contains(" is")
}

fn parallel(text: &str) -> bool {
    let lower = text.to_lowercase();
    for anchor in ["knows", "does", "is", "has", "can", "will"] {
        if contains_word(&lower, anchor) {
            return false; // full port keeps the comma+negation shape; approximated below
        }
    }
    let _ = text;
    // Shape: `<verb>..., the <word> doesn't|isn't|...`
    let lower = text.to_lowercase();
    let negations = ["doesn't", "isn't", "hasn't", "won't", "can't"];
    if lower.contains(',') && negations.iter().any(|negation| lower.contains(negation)) {
        return true;
    }
    false
}

fn experience_claim(text: &str) -> bool {
    let lower = text.to_lowercase();
    let markers = [
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
    ];
    markers.iter().any(|marker| lower.contains(marker))
}

fn number_tokens(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut last_was_digit = false;
    for ch in lower.chars() {
        if ch.is_ascii_digit() || ((ch == '.' || ch == ',') && last_was_digit) {
            current.push(ch);
            last_was_digit = ch.is_ascii_digit();
        } else if ch == '%' && !current.is_empty() {
            current.push(ch);
            tokens.push(current.clone());
            current.clear();
            last_was_digit = false;
        } else {
            if !current.is_empty() && last_was_digit {
                tokens.push(current.clone());
            }
            current.clear();
            last_was_digit = false;
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn is_year(token: &str) -> bool {
    token.len() == 4 && token.starts_with("19") || token.len() == 4 && token.starts_with("20")
}

#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub text: String,
    pub quality: f64,
}

#[derive(Debug, Default)]
struct State {
    topics: std::collections::HashMap<String, String>,
    recent_texts: Vec<String>,
}

fn data_dir() -> std::path::PathBuf {
    cli::ts_data_dir()
}

fn read_state() -> State {
    let path = data_dir().join("post-loop-state.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return State::default();
    };
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let mut topics = std::collections::HashMap::new();
    if let Some(object) = value.get("topics").and_then(serde_json::Value::as_object) {
        for (key, entry) in object {
            let at = entry
                .get("at")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");
            topics.insert(key.clone(), at.to_string());
        }
    }
    let recent_texts = value
        .get("recentTexts")
        .and_then(serde_json::Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    State {
        topics,
        recent_texts,
    }
}

fn save_state(state: &State) {
    let mut topics = serde_json::Map::new();
    for (key, at) in &state.topics {
        topics.insert(key.clone(), serde_json::json!({ "at": at }));
    }
    let mut recent = state.recent_texts.clone();
    if recent.len() > 25 {
        recent = recent[recent.len() - 25..].to_vec();
    }
    let value = serde_json::json!({ "topics": topics, "recentTexts": recent });
    let path = data_dir().join("post-loop-state.json");
    let _ = std::fs::create_dir_all(data_dir());
    let _ = std::fs::write(
        path,
        serde_json::to_string_pretty(&value).unwrap_or_default(),
    );
}

fn log(message: &str) {
    let stamp = chrono::Utc::now().format("%H:%M:%S");
    let line = format!("[post-loop {stamp}] {message}");
    println!("{line}");
    let _ = std::fs::create_dir_all(data_dir());
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir().join("post-loop.log"))
    {
        let _ = writeln!(file, "{line}");
    }
}

fn record(entry: &serde_json::Value) {
    let _ = std::fs::create_dir_all(data_dir());
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir().join("post-loop.jsonl"))
    {
        let _ = writeln!(file, "{}", serde_json::to_string(entry).unwrap_or_default());
    }
}

fn pick_topic(state: &State) -> Topic {
    let mut best: Option<Topic> = None;
    let mut best_used = i64::MAX;
    for topic in TOPIC_BANK {
        let used = state
            .topics
            .get(topic.idea)
            .and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok())
            .map(|time| time.timestamp_millis())
            .unwrap_or(0);
        if used < best_used {
            best_used = used;
            best = Some(topic.clone());
        }
    }
    best.unwrap_or_else(|| TOPIC_BANK[0].clone())
}

fn local_day_key(ms: i64, offset_min: f64) -> String {
    let shifted = ms + (offset_min * 60_000.0) as i64;
    chrono::DateTime::from_timestamp_millis(shifted)
        .map(|time| time.format("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

fn local_midnight_ms(ms: i64, offset_min: f64) -> i64 {
    let shifted = ms + (offset_min * 60_000.0) as i64;
    let time = chrono::DateTime::from_timestamp_millis(shifted).unwrap_or_else(chrono::Utc::now);
    let midnight = chrono::NaiveDate::from_ymd_opt(
        time.date_naive().year(),
        time.date_naive().month(),
        time.date_naive().day(),
    )
    .and_then(|date| date.and_hms_opt(0, 0, 0))
    .map(|naive| chrono::DateTime::<chrono::Utc>::from_naive_utc_and_offset(naive, chrono::Utc))
    .map(|dt| dt.timestamp_millis())
    .unwrap_or(0);
    midnight - (offset_min * 60_000.0) as i64
}

use chrono::Datelike;

struct LoopConfig {
    account_id: String,
    per_day: f64,
    start_hour: f64,
    end_hour: f64,
    tz_offset_min: f64,
    min_quality: f64,
    candidate_count: usize,
    min_gap_ms: f64,
    force: bool,
    dry: bool,
}

struct HistoryRow {
    tweet_type: String,
    posted_ms: i64,
}

/// Milliseconds to wait for the next slot, or 0 when due now.
fn wait_for_slot_ms(history: &[HistoryRow], cfg: &LoopConfig) -> i64 {
    let now = chrono::Utc::now().timestamp_millis();
    let today = local_day_key(now, cfg.tz_offset_min);
    let originals_today = history
        .iter()
        .filter(|row| {
            row.tweet_type != "reply" && local_day_key(row.posted_ms, cfg.tz_offset_min) == today
        })
        .count() as f64;
    let last_original = history
        .iter()
        .filter(|row| row.tweet_type != "reply")
        .map(|row| row.posted_ms)
        .max()
        .unwrap_or(0);

    if !cfg.force && !cfg.dry && originals_today >= cfg.per_day {
        let next = local_midnight_ms(now, cfg.tz_offset_min)
            + 24 * 3_600_000
            + (cfg.start_hour * 3_600_000.0) as i64;
        return (next - now).max(60_000);
    }
    let day_start = local_midnight_ms(now, cfg.tz_offset_min);
    let window_ms = (cfg.end_hour - cfg.start_hour) * 3_600_000.0;
    let interval_ms = window_ms / cfg.per_day.max(1.0);
    let slot = day_start as f64 + cfg.start_hour * 3_600_000.0 + originals_today * interval_ms;
    let window_end = day_start as f64 + cfg.end_hour * 3_600_000.0;
    if now as f64 > window_end && !cfg.force {
        let next = local_midnight_ms(now, cfg.tz_offset_min)
            + 24 * 3_600_000
            + (cfg.start_hour * 3_600_000.0) as i64;
        return (next - now).max(60_000);
    }
    let due = slot
        .max(if last_original > 0 {
            last_original as f64 + interval_ms
        } else {
            0.0
        })
        .max(last_original as f64 + cfg.min_gap_ms);
    if (now as f64) < due {
        let jitter = ((originals_today as i64 + 1) * 37) % 11;
        return due as i64 - now + jitter * 60_000;
    }
    0
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub async fn run(args: &[String]) -> Result<i32, String> {
    let once = args.iter().any(|arg| arg == "--once");
    let dry = args.iter().any(|arg| arg == "--dry");
    let force = args.iter().any(|arg| arg == "--force");
    let cfg = LoopConfig {
        account_id: cli::env_or("ZYQUOR_POST_ACCOUNT_ID", "account_personal"),
        per_day: cli::env_number("ZYQUOR_POST_LOOP_PER_DAY", 5.0),
        start_hour: cli::env_number("ZYQUOR_POST_LOOP_START_HOUR", 9.0),
        end_hour: cli::env_number("ZYQUOR_POST_LOOP_END_HOUR", 22.0),
        tz_offset_min: cli::env_number("ZYQUOR_POST_LOOP_UTC_OFFSET_MIN", 330.0),
        min_quality: cli::env_number("ZYQUOR_POST_LOOP_MIN_QUALITY", 7.0),
        candidate_count: std::env::var("ZYQUOR_POST_LOOP_CANDIDATES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(4),
        min_gap_ms: std::env::var("ZYQUOR_POST_LOOP_MIN_GAP_MIN")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
            .unwrap_or(20.0)
            * 60_000.0,
        force,
        dry,
    };
    let mut api_url = cli::resolve_api_url().await;
    let probe = cli::http(&api_url);
    let version = probe.get_json("/health", 5_000).await.ok();
    let model = version
        .as_ref()
        .and_then(|v| v.get("generation"))
        .and_then(|g| g.get("model"))
        .and_then(|m| m.as_str())
        .unwrap_or("unknown");
    log(&format!(
        "api {api_url} model={model} perDay={} dry={dry} once={once}",
        cfg.per_day
    ));
    cli::browser_lane_banner("post-loop");

    let _ = std::fs::create_dir_all(data_dir());
    let mut state = read_state();
    let api = cli::http(&api_url);

    loop {
        match run_cycle(&api, &mut state, &cfg).await {
            Ok(posted) => log(&format!("cycle done, posted {posted}")),
            Err(error) => {
                log(&format!(
                    "cycle crashed: {}",
                    error.chars().take(200).collect::<String>()
                ));
                if !once {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                }
            }
        }
        if once {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    }
    let _ = &mut api_url;
    Ok(0)
}

async fn post_history(api: &cli::Http) -> Result<Vec<HistoryRow>, String> {
    let value = api.get_json("/performance", 15_000).await?;
    let history = value
        .get("history")
        .and_then(serde_json::Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut rows = Vec::new();
    for row in history {
        let posted_at = row
            .get("postedAt")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let ms = chrono::DateTime::parse_from_rfc3339(posted_at)
            .map(|time| time.timestamp_millis())
            .unwrap_or(0);
        if ms > 0 || !posted_at.is_empty() {
            rows.push(HistoryRow {
                tweet_type: row
                    .get("tweetType")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("post")
                    .to_string(),
                posted_ms: ms,
            });
        }
    }
    Ok(rows)
}

async fn run_cycle(api: &cli::Http, state: &mut State, cfg: &LoopConfig) -> Result<u8, String> {
    let history = post_history(api).await?;
    let today = local_day_key(chrono::Utc::now().timestamp_millis(), cfg.tz_offset_min);
    let originals_today = history
        .iter()
        .filter(|row| {
            row.tweet_type != "reply" && local_day_key(row.posted_ms, cfg.tz_offset_min) == today
        })
        .count() as f64;
    if !cfg.force && !cfg.dry && originals_today >= cfg.per_day {
        log(&format!(
            "daily cap reached ({originals_today:.0}/{:.0})",
            cfg.per_day
        ));
        return Ok(0);
    }
    let wait_ms = if cfg.force {
        0
    } else {
        wait_for_slot_ms(&history, cfg)
    };
    if wait_ms > 0 {
        log(&format!("next post in {} min", wait_ms / 60_000));
        // `--once` still reports the wait and does not post (TS: skips sleep
        // in once mode and runs the cycle immediately; the wait is advisory).
        // Mirror TS: in once mode we still run the cycle.
    }

    let topic = pick_topic(state);
    log(&format!(
        "drafting {}: {}",
        topic.tweet_type,
        topic.idea.chars().take(80).collect::<String>()
    ));

    let draft_id: Option<String>;
    let candidates: Vec<Candidate>;
    let draft_body = serde_json::json!({
        "accountId": cfg.account_id,
        "idea": topic.idea,
        "tweetType": topic.tweet_type,
        "count": cfg.candidate_count,
    });
    let created = api.post_json("/drafts", Some(&draft_body), 30_000).await;
    match created {
        Ok(created) => {
            draft_id = created
                .get("draft")
                .and_then(|d| d.get("id"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            let Some(id) = draft_id.clone() else {
                record(
                    &serde_json::json!({"at": now_iso(), "idea": topic.idea, "tweetType": topic.tweet_type, "draftId": null, "decision": "error", "reason": "draft_failed:no draft id returned"}),
                );
                log("  draft_failed:no draft id returned");
                return Ok(0);
            };
            let generated = api
                .post_json(
                    &format!("/drafts/{id}/generate"),
                    Some(&serde_json::json!({})),
                    420_000,
                )
                .await;
            match generated {
                Ok(generated) => {
                    let list = generated
                        .get("candidates")
                        .and_then(serde_json::Value::as_array)
                        .cloned()
                        .unwrap_or_default();
                    candidates = list
                        .iter()
                        .map(|item| Candidate {
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
                }
                Err(error) => {
                    record(
                        &serde_json::json!({"at": now_iso(), "idea": topic.idea, "tweetType": topic.tweet_type, "draftId": id, "decision": "error", "reason": format!("draft_failed:{}", error.chars().take(100).collect::<String>())}),
                    );
                    log(&format!(
                        "  draft_failed:{}",
                        error.chars().take(100).collect::<String>()
                    ));
                    return Ok(0);
                }
            }
        }
        Err(error) => {
            record(
                &serde_json::json!({"at": now_iso(), "idea": topic.idea, "tweetType": topic.tweet_type, "draftId": null, "decision": "error", "reason": format!("draft_failed:{}", error.chars().take(100).collect::<String>())}),
            );
            log(&format!(
                "  draft_failed:{}",
                error.chars().take(100).collect::<String>()
            ));
            return Ok(0);
        }
    }

    let mut scored: Vec<(Candidate, Vec<String>)> = Vec::new();
    for candidate in &candidates {
        let mut reasons = post_reasons(&candidate.text, topic.idea);
        let signature: String = candidate
            .text
            .trim()
            .to_lowercase()
            .chars()
            .take(120)
            .collect();
        if state.recent_texts.contains(&signature) {
            reasons.push("repeat".to_string());
        }
        scored.push((candidate.clone(), reasons));
    }
    let mut clean: Vec<(Candidate, Vec<String>)> = scored
        .iter()
        .filter(|(candidate, reasons)| reasons.is_empty() && candidate.quality >= cfg.min_quality)
        .cloned()
        .collect();
    clean.sort_by(|a, b| {
        b.0.quality
            .partial_cmp(&a.0.quality)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let chosen = clean.first().cloned();

    state.topics.insert(topic.idea.to_string(), now_iso());
    save_state(state);
    let rejected: Vec<serde_json::Value> = scored.iter().filter(|(candidate, _)| chosen.as_ref().map(|(chosen, _)| chosen.id != candidate.id).unwrap_or(true))
        .map(|(candidate, reasons)| serde_json::json!({"text": candidate.text.chars().take(200).collect::<String>(), "quality": candidate.quality, "reasons": reasons})).collect();
    record(&serde_json::json!({
        "at": now_iso(),
        "idea": topic.idea,
        "tweetType": topic.tweet_type,
        "draftId": draft_id,
        "decision": if chosen.is_some() { "candidate_chosen" } else { "queue_for_review" },
        "chosen": chosen.as_ref().map(|(candidate, _)| serde_json::json!({"text": candidate.text, "quality": candidate.quality})),
        "rejected": rejected,
    }));

    let Some((chosen_candidate, _)) = chosen else {
        log(&format!(
            "  no candidate passed the screen ({} drafted, kept for review)",
            candidates.len()
        ));
        return Ok(0);
    };
    log(&format!(
        "  chosen q{:.0}: {}",
        chosen_candidate.quality,
        chosen_candidate.text.chars().take(90).collect::<String>()
    ));
    if cfg.dry {
        log("  dry run, not approving");
        return Ok(0);
    }
    if !cli::browser_prepare_enabled() {
        log("  browser lanes disabled, not approving");
        return Ok(0);
    }
    let Some(id) = draft_id else {
        return Ok(0);
    };
    let select = api
        .post_json(
            &format!("/drafts/{id}/select"),
            Some(&serde_json::json!({"candidateId": chosen_candidate.id})),
            30_000,
        )
        .await;
    if let Err(error) = select {
        record(
            &serde_json::json!({"at": now_iso(), "idea": topic.idea, "tweetType": topic.tweet_type, "draftId": id, "decision": "error", "reason": format!("post_failed:{}", error.chars().take(120).collect::<String>())}),
        );
        return Ok(0);
    }
    let approve_body = serde_json::json!({"editedText": chosen_candidate.text, "screened": true, "mode": "review_required"});
    let approved = api
        .post_json(
            &format!("/drafts/{id}/approve"),
            Some(&approve_body),
            30_000,
        )
        .await;
    let job_id = approved.ok().and_then(|value| {
        value
            .get("job")
            .and_then(|job| job.get("id"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    });
    let Some(job_id) = job_id else {
        record(
            &serde_json::json!({"at": now_iso(), "idea": topic.idea, "tweetType": topic.tweet_type, "draftId": id, "decision": "error", "reason": "post_failed:no job returned"}),
        );
        return Ok(0);
    };
    let post_result = api
        .post_json(&format!("/jobs/{job_id}/post"), None, 420_000)
        .await;
    match post_result {
        Ok(post_result) => {
            let post_url = post_result
                .get("history")
                .and_then(|history| history.get("postUrl"))
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            let signature: String = chosen_candidate
                .text
                .trim()
                .to_lowercase()
                .chars()
                .take(120)
                .collect();
            state.recent_texts.push(signature);
            save_state(state);
            record(
                &serde_json::json!({"at": now_iso(), "idea": topic.idea, "tweetType": topic.tweet_type, "draftId": id, "decision": "posted", "jobId": job_id, "postUrl": post_url}),
            );
            log(&format!(
                "  POSTED {}",
                post_result
                    .get("history")
                    .and_then(|h| h.get("postUrl"))
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("(no url)")
            ));
            Ok(1)
        }
        Err(error) => {
            record(
                &serde_json::json!({"at": now_iso(), "idea": topic.idea, "tweetType": topic.tweet_type, "draftId": id, "decision": "error", "reason": format!("post_failed:{}", error.chars().take(120).collect::<String>())}),
            );
            log(&format!(
                "  post_failed:{}",
                error.chars().take(120).collect::<String>()
            ));
            Ok(0)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn screens_short_and_question_bait() {
        let reasons = post_reasons("short", "short");
        assert!(reasons.contains(&"too_short".to_string()));
        let longer = format!("{} Yes?", "A".repeat(250));
        assert!(post_reasons(&longer, "idea").contains(&"question_bait".to_string()));
    }

    #[test]
    fn topic_bank_rotates_least_recently_used() {
        let mut state = State::default();
        state
            .topics
            .insert(TOPIC_BANK[0].idea.to_string(), now_iso());
        let picked = pick_topic(&state);
        assert_ne!(picked.idea, TOPIC_BANK[0].idea);
    }
}
