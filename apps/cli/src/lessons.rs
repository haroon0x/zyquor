//! `zyquor lessons [--dry]` — propose standing corrections from measured posts.
//!
//! Port of `scripts/propose-lessons.mjs`: read-only on the database, compare
//! top vs bottom posts by views using the content features frozen at
//! approval time, and append PROPOSED corrections to the feedback notebook.
//! Nothing is auto-applied. Refuses below a minimum sample size and states
//! the numbers behind every proposal.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;

use zyquor_automation::analyze_post_features;
use zyquor_storage::SqliteRepository;

#[derive(Debug, Clone)]
struct MeasuredPost {
    account_id: String,
    text: String,
    has_digits: bool,
    ends_with_question: bool,
    link_count: f64,
    opener: String,
    views: i64,
}

fn env_number(name: &str, fallback: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(fallback)
}

fn features_from_metadata(
    text: &str,
    metadata: &serde_json::Map<String, serde_json::Value>,
) -> (bool, bool, f64, String) {
    let fallback = analyze_post_features(text);
    let features = metadata
        .get("features")
        .and_then(serde_json::Value::as_object);
    match features {
        Some(features) => {
            let has_digits = features
                .get("hasDigits")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(fallback.has_digits);
            let ends_question = features
                .get("endsWithQuestion")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(fallback.ends_with_question);
            let link_count = features
                .get("linkCount")
                .and_then(serde_json::Value::as_f64)
                .unwrap_or(fallback.link_count as f64);
            let opener = features
                .get("opener")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
                .unwrap_or(fallback.opener);
            (has_digits, ends_question, link_count, opener)
        }
        None => (
            fallback.has_digits,
            fallback.ends_with_question,
            fallback.link_count as f64,
            fallback.opener,
        ),
    }
}

fn db_path() -> std::path::PathBuf {
    if let Ok(value) = std::env::var("ZYQUOR_MENTIONS_DB") {
        if !value.is_empty() {
            return std::path::PathBuf::from(value);
        }
    }
    if let Ok(root) = std::env::var("ZYQUOR_DATA_ROOT") {
        if !root.is_empty() {
            return std::path::PathBuf::from(root)
                .join("data")
                .join("app.sqlite");
        }
    }
    std::path::PathBuf::from("data").join("app.sqlite")
}

pub fn run(args: &[String]) -> Result<i32, String> {
    let dry = args.iter().any(|arg| arg == "--dry");
    let path = db_path();
    if !path.is_file() {
        eprintln!("DB not found: {}", path.display());
        return Ok(1);
    }
    let data_root = std::env::var("ZYQUOR_DATA_ROOT")
        .ok()
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."))
        });
    let notebook_dir = std::env::var("ZYQUOR_FEEDBACK_DIR")
        .ok()
        .filter(|value| !value.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| data_root.join("feedback"));

    let repository = SqliteRepository::open(&path).map_err(|error| error.to_string())?;
    let history = repository
        .list_post_history()
        .map_err(|error| error.to_string())?;

    let min_sample = env_number("ZYQUOR_PROPOSE_MIN_SAMPLE", 6.0) as usize;
    let min_views = env_number("ZYQUOR_PROPOSE_MIN_VIEWS", 30.0) as i64;

    let mut posts: Vec<MeasuredPost> = Vec::new();
    for row in &history {
        let performance = row
            .metadata
            .get("performance")
            .and_then(serde_json::Value::as_object);
        let Some(performance) = performance else {
            continue;
        };
        let views = performance.get("views").and_then(serde_json::Value::as_i64);
        let Some(views) = views else {
            continue;
        };
        let (has_digits, ends_question, link_count, opener) =
            features_from_metadata(&row.posted_text, &row.metadata);
        posts.push(MeasuredPost {
            account_id: row.account_id.clone(),
            text: row.posted_text.clone(),
            has_digits,
            ends_with_question: ends_question,
            link_count,
            opener,
            views,
        });
    }

    println!(
        "Measured posts: {} (need >= {min_sample} to propose anything)",
        posts.len()
    );
    if posts.len() < min_sample {
        println!(
            "Not enough data to propose lessons yet. Keep posting and measuring; run this again around {min_sample}+ measured posts."
        );
        return Ok(0);
    }
    let total_reach: i64 = posts.iter().map(|post| post.views).sum();
    if total_reach < min_views {
        println!(
            "Total reach across all measured posts is {total_reach} views — below the {min_views}-view floor where differences mean anything. No proposals."
        );
        return Ok(0);
    }

    let mut by_account: BTreeMap<String, Vec<MeasuredPost>> = BTreeMap::new();
    for post in posts {
        by_account
            .entry(post.account_id.clone())
            .or_default()
            .push(post);
    }

    #[derive(Debug)]
    struct Proposal {
        account_id: String,
        evidence: String,
        correction: String,
    }
    let mut proposals: Vec<Proposal> = Vec::new();
    for (account_id, mut mine) in by_account {
        mine.sort_by_key(|a| std::cmp::Reverse(a.views));
        if mine.len() < min_sample {
            continue;
        }
        let mid = mine.len() / 2;
        let top = &mine[..mid];
        let bottom = &mine[mid..];
        let avg_num = |rows: &[MeasuredPost], key: &str| -> f64 {
            rows.iter()
                .map(|post| match key {
                    "hasDigits" => f64::from(post.has_digits),
                    "endsWithQuestion" => f64::from(post.ends_with_question),
                    _ => post.link_count,
                })
                .sum::<f64>()
                / rows.len() as f64
        };
        let checks: [(&str, &str, &str); 3] = [
            (
                "hasDigits",
                "posts with a concrete number",
                "Include one concrete number in every post.",
            ),
            (
                "endsWithQuestion",
                "posts ending in a question",
                "End more posts with a question to invite replies.",
            ),
            (
                "linkCount",
                "link count",
                "Include the source link in the post body.",
            ),
        ];
        for (key, label, correction) in checks {
            let top_avg = avg_num(top, key);
            let bottom_avg = avg_num(bottom, key);
            if top_avg > bottom_avg * 1.5 && top_avg - bottom_avg >= 0.34 {
                let top_views =
                    top.iter().map(|post| post.views).sum::<i64>() as f64 / top.len() as f64;
                let bottom_views =
                    bottom.iter().map(|post| post.views).sum::<i64>() as f64 / bottom.len() as f64;
                proposals.push(Proposal {
                    account_id: account_id.clone(),
                    evidence: format!(
                        "{}% of top-half posts vs {}% of bottom-half {label} (top avg {top_views:.0} views, bottom {bottom_views:.0})",
                        (top_avg * 100.0).round(),
                        (bottom_avg * 100.0).round(),
                    ),
                    correction: correction.to_string(),
                });
            }
        }

        let bottom_openers: std::collections::HashSet<String> =
            bottom.iter().map(|post| post.opener.clone()).collect();
        let repeated: Vec<&MeasuredPost> = top
            .iter()
            .filter(|post| bottom_openers.contains(&post.opener))
            .collect();
        if repeated.is_empty() {
            let best = &top[0];
            if !best.opener.is_empty() {
                proposals.push(Proposal {
                    account_id: account_id.clone(),
                    evidence: format!("best post ({} views) opens \"{}\"", best.views, best.opener),
                    correction: format!(
                        "Open with the payoff in the first three words, like: \"{}...\"",
                        best.text.chars().take(60).collect::<String>()
                    ),
                });
            }
        }
    }

    if proposals.is_empty() {
        println!("No feature separates top from bottom half strongly enough yet. No proposals.");
        return Ok(0);
    }

    let stamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut lines: Vec<String> = Vec::new();
    for proposal in proposals.iter().take(3) {
        lines.push(format!(
            "## [proposed] {stamp} — account {}",
            proposal.account_id
        ));
        lines.push(String::new());
        lines.push(format!("Evidence: {}", proposal.evidence));
        lines.push(String::new());
        lines.push(format!("> PROPOSED correction: {}", proposal.correction));
        lines.push(String::new());
    }
    let body = lines.join("\n") + "\n";
    println!("\n{body}");
    if dry {
        println!("[dry] not written.");
        return Ok(0);
    }
    std::fs::create_dir_all(&notebook_dir).map_err(|error| error.to_string())?;
    let notebook = notebook_dir.join("notebook.md");
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&notebook)
        .map_err(|error| error.to_string())?;
    file.write_all(body.as_bytes())
        .map_err(|error| error.to_string())?;
    println!(
        "Appended {} proposed correction(s) to {}",
        proposals.len(),
        notebook.display()
    );
    println!("Review them and add the ones you agree with via the style panel.");
    let _ = HashMap::<String, String>::new();
    Ok(0)
}
