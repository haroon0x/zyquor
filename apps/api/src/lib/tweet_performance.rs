//! Post-performance refresh, ported from `apps/api/src/lib/tweet-performance.ts`.
//!
//! The learning loop is data-starved by design otherwise: at personal-account
//! volumes every measured post matters, so measure all pending posts each pass
//! and re-measure after 6h instead of 12h to catch early velocity.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::errors::ApiError;
use crate::state::AppState;

fn env_hours(name: &str, fallback: f64) -> f64 {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

fn env_usize(name: &str, fallback: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|value| value.trim().parse::<usize>().ok())
        .unwrap_or(fallback)
}

fn min_age_hours() -> f64 {
    env_hours("ZYQUOR_PERFORMANCE_MIN_AGE_HOURS", 2.0)
}

fn refetch_after_hours() -> f64 {
    env_hours("ZYQUOR_PERFORMANCE_REFETCH_HOURS", 6.0)
}

fn max_per_refresh() -> usize {
    env_usize("ZYQUOR_PERFORMANCE_MAX_PER_REFRESH", 8)
}

fn hours_ago_iso(hours: f64) -> String {
    let millis = chrono::Utc::now().timestamp_millis() - (hours * 3_600_000.0) as i64;
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_default()
}

fn tweet_id_from_post_url(post_url: Option<&str>) -> Option<String> {
    let url = post_url?;
    fancy_regex::Regex::new(r"/status/(\d+)/?$")
        .ok()
        .and_then(|regex| regex.captures(url).ok().flatten())
        .and_then(|captures| captures.get(1).map(|m| m.as_str().to_string()))
}

fn tweet_id_from_url(url: &str) -> Option<String> {
    fancy_regex::Regex::new(r"/(\d+)/?$")
        .ok()
        .and_then(|regex| regex.captures(url).ok().flatten())
        .and_then(|captures| captures.get(1).map(|m| m.as_str().to_string()))
}

fn needs_measurement(
    history: &zyquor_storage::PostHistory,
    hours_ago_min: &str,
    hours_ago_refetch: &str,
) -> bool {
    if tweet_id_from_post_url(history.post_url.as_deref()).is_none() {
        return false;
    }
    if history.posted_at.as_str() > hours_ago_min {
        return false;
    }
    let Some(existing) = zyquor_core::types::post_performance_from_metadata(&history.metadata)
    else {
        return true;
    };
    existing.measured_at.as_str() < hours_ago_refetch
}

fn with_post_performance(
    metadata: &serde_json::Map<String, serde_json::Value>,
    performance: &zyquor_core::types::PostPerformance,
) -> serde_json::Map<String, serde_json::Value> {
    let mut next = metadata.clone();
    next.insert(
        "performance".to_string(),
        serde_json::json!({
            "bookmarks": performance.bookmarks,
            "likes": performance.likes,
            "measuredAt": performance.measured_at,
            "replies": performance.replies,
            "reposts": performance.reposts,
            "views": performance.views,
        }),
    );
    next
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasuredEntry {
    pub history_id: String,
    pub likes: Option<i64>,
    pub views: Option<i64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    pub account_id: String,
    pub failed: Vec<String>,
    pub measured: Vec<MeasuredEntry>,
}

fn browser_action_delay_ms(state: &AppState) -> Option<u64> {
    state
        .browser
        .lock()
        .map(|guard| guard.action_delay_ms)
        .unwrap_or(None)
}

fn browser_cdp_base(state: &AppState) -> Option<String> {
    state
        .browser
        .lock()
        .map(|guard| guard.cdp_url.clone())
        .unwrap_or(None)
}

fn resolve_profile_dir(profile_dir: &str) -> String {
    if std::path::Path::new(profile_dir).is_absolute() {
        profile_dir.to_string()
    } else {
        zyquor_core::paths::resolve_data_root()
            .join(profile_dir)
            .to_string_lossy()
            .to_string()
    }
}

/// LCG-derived coin flip — same family of time-seeded randomness the
/// `POST /jobs/post-ready` shuffle uses (there is no `rand` dep here, which
/// keeps the API crate lean).
fn pseudo_random_half() -> bool {
    let seed = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0) as u64;
    let mut state = seed.wrapping_add(0x9e37_79b9_7f4a_7c15);
    state = state
        .wrapping_mul(6_364_136_223_846_793_005)
        .wrapping_add(1_442_695_040_888_963_407);
    (state ^ (state >> 29)) % 2 == 0
}

async fn fetch_performance_for(
    state: &AppState,
    profile_dir: &str,
    url: &str,
) -> Result<zyquor_browser::TweetPerformanceMetrics, String> {
    let base = browser_cdp_base(state).unwrap_or_else(|| "http://127.0.0.1:9222".to_string());
    let cdp_url = zyquor_core::paths::per_profile_cdp_url(Some(&base), profile_dir);
    let session = zyquor_browser::Session::connect(&cdp_url).await?;
    let input = zyquor_browser::FetchTweetPerformanceInput {
        profile_dir: resolve_profile_dir(profile_dir),
        cdp_url: cdp_url.clone(),
        status_url: url.to_string(),
        action_delay_ms: browser_action_delay_ms(state),
        artifacts_dir: None,
    };
    let result = zyquor_browser::fetch_tweet_performance(&session, &input).await?;
    Ok(result.metrics)
}

pub async fn refresh_tweet_performance(state: &AppState) -> Result<RefreshResult, ApiError> {
    let repository = state.repository();
    let hours_ago_min = hours_ago_iso(min_age_hours());
    let hours_ago_refetch = hours_ago_iso(refetch_after_hours());
    let accounts = repository.list_accounts().await?;
    let history = repository.list_post_history().await?;

    let mut measured: Vec<MeasuredEntry> = Vec::new();
    let mut failed: Vec<String> = Vec::new();

    let mut history_tweet_ids: HashSet<String> = HashSet::new();
    for item in &history {
        if let Some(id) = tweet_id_from_post_url(item.post_url.as_deref()) {
            history_tweet_ids.insert(id);
        }
    }

    let max_per = max_per_refresh();

    for account in &accounts {
        let mut candidates: Vec<&zyquor_storage::PostHistory> = history
            .iter()
            .filter(|item| item.account_id == account.id)
            .filter(|item| needs_measurement(item, &hours_ago_min, &hours_ago_refetch))
            .collect();
        candidates.sort_by(|left, right| left.posted_at.cmp(&right.posted_at));
        candidates.truncate(max_per);

        for item in candidates {
            let Some(post_url) = item.post_url.clone() else {
                continue;
            };
            let fetch = fetch_performance_for(state, &account.profile_dir, &post_url).await;
            match fetch {
                Ok(metrics) => {
                    let performance = zyquor_core::types::PostPerformance {
                        views: metrics.views,
                        likes: metrics.likes,
                        replies: metrics.replies,
                        reposts: metrics.reposts,
                        bookmarks: metrics.bookmarks,
                        measured_at: chrono::Utc::now()
                            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    };
                    let next_metadata = with_post_performance(&item.metadata, &performance);
                    repository
                        .update_post_history_metadata(&item.id, next_metadata)
                        .await?;
                    if let Some(tweet_id) = tweet_id_from_post_url(Some(&post_url)) {
                        repository
                            .upsert_tweet_measurement(zyquor_storage::NewTweetMeasurement {
                                account_id: account.id.clone(),
                                tweet_id,
                                origin: "zyquor".to_string(),
                                posted_at: Some(item.posted_at.clone()),
                                text: Some(item.posted_text.clone()),
                                has_link: Some(
                                    fancy_regex::Regex::new(r"(?i)https?://").is_ok_and(|regex| {
                                        regex.is_match(&item.posted_text).unwrap_or(false)
                                    }),
                                ),
                                source_type: item.source_type.clone(),
                                tweet_type: item.tweet_type.clone(),
                                views: performance.views,
                                likes: performance.likes,
                                replies: performance.replies,
                                reposts: performance.reposts,
                                bookmarks: performance.bookmarks,
                            })
                            .await?;
                    }
                    measured.push(MeasuredEntry {
                        history_id: item.id.clone(),
                        likes: performance.likes,
                        views: performance.views,
                    });
                    eprintln!(
                        "[performance] account={} history={} views={:?} likes={:?} replies={:?} reposts={:?} bookmarks={:?}",
                        account.id,
                        item.id,
                        performance.views,
                        performance.likes,
                        performance.replies,
                        performance.reposts,
                        performance.bookmarks,
                    );
                }
                Err(message) => {
                    failed.push(message.clone());
                    eprintln!(
                        "[performance] failed history={} account={}: {message}",
                        item.id, account.id
                    );
                }
            }
        }

        if let Err(message) = measure_external_tweets(
            state,
            &repository,
            account,
            &history_tweet_ids,
            measured.len(),
            &hours_ago_min,
            &hours_ago_refetch,
            max_per,
        )
        .await
        {
            failed.push(message.clone());
            eprintln!(
                "[performance] external timeline failed account={}: {message}",
                account.id
            );
        }
    }

    let account_id = accounts
        .first()
        .map(|account| account.id.clone())
        .unwrap_or_default();
    Ok(RefreshResult {
        account_id,
        failed,
        measured,
    })
}

#[allow(clippy::too_many_arguments)]
async fn measure_external_tweets(
    state: &AppState,
    repository: &crate::state::Repository,
    account: &zyquor_accounts::Account,
    history_tweet_ids: &HashSet<String>,
    measured_this_pass: usize,
    hours_ago_min: &str,
    hours_ago_refetch: &str,
    max_per_refresh: usize,
) -> Result<(), String> {
    // Passive-only capture: ride on a pass that already measured a zyquor post,
    // and even then only about half the time. Never opens the browser on a fixed
    // cadence on its own — a repeated automated profile visit is the exact
    // mechanical pattern bdsm flags (low entropy, serve_to_action=0, no dwell).
    if measured_this_pass == 0 || !pseudo_random_half() {
        return Ok(());
    }
    let base = browser_cdp_base(state).unwrap_or_else(|| "http://127.0.0.1:9222".to_string());
    let cdp_url = zyquor_core::paths::per_profile_cdp_url(Some(&base), &account.profile_dir);
    let timeline_tweets = {
        let session = zyquor_browser::Session::connect(&cdp_url).await?;
        let input = zyquor_browser::FeedFetchInput {
            profile_dir: resolve_profile_dir(&account.profile_dir),
            cdp_url: cdp_url.clone(),
            max_tweets: None,
            min_tweets: None,
            scrolls: None,
            action_delay_ms: browser_action_delay_ms(state),
            artifacts_dir: None,
            x_home_url: None,
            mentions_url: None,
        };
        let timeline =
            zyquor_browser::fetch_account_timeline(&session, &input, &account.handle).await?;
        timeline.tweets
    };
    if timeline_tweets.is_empty() {
        return Ok(());
    }

    let ledger = repository
        .list_tweet_measurements(Some(&account.id))
        .await
        .map_err(|error| error.to_string())?;
    let recent_by_tweet_id: HashMap<String, String> = ledger
        .into_iter()
        .map(|item| (item.tweet_id, item.measured_at))
        .collect();

    let mut candidates: Vec<&zyquor_browser::XFeedTweet> = timeline_tweets
        .iter()
        .filter(|tweet| tweet.author_handle == account.handle)
        .filter(|tweet| !tweet.is_retweet)
        .filter(|tweet| {
            tweet_id_from_url(&tweet.url).is_some_and(|id| !history_tweet_ids.contains(&id))
        })
        .filter(|tweet| {
            tweet
                .published_at
                .as_deref()
                .is_none_or(|published_at| published_at <= hours_ago_min)
        })
        .filter(|tweet| {
            let Some(id) = tweet_id_from_url(&tweet.url) else {
                return false;
            };
            recent_by_tweet_id
                .get(&id)
                .is_none_or(|last_measured| last_measured.as_str() < hours_ago_refetch)
        })
        .collect();
    candidates.sort_by(|left, right| {
        left.published_at
            .as_deref()
            .unwrap_or_default()
            .cmp(right.published_at.as_deref().unwrap_or_default())
    });
    candidates.truncate(max_per_refresh);

    for tweet in candidates {
        let Some(tweet_id) = tweet_id_from_url(&tweet.url) else {
            continue;
        };
        let fetch = fetch_performance_for(state, &account.profile_dir, &tweet.url).await;
        match fetch {
            Ok(metrics) => {
                repository
                    .upsert_tweet_measurement(zyquor_storage::NewTweetMeasurement {
                        account_id: account.id.clone(),
                        tweet_id: tweet_id.clone(),
                        origin: "external".to_string(),
                        posted_at: tweet.published_at.clone(),
                        text: Some(tweet.text.clone()),
                        has_link: tweet.has_link,
                        source_type: None,
                        tweet_type: None,
                        views: metrics.views,
                        likes: metrics.likes,
                        replies: metrics.replies,
                        reposts: metrics.reposts,
                        bookmarks: metrics.bookmarks,
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                eprintln!(
                    "[performance] account={} external=tweetId:{} views={:?} likes={:?} replies={:?} reposts={:?}",
                    account.id,
                    tweet_id,
                    metrics.views,
                    metrics.likes,
                    metrics.replies,
                    metrics.reposts,
                );
            }
            Err(message) => {
                eprintln!(
                    "[performance] failed external tweetId={tweet_id} account={}: {message}",
                    account.id
                );
            }
        }
    }
    Ok(())
}
