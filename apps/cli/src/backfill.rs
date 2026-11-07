//! `zyquor backfill-timeline [--dry-run]` — fetch account timelines and
//! backfill measurements / style examples.
//!
//! Port of `scripts/backfill-profile-timeline.mjs`, plus the
//! `data/backfill.jsonl` append required by the M8 spec: every fetch appends
//! one JSON line per timeline tweet to `<repo>/data/backfill.jsonl`.

use std::io::Write;

use crate::cli;
use zyquor_browser::FeedFetchInput;
use zyquor_core::paths::per_profile_cdp_url;
use zyquor_storage::{NewTweetMeasurement, SqliteRepository};

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
    if std::env::consts::OS == "linux" && std::env::var("WSL_DISTRO_NAME").is_ok() {
        let user = std::env::var("USERPROFILE_USER")
            .ok()
            .or_else(|| std::env::var("USER").ok())
            .unwrap_or_default();
        let wsl = std::path::PathBuf::from(format!(
            "/mnt/c/Users/{user}/AppData/Roaming/Zyquor/data/app.sqlite"
        ));
        if wsl.is_file() {
            return wsl;
        }
    }
    cli::repo_data_dir().join("app.sqlite")
}

fn base_cdp_url() -> String {
    cli::env_or("ZYQUOR_BROWSER_CDP_URL", "http://127.0.0.1:9222")
}

fn append_backfill_jsonl(record: &serde_json::Value) {
    let path = cli::repo_data_dir().join("backfill.jsonl");
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

/// Parse the tweet id from a status URL, mirroring the TypeScript
/// `tweet.url.split("/").pop()?.split("?")[0]` + digit check.
pub fn tweet_id_from_url(url: &str) -> Option<String> {
    let id = url.rsplit('/').next()?.split('?').next()?;
    let id = id.trim_end_matches('/');
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
        Some(id.to_string())
    } else {
        None
    }
}

pub async fn run(args: &[String]) -> Result<i32, String> {
    let dry_run = args.iter().any(|arg| arg == "--dry-run");
    let max_tweets: usize = std::env::var("BACKFILL_MAX_TWEETS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(30);
    let path = db_path();
    if !path.is_file() {
        eprintln!("DB not found: {}", path.display());
        return Ok(1);
    }
    let repository = SqliteRepository::open(&path).map_err(|error| error.to_string())?;
    let accounts: Vec<_> = repository
        .list_accounts()
        .map_err(|error| error.to_string())?
        .into_iter()
        .filter(|account| account.enabled)
        .collect();
    println!("Found {} enabled accounts", accounts.len());
    for account in &accounts {
        println!(
            " - {} {} {}",
            account.handle, account.id, account.profile_dir
        );
    }

    let base_url = base_cdp_url();
    for account in &accounts {
        let profile_dir = account.profile_dir.clone();
        let cdp_url = per_profile_cdp_url(Some(&base_url), &profile_dir);
        println!(
            "\n[{}] profile={profile_dir} cdp={cdp_url} maxTweets={max_tweets}{}",
            account.handle,
            if dry_run { " DRY_RUN" } else { "" }
        );
        let cdp_up = zyquor_browser::ensure_browser_cdp(&cdp_url, &profile_dir).await;
        if !cdp_up {
            eprintln!("  ensureBrowserCdp failed for @{}", account.handle);
        }

        let session = match zyquor_browser::Session::connect(&cdp_url).await {
            Ok(session) => session,
            Err(error) => {
                eprintln!("  fetch failed for @{}: {error}", account.handle);
                continue;
            }
        };
        let input = FeedFetchInput {
            profile_dir: profile_dir.clone(),
            cdp_url: cdp_url.clone(),
            max_tweets: Some(max_tweets),
            min_tweets: None,
            scrolls: Some(10),
            action_delay_ms: None,
            artifacts_dir: None,
            x_home_url: None,
            mentions_url: None,
        };
        let timeline =
            match zyquor_browser::fetch_account_timeline(&session, &input, &account.handle).await {
                Ok(result) => result,
                Err(error) => {
                    eprintln!("  fetch failed for @{}: {error}", account.handle);
                    continue;
                }
            };
        println!(
            "  fetched {} tweets for @{}",
            timeline.tweets.len(),
            account.handle
        );
        for tweet in &timeline.tweets {
            append_backfill_jsonl(&serde_json::json!({
                "accountId": account.id,
                "handle": account.handle,
                "id": tweet.id,
                "authorHandle": tweet.author_handle,
                "text": tweet.text,
                "url": tweet.url,
                "publishedAt": tweet.published_at,
                "isRetweet": tweet.is_retweet,
                "hasLink": tweet.has_link,
            }));
        }
        if timeline.tweets.is_empty() {
            continue;
        }

        let own: Vec<_> = timeline
            .tweets
            .iter()
            .filter(|tweet| {
                tweet.author_handle.eq_ignore_ascii_case(&account.handle) && !tweet.is_retweet
            })
            .collect();
        let examples: Vec<String> = own.iter().take(5).map(|tweet| tweet.text.clone()).collect();
        if !examples.is_empty() && !dry_run {
            if let Some(style) = repository
                .get_style_profile(&account.style_profile_id)
                .map_err(|error| error.to_string())?
            {
                let mut merged: Vec<String> = Vec::new();
                for example in examples.iter().chain(style.example_posts.iter()) {
                    if !merged.contains(example) {
                        merged.push(example.clone());
                    }
                }
                merged.truncate(5);
                let update = zyquor_storage::StyleProfileUpdate {
                    example_posts: Some(merged),
                    ..zyquor_storage::StyleProfileUpdate::default()
                };
                match repository.update_style_profile(&style.id, &update) {
                    Ok(_) => println!(
                        "  updated style_profile {} with {} examples",
                        style.id,
                        examples.len()
                    ),
                    Err(error) => eprintln!("  style update failed: {error}"),
                }
            }
        } else if dry_run && !examples.is_empty() {
            println!(
                "  would update style_profile with examples: {:?}",
                examples
                    .iter()
                    .take(2)
                    .map(|s| s.chars().take(60).collect::<String>())
                    .collect::<Vec<_>>()
            );
        }

        let mut inserted = 0_usize;
        for tweet in &own {
            let Some(tweet_id) = tweet_id_from_url(&tweet.url) else {
                continue;
            };
            if dry_run {
                inserted += 1;
                continue;
            }
            let existing = repository
                .list_tweet_measurements(Some(&account.id))
                .unwrap_or_default()
                .iter()
                .any(|row| row.tweet_id == tweet_id);
            if existing {
                continue;
            }
            let input = NewTweetMeasurement {
                account_id: account.id.clone(),
                tweet_id,
                origin: "external".to_string(),
                posted_at: tweet.published_at.clone(),
                text: Some(tweet.text.clone()),
                has_link: tweet.has_link,
                source_type: None,
                tweet_type: None,
                views: None,
                likes: None,
                replies: None,
                reposts: None,
                bookmarks: None,
            };
            match repository.upsert_tweet_measurement(&input) {
                Ok(_) => inserted += 1,
                Err(error) => eprintln!("  insert failed {}: {error}", tweet.url),
            }
        }
        println!(
            "  inserted {inserted} new tweet_measurements for @{}",
            account.handle
        );
    }

    if dry_run {
        println!("\nDry-run complete");
    } else {
        println!("\nBackfill complete");
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_ids() {
        assert_eq!(
            tweet_id_from_url("https://x.com/a/status/123?x=1"),
            Some("123".to_string())
        );
        assert_eq!(tweet_id_from_url("https://x.com/a/status/abc"), None);
        assert_eq!(tweet_id_from_url(""), None);
    }
}
