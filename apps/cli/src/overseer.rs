//! `zyquor overseer [--once] [--dry] [--interval-ms <n>]` — slop auditor.
//!
//! Port of `scripts/overseer.mjs`: reads the queue straight from SQLite with
//! `zyquor_storage::SqliteRepository` (sync) and deletes sloppy material
//! through the HTTP API. Never auto-posts; the posted audit is gated behind
//! `ZYQUOR_ENABLE_BROWSER_POST=1`, exactly as in TypeScript.

use std::io::Write;

use crate::cli;
use zyquor_generation::{
    is_clean_tweet_text, is_interrogation_dodge_reply, quality_minimum, reply_quality_minimum,
    score_tweet_quality,
};
use zyquor_storage::SqliteRepository;

fn env_lookup(key: &str) -> Option<String> {
    std::env::var(key).ok()
}

fn log_path() -> std::path::PathBuf {
    cli::ts_data_dir().join("overseer.jsonl")
}

fn log_record(record: &serde_json::Value) {
    let path = log_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(
            file,
            "{}",
            serde_json::to_string(record).unwrap_or_default()
        );
    }
}

fn database_path() -> std::path::PathBuf {
    let preferred = cli::repo_root()
        .join("apps")
        .join("api")
        .join("data")
        .join("app.sqlite");
    if preferred.is_file() {
        return preferred;
    }
    let data_root = std::env::var("ZYQUOR_DATA_ROOT")
        .ok()
        .filter(|v| !v.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    data_root.join("data").join("app.sqlite")
}

fn flat(text: &str) -> String {
    text.to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Hard slop reasons, mirroring `hardSlopReasons`.
pub fn hard_slop_reasons(text: &str) -> Vec<String> {
    let value = text.trim();
    if value.is_empty() {
        return vec!["empty_text".to_string()];
    }
    let mut reasons = Vec::new();
    let flat_value = flat(value);
    for phrase in zyquor_core::AI_SLOP_PHRASES {
        if flat_value.contains(&phrase.to_lowercase()) {
            reasons.push(format!("slop_phrase:{phrase}"));
            break;
        }
    }
    if value.contains('\u{2014}') || value.contains('\u{2013}') {
        reasons.push("em_or_en_dash".to_string());
    }
    if invented_point_number(value) {
        reasons.push("invented_point_number".to_string());
    }
    if value.starts_with('#') || value.starts_with('@') {
        reasons.push("hashtag_or_mention_opener".to_string());
    }
    let links = value.matches("http://").count() + value.matches("https://").count();
    if links >= 2 {
        reasons.push("link_list".to_string());
    }
    reasons
}

pub fn invented_point_number(text: &str) -> bool {
    // `\bPoint [2-9]\b`
    let bytes = text.as_bytes();
    for index in 0..bytes.len() {
        if bytes[index] == b'P' && text[index..].starts_with("Point") {
            let rest = text[index + 5..].strip_prefix(' ').unwrap_or("");
            if rest.starts_with(['2', '3', '4', '5', '6', '7', '8', '9']) {
                let after = &rest[1..];
                match after.chars().next() {
                    None => return true,
                    Some(c) if !c.is_ascii_alphanumeric() => return true,
                    _ => {}
                }
            }
        }
    }
    false
}

fn queued_reasons(text: &str, is_reply: bool) -> Vec<String> {
    let mut reasons = hard_slop_reasons(text);
    let value = text.trim();
    let floor = if is_reply {
        reply_quality_minimum(&env_lookup)
    } else {
        quality_minimum(&env_lookup)
    };
    let score = score_tweet_quality(value);
    if (score as f64) < floor {
        reasons.push(format!("quality_below_floor ({score} < {floor})"));
    }
    if !is_clean_tweet_text(value) {
        reasons.push("unclean_text".to_string());
    }
    if is_reply && is_interrogation_dodge_reply(value) {
        reasons.push(zyquor_generation::REPLY_DODGE_REASON.to_string());
    }
    reasons
}

fn posted_reasons(text: &str, is_reply: bool) -> Vec<String> {
    let hard = hard_slop_reasons(text);
    if !hard.is_empty() {
        return hard;
    }
    if is_reply {
        let floor = reply_quality_minimum(&env_lookup);
        let score = score_tweet_quality(text.trim());
        if (score as f64) < floor {
            return vec![format!("reply_quality_below_floor ({score} < {floor})")];
        }
    }
    Vec::new()
}

struct DraftInfo {
    is_reply: bool,
    status: String,
}

fn draft_info(repository: &SqliteRepository, draft_id: &str) -> Option<DraftInfo> {
    let draft = repository.get_draft(draft_id).ok().flatten()?;
    let tweet_type = draft
        .draft
        .metadata
        .get("tweetType")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let is_reply = draft.draft.reply_to.is_some()
        || draft.draft.reply_to_url.is_some()
        || tweet_type == "reply";
    Some(DraftInfo {
        is_reply,
        status: draft.draft.status.as_str().to_string(),
    })
}

fn best_candidate_text(repository: &SqliteRepository, draft_id: &str) -> Option<(String, f64)> {
    let draft = repository.get_draft(draft_id).ok().flatten()?;
    if draft.candidates.is_empty() {
        return None;
    }
    if let Some(selected) = draft.candidates.iter().find(|candidate| candidate.selected) {
        let quality = selected
            .score
            .get("quality")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        return Some((selected.text.clone(), quality));
    }
    let best = draft.candidates.iter().max_by(|a, b| {
        let qa = a
            .score
            .get("quality")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        let qb = b
            .score
            .get("quality")
            .and_then(serde_json::Value::as_f64)
            .unwrap_or(0.0);
        qa.partial_cmp(&qb).unwrap_or(std::cmp::Ordering::Equal)
    })?;
    let quality = best
        .score
        .get("quality")
        .and_then(serde_json::Value::as_f64)
        .unwrap_or(0.0);
    Some((best.text.clone(), quality))
}

pub async fn run(args: &[String]) -> Result<i32, String> {
    let api_url = cli::env_or("ZYQUOR_API_URL", "http://127.0.0.1:3001");
    let mut interval_ms: u64 = 300_000;
    let mut index = 0;
    while index < args.len() {
        if args[index] == "--interval-ms" && index + 1 < args.len() {
            interval_ms = args[index + 1].parse().unwrap_or(300_000);
            index += 2;
        } else {
            index += 1;
        }
    }
    let dry_run = args.iter().any(|arg| arg == "--dry");
    let once = args.iter().any(|arg| arg == "--once");
    let max_job_deletes = 3_usize;
    let max_post_deletes = 2_usize;

    let path = database_path();
    let repository = match SqliteRepository::open(&path) {
        Ok(repository) => repository,
        Err(error) => {
            eprintln!("Cannot open database at {}: {error}", path.display());
            return Ok(1);
        }
    };
    let api = cli::http(&api_url);

    if once {
        let _ = run_cycle(
            &repository,
            &api,
            dry_run,
            max_job_deletes,
            max_post_deletes,
        )
        .await;
        return Ok(0);
    }

    loop {
        let _ = run_cycle(
            &repository,
            &api,
            dry_run,
            max_job_deletes,
            max_post_deletes,
        )
        .await;
        tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
    }
}

async fn run_cycle(
    repository: &SqliteRepository,
    api: &cli::Http,
    dry_run: bool,
    max_job_deletes: usize,
    max_post_deletes: usize,
) -> (usize, usize) {
    match api.get_json("/health", 10_000).await {
        Ok(_) => {}
        Err(error) => {
            log_record(
                &serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "skip_cycle", "reason": "api_unreachable", "error": error}),
            );
            return (0_usize, 0_usize);
        }
    }

    // auditQueue
    let mut queue_deleted = 0_usize;
    if let Ok(jobs_value) = api
        .get_json("/jobs?statuses=approved,prepared&limit=500", 30_000)
        .await
    {
        let jobs = jobs_value
            .get("jobs")
            .and_then(serde_json::Value::as_array)
            .cloned()
            .unwrap_or_default();
        for job in &jobs {
            if queue_deleted >= max_job_deletes {
                break;
            }
            let job_id = job
                .get("id")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
            let draft_id = job
                .get("draftId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
            if job_id.is_empty() || draft_id.is_empty() {
                continue;
            }
            let Some(info) = draft_info(repository, &draft_id) else {
                continue;
            };
            let posted = repository
                .count_post_history_by_draft_id(&draft_id)
                .unwrap_or(0)
                > 0;
            if posted {
                continue;
            }
            let Some((text, _quality)) = best_candidate_text(repository, &draft_id) else {
                continue;
            };
            let reasons = queued_reasons(&text, info.is_reply);
            if reasons.is_empty() {
                continue;
            }
            let mode = job
                .get("mode")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .to_string();
            let truncated: String = text.chars().take(140).collect();
            let record = serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "delete_job", "jobId": job_id, "draftId": draft_id, "mode": mode, "isReply": info.is_reply, "reasons": reasons, "text": truncated});
            if dry_run {
                let mut with_dry = record;
                let mut object = with_dry.as_object().cloned().unwrap_or_default();
                object.insert("dryRun".into(), true.into());
                with_dry = serde_json::Value::Object(object);
                log_record(&with_dry);
                queue_deleted += 1;
                continue;
            }
            #[allow(clippy::redundant_clone)]
            let record_for_log = record.clone();
            match api.delete_json(&format!("/jobs/{job_id}"), 30_000).await {
                Ok(_) => {
                    log_record(&record_for_log);
                    if info.status == "approved" {
                        let _ = api
                            .delete_json(&format!("/drafts/{draft_id}"), 30_000)
                            .await;
                        log_record(
                            &serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "delete_draft", "draftId": draft_id, "reason": "sloppy_approved_draft_after_job_delete", "reasons": reasons}),
                        );
                    }
                    queue_deleted += 1;
                }
                Err(error) => {
                    log_record(
                        &serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "delete_job_failed", "jobId": job_id, "error": error}),
                    );
                }
            }
        }
    }

    // auditReviewQueue
    let drafts = repository.list_drafts(None).unwrap_or_default();
    for draft in drafts {
        if queue_deleted >= max_job_deletes {
            break;
        }
        if draft.status.as_str() != "selected" {
            continue;
        }
        let jobs = repository
            .list_jobs_by_draft_id(&draft.id)
            .unwrap_or_default();
        if !jobs.is_empty() {
            continue;
        }
        if repository
            .count_post_history_by_draft_id(&draft.id)
            .unwrap_or(0)
            > 0
        {
            continue;
        }
        let Some(info) = draft_info(repository, &draft.id) else {
            continue;
        };
        let Some((text, quality)) = best_candidate_text(repository, &draft.id) else {
            continue;
        };
        let mut reasons = hard_slop_reasons(&text);
        if info.is_reply && quality < reply_quality_minimum(&env_lookup) {
            reasons.push(format!(
                "reply_best_quality_below_floor ({quality} < {})",
                reply_quality_minimum(&env_lookup)
            ));
        } else if !info.is_reply && quality <= 3.0 {
            let has_packet = draft.metadata.get("sourcePacketId").is_some();
            if has_packet {
                reasons.push("machine_draft_quality_below_floor (<= 3)".to_string());
            }
        }
        if reasons.is_empty() {
            continue;
        }
        let truncated: String = text.chars().take(140).collect();
        let record = serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "delete_draft", "draftId": draft.id, "isReply": info.is_reply, "quality": quality, "reasons": reasons, "text": truncated});
        if dry_run {
            let mut object = record.as_object().cloned().unwrap_or_default();
            object.insert("dryRun".into(), true.into());
            log_record(&serde_json::Value::Object(object));
            queue_deleted += 1;
            continue;
        }
        match api
            .delete_json(&format!("/drafts/{}", draft.id), 30_000)
            .await
        {
            Ok(_) => {
                log_record(&record);
                queue_deleted += 1;
            }
            Err(error) => {
                log_record(
                    &serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "delete_draft_failed", "draftId": draft.id, "error": error}),
                );
            }
        }
    }

    // auditPosted
    let mut posted_deleted = 0_usize;
    if cli::env_flag("ZYQUOR_ENABLE_BROWSER_POST") {
        if let Ok(history_value) = api.get_json("/history", 30_000).await {
            let history = history_value
                .get("history")
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default();
            let now_ms = chrono::Utc::now().timestamp_millis();
            for row in &history {
                if posted_deleted >= max_post_deletes {
                    break;
                }
                let posted_at = row
                    .get("postedAt")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let posted_ms = chrono::DateTime::parse_from_rfc3339(posted_at)
                    .map(|time| time.timestamp_millis())
                    .unwrap_or(0);
                if posted_at.is_empty() || now_ms - posted_ms >= 24 * 60 * 60 * 1000 {
                    continue;
                }
                let metadata_deleted = row
                    .get("metadata")
                    .and_then(|meta| meta.get("deletedAt"))
                    .is_some();
                if metadata_deleted {
                    continue;
                }
                let is_reply =
                    row.get("tweetType").and_then(serde_json::Value::as_str) == Some("reply");
                let post_text = row
                    .get("postedText")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let reasons = posted_reasons(post_text, is_reply);
                if reasons.is_empty() {
                    continue;
                }
                let id = row
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string();
                let post_url = row
                    .get("postUrl")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                let truncated: String = post_text.chars().take(140).collect();
                let record = serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "delete_posted", "historyId": id, "postUrl": post_url, "reasons": reasons, "text": truncated});
                if dry_run {
                    let mut object = record.as_object().cloned().unwrap_or_default();
                    object.insert("dryRun".into(), true.into());
                    log_record(&serde_json::Value::Object(object));
                    posted_deleted += 1;
                    continue;
                }
                match api
                    .post_json(
                        &format!("/history/{id}/delete"),
                        Some(&serde_json::json!({})),
                        120_000,
                    )
                    .await
                {
                    Ok(result) => {
                        let mut object = record.as_object().cloned().unwrap_or_default();
                        object.insert(
                            "alreadyDeleted".into(),
                            result
                                .get("alreadyDeleted")
                                .cloned()
                                .unwrap_or(false.into()),
                        );
                        log_record(&serde_json::Value::Object(object));
                        posted_deleted += 1;
                    }
                    Err(error) => {
                        log_record(
                            &serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "delete_posted_failed", "historyId": id, "error": error}),
                        );
                    }
                }
            }
        }
    } else {
        log_record(
            &serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "posted_audit_skipped", "reason": "browser delete is gated behind the post flag"}),
        );
    }

    log_record(
        &serde_json::json!({"at": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true), "action": "cycle", "queueDeleted": queue_deleted, "postedDeleted": posted_deleted, "dryRun": dry_run}),
    );
    (queue_deleted, posted_deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hard_slop_catches_phrases_and_dashes() {
        assert!(
            hard_slop_reasons("This will leverage the API")
                .iter()
                .any(|r| r.starts_with("slop_phrase"))
        );
        assert!(hard_slop_reasons("a — b").contains(&"em_or_en_dash".to_string()));
        assert!(hard_slop_reasons("").contains(&"empty_text".to_string()));
    }

    #[test]
    fn point_number_detection() {
        assert!(invented_point_number("See Point 2 for details"));
        assert!(!invented_point_number("Point 1 is fine"));
        assert!(!invented_point_number("The point is 2"));
    }
}
