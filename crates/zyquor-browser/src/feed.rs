//! Feed fetch flows, ported from `fetchXHomeFeed` / `fetchXMentions` /
//! `fetchAccountTimeline` / `fetchTweet` / `fetchTweetPerformance` in
//! `packages/browser/src/index.ts`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::artifacts;
use crate::fetched_types::{TweetPerformanceMetrics, XFeedTweet};
use crate::login::{assert_not_login_page, page_for_session_check};
use crate::page::CdpPage;
use crate::session::Session;

#[derive(Debug, Clone)]
pub struct FeedFetchInput {
    pub profile_dir: String,
    pub cdp_url: String,
    pub max_tweets: Option<usize>,
    pub min_tweets: Option<usize>,
    pub scrolls: Option<usize>,
    pub action_delay_ms: Option<u64>,
    pub artifacts_dir: Option<PathBuf>,
    pub x_home_url: Option<String>,
    pub mentions_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FetchTweetPerformanceInput {
    pub profile_dir: String,
    pub cdp_url: String,
    pub status_url: String,
    pub action_delay_ms: Option<u64>,
    pub artifacts_dir: Option<PathBuf>,
}

fn resolve_artifacts_dir(input: &Option<PathBuf>) -> PathBuf {
    input
        .clone()
        .unwrap_or_else(artifacts::default_artifacts_dir)
}

fn extract_status_permalink(url: &str) -> Option<String> {
    let marker = "https://x.com/";
    let twitter_marker = "https://twitter.com/";
    for prefix in [marker, twitter_marker] {
        if let Some(rest) = url.strip_prefix(prefix) {
            let parts: Vec<&str> = rest.split('/').collect();
            if parts.len() >= 3 && !parts[0].is_empty() && parts[1] == "status" {
                let path = format!("/{}/{}/{}", parts[0], parts[1], parts[2]);
                return Some(path);
            }
        }
    }
    None
}

/// `cleanAuthorName` from `index.ts`.
fn clean_author_name(name_line: &str, handle: &str) -> String {
    let first_line = name_line.split('\n').next().unwrap_or("").trim();
    let mut name = first_line.to_string();
    if let Some(at_pos) = name.to_lowercase().rfind(&format!("@{handle}")) {
        name.truncate(at_pos);
    }
    if let Some(dot_pos) = name.find(" · ") {
        name.truncate(dot_pos);
    }
    name = name.trim_end().to_string();
    if name.ends_with('@') {
        name.pop();
    }
    if name.is_empty() {
        handle.to_string()
    } else {
        name
    }
}

#[derive(Debug, Clone, serde::Deserialize)]
struct RawFeedRow {
    #[serde(default)]
    status_link: Option<String>,
    #[serde(default)]
    text: String,
    #[serde(default)]
    user_name: String,
    #[serde(default)]
    social_context: String,
    #[serde(default)]
    header_text: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    is_promoted: bool,
    #[serde(default)]
    has_link: bool,
}

async fn extract_feed_rows(page: &CdpPage) -> Result<Vec<RawFeedRow>, String> {
    page.evaluate(
        r#"(() => {
            return [...document.querySelectorAll('article[data-testid="tweet"]')].map((article) => {
                const statusLink = article.querySelector('a[href*="/status/"]')?.getAttribute("href") ?? null;
                const text = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? "";
                const userName = article.querySelector('[data-testid="User-Name"]')?.textContent ?? "";
                const socialContext = article.querySelector('[data-testid="socialContext"]')?.textContent ?? "";
                const headerText = article.querySelector("header")?.textContent ?? "";
                const publishedAt = article.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
                const placementText = article.closest('[data-testid="placementTracking"]')?.textContent ?? "";
                const ariaLabels = Array.from(article.querySelectorAll("[aria-label]"))
                    .map((element) => element.getAttribute("aria-label") ?? "")
                    .join(" ");
                const promotionText = `${socialContext} ${headerText} ${placementText} ${ariaLabels}`;
                const isPromoted = /\b(promoted|sponsored|advertisement|advertiser)\b/i.test(promotionText);
                const hasLink = Array.from(article.querySelectorAll("a[href]"))
                    .map((anchor) => anchor.getAttribute("href") ?? "")
                    .filter((href) => href.length > 0)
                    .some(
                        (href) =>
                            !/\/status\/(\d+)(\/|$)/.test(href) &&
                            !/^\/[A-Za-z0-9_]{1,15}\/?$/.test(href) &&
                            (/^(https?:)?\/\//.test(href) || href.includes("t.co/"))
                    );
                return { statusLink, text, userName, socialContext, headerText, publishedAt, isPromoted, hasLink };
            });
        })()"#,
    )
    .await
}

fn row_to_tweet(row: &RawFeedRow) -> Option<XFeedTweet> {
    let status_link = row.status_link.clone()?;
    let url = extract_status_permalink(&status_link)?;
    let (id, handle) = parse_status_url_parts(&url)?;
    let author_name = clean_author_name(&row.user_name, &handle);
    let is_retweet = row.social_context.contains("Reposted")
        || row.header_text.contains("Reposted")
        || is_reposted_label(&row.social_context)
        || is_reposted_label(&row.header_text);
    Some(XFeedTweet {
        id,
        author_handle: handle,
        author_name,
        text: row.text.clone(),
        url,
        published_at: row.published_at.clone(),
        is_retweet,
        is_promoted: Some(row.is_promoted),
        has_link: Some(row.has_link),
    })
}

fn is_reposted_label(text: &str) -> bool {
    fancy_regex::Regex::new(r"(?i)reposted")
        .map(|regex| regex.is_match(text).unwrap_or(false))
        .unwrap_or(false)
}

fn parse_status_url_parts(url: &str) -> Option<(String, String)> {
    let path = url
        .strip_prefix("https://x.com/")
        .or_else(|| url.strip_prefix("https://twitter.com/"))?;
    let parts: Vec<&str> = path.split('/').collect();
    if parts.len() >= 3 && parts[1] == "status" {
        return Some((parts[2].to_string(), parts[0].to_string()));
    }
    None
}

async fn extract_feed_tweets(page: &CdpPage, max_tweets: usize) -> Vec<XFeedTweet> {
    let Ok(rows) = extract_feed_rows(page).await else {
        return Vec::new();
    };
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tweets = Vec::new();
    for row in rows {
        if row.is_promoted {
            continue;
        }
        let Some(tweet) = row_to_tweet(&row) else {
            continue;
        };
        if seen.contains(&tweet.url) {
            continue;
        }
        seen.insert(tweet.url.clone());
        tweets.push(tweet);
        if tweets.len() >= max_tweets {
            break;
        }
    }
    tweets
}

async fn collect_tweets(
    page: &CdpPage,
    max_tweets: usize,
    collected: &mut HashMap<String, XFeedTweet>,
) {
    for tweet in extract_feed_tweets(page, max_tweets).await {
        collected.entry(tweet.url.clone()).or_insert(tweet);
    }
}

async fn collect_feed_tweets(
    page: &CdpPage,
    max_tweets: usize,
    min_tweets: usize,
    scrolls: usize,
    action_delay_ms: u64,
) -> Vec<XFeedTweet> {
    let mut collected: HashMap<String, XFeedTweet> = HashMap::new();
    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;
    for tweet in extract_feed_tweets(page, max_tweets).await {
        collected.entry(tweet.url.clone()).or_insert(tweet);
    }

    for _index in 0..scrolls {
        if collected.len() >= min_tweets {
            break;
        }
        let _ = page.mouse_wheel(0.0, 2_400.0).await;
        let _ = page.scroll_by(2_400).await;
        tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;
        for tweet in extract_feed_tweets(page, max_tweets).await {
            collected.entry(tweet.url.clone()).or_insert(tweet);
        }
    }

    collected.into_values().take(max_tweets).collect()
}

async fn reload_and_collect(
    page: &CdpPage,
    max_tweets: usize,
    min_tweets: usize,
    scrolls: usize,
    action_delay_ms: u64,
) -> Result<Vec<XFeedTweet>, String> {
    assert_not_login_page(page).await?;
    let tweets = collect_feed_tweets(page, max_tweets, min_tweets, scrolls, action_delay_ms).await;
    if tweets.len() >= min_tweets {
        return Ok(tweets);
    }
    let _ = page.reload(30_000).await;
    assert_not_login_page(page).await?;
    let tweets = collect_feed_tweets(page, max_tweets, min_tweets, scrolls, action_delay_ms).await;
    if tweets.len() >= min_tweets {
        return Ok(tweets);
    }
    Err(format!(
        "Only {} tweets extracted from the X home feed (minimum {min_tweets})",
        tweets.len()
    ))
}

#[derive(Debug, Clone)]
pub struct FetchHomeFeedResult {
    pub tweets: Vec<XFeedTweet>,
    pub url: String,
}

pub async fn fetch_x_home_feed(
    session: &Session,
    input: &FeedFetchInput,
) -> Result<FetchHomeFeedResult, String> {
    let max_tweets = input.max_tweets.unwrap_or(20);
    let min_tweets = input.min_tweets.unwrap_or(15);
    let scrolls = input.scrolls.unwrap_or(8);
    let action_delay_ms = input.action_delay_ms.unwrap_or(1_500);
    let artifacts_dir = resolve_artifacts_dir(&input.artifacts_dir);
    artifacts::ensure_artifacts_dir(&artifacts_dir)?;
    let screenshot_path = artifacts::artifact_path(&artifacts_dir, "feed");

    let x_home_url = input
        .x_home_url
        .clone()
        .unwrap_or_else(|| "https://x.com/home".to_string());
    let page = page_for_home_feed(session, &x_home_url).await?;
    let tweets =
        match reload_and_collect(&page, max_tweets, min_tweets, scrolls, action_delay_ms).await {
            Ok(tweets) => tweets,
            Err(error) => {
                let _ = page.screenshot_full_page(&screenshot_path).await;
                return Err(error);
            }
        };
    Ok(FetchHomeFeedResult {
        url: page.url().await,
        tweets,
    })
}

pub async fn fetch_x_mentions(
    session: &Session,
    input: &FeedFetchInput,
) -> Result<FetchHomeFeedResult, String> {
    let max_tweets = input.max_tweets.unwrap_or(30);
    let scrolls = input.scrolls.unwrap_or(4);
    let action_delay_ms = input.action_delay_ms.unwrap_or(1_500);
    let artifacts_dir = resolve_artifacts_dir(&input.artifacts_dir);
    artifacts::ensure_artifacts_dir(&artifacts_dir)?;
    let screenshot_path = artifacts::artifact_path(&artifacts_dir, "mentions");

    let mentions_url = input
        .mentions_url
        .clone()
        .unwrap_or_else(|| "https://x.com/notifications/mentions".to_string());
    let page = page_for_mentions(session, &mentions_url).await?;
    assert_not_login_page(&page).await?;

    let mut collected: HashMap<String, XFeedTweet> = HashMap::new();
    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;
    collect_tweets(&page, max_tweets, &mut collected).await;

    for _index in 0..scrolls {
        if collected.len() >= max_tweets {
            break;
        }
        let _ = page.mouse_wheel(0.0, 2_400.0).await;
        let _ = page.scroll_by(2_400).await;
        tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;
        collect_tweets(&page, max_tweets, &mut collected).await;
    }

    let tweets: Vec<XFeedTweet> = collected.into_values().take(max_tweets).collect();
    let url = page.url().await;
    let _ = &screenshot_path;
    Ok(FetchHomeFeedResult { tweets, url })
}

pub async fn fetch_account_timeline(
    session: &Session,
    input: &FeedFetchInput,
    handle: &str,
) -> Result<FetchHomeFeedResult, String> {
    let max_tweets = input.max_tweets.unwrap_or(30);
    let scrolls = input.scrolls.unwrap_or(10);
    let action_delay_ms = input.action_delay_ms.unwrap_or(1_500);
    let target_url = format!("https://x.com/{handle}");

    let page = page_for_session_check(session, "https://x.com/home").await?;
    let _ = page.goto(&target_url, 45_000).await;
    assert_not_login_page(&page).await?;
    let tweets = collect_feed_tweets(
        &page,
        max_tweets,
        max_tweets.min(5),
        scrolls,
        action_delay_ms,
    )
    .await;
    let url = page.url().await;
    Ok(FetchHomeFeedResult { tweets, url })
}

#[derive(Debug, Clone)]
pub struct FetchTweetPerformanceResult {
    pub metrics: TweetPerformanceMetrics,
}

#[derive(Debug, Clone)]
pub struct FetchTweetResult {
    pub tweet: XFeedTweet,
    pub url: String,
    pub replies: Option<Vec<XFeedTweet>>,
}

async fn extract_tweet_from_status_page(page: &CdpPage, status_url: &str) -> Option<XFeedTweet> {
    let tweet_id = crate::fetched_types::tweet_id_from_status_url(status_url)?;
    let rows: Vec<RawFeedRow> = page
        .evaluate(
            &format!(
                r#"(() => {{
                    const tid = {tid_json};
                    return [...document.querySelectorAll('article[data-testid="tweet"]')].map((article) => {{
                        const statusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]'))
                            .map((anchor) => anchor.getAttribute("href") ?? "")
                            .filter(Boolean);
                        const canonicalLink = statusLinks.find((href) => {{
                            const m = /\/[A-Za-z0-9_]+\/status\/(\d+)\/?$/.exec(href);
                            return m?.[1] === tid;
                        }}) ?? null;
                        const normalText = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? "";
                        const longformText = article
                            .querySelector('[data-testid="longformRichTextComponent"], [data-testid="twitterArticleRichTextView"]')
                            ?.textContent?.trim() ?? "";
                        const fallbackText = article.querySelector('[data-testid="tweet"] [dir="auto"]')?.textContent?.trim() ?? "";
                        const text = (normalText || longformText || fallbackText).trim();
                        const userName = article.querySelector('[data-testid="User-Name"]')?.textContent ?? "";
                        const socialContext = article.querySelector('[data-testid="socialContext"]')?.textContent ?? "";
                        const headerText = article.querySelector("header")?.textContent ?? "";
                        const publishedAt = article.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
                        const isPromoted = /\b(promoted|sponsored|advertisement|advertiser)\b/i.test(`${{socialContext}} ${{headerText}}`);
                        const hasLink = Array.from(article.querySelectorAll("a[href]"))
                            .map((anchor) => anchor.getAttribute("href") ?? "")
                            .filter((href) => href.length > 0)
                            .some(
                                (href) =>
                                    !/\/status\/(\d+)(\/|$)/.test(href) &&
                                    !/^\/[A-Za-z0-9_]{{1,15}}\/?$/.test(href) &&
                                    (/^(https?:)?\/\//.test(href) || href.includes("t.co/"))
                            );
                        return {{ statusLink: canonicalLink, text, userName, socialContext, headerText, publishedAt, isPromoted, hasLink }};
                    }});
                }})()"#,
                tid_json = serde_json::to_string(&tweet_id).unwrap_or_else(|_| "\"\"".to_string())
            ),
        )
        .await
        .ok()?;

    let row = rows
        .into_iter()
        .filter(|row| row.status_link.is_some())
        .find(|row| {
            row.status_link.as_deref().is_some_and(|link| {
                link.chars()
                    .rev()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    == tweet_id
            })
        })?;
    row_to_tweet(&row)
}

async fn collect_reply_rows(page: &CdpPage, target_tweet_id: &str) -> Vec<RawFeedRow> {
    page.evaluate(
        &format!(
            r#"(() => {{
                const tid = {tid_json};
                const collected = [];
                for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {{
                    const statusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]'))
                        .map((anchor) => anchor.getAttribute("href") ?? "")
                        .filter(Boolean);
                    const ownLink = statusLinks.find((href) => {{
                        const m = /\/[A-Za-z0-9_]+\/status\/(\d+)\/?$/.exec(href);
                        return m?.[1] !== undefined && m[1] !== tid;
                    }}) ?? null;
                    const text = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? "";
                    if (!ownLink || !text) continue;
                    collected.push({{
                        statusLink: ownLink,
                        text,
                        userName: article.querySelector('[data-testid="User-Name"]')?.textContent ?? "",
                        socialContext: article.querySelector('[data-testid="socialContext"]')?.textContent ?? "",
                        headerText: article.querySelector("header")?.textContent ?? "",
                        publishedAt: article.querySelector("time[datetime]")?.getAttribute("datetime") ?? null,
                        isPromoted: false,
                        hasLink: false,
                    }});
                }}
                return collected;
            }})()"#,
            tid_json = serde_json::to_string(target_tweet_id).unwrap_or_else(|_| "\"\"".to_string())
        ),
    )
    .await
    .unwrap_or_default()
}

async fn extract_status_replies(
    page: &CdpPage,
    target_tweet_id: &str,
    max_replies: usize,
    scrolls: usize,
    action_delay_ms: u64,
) -> Vec<XFeedTweet> {
    for index in 0..=scrolls {
        let rows = collect_reply_rows(page, target_tweet_id).await;
        if rows.len() >= max_replies {
            break;
        }
        if index == scrolls {
            break;
        }
        let _ = page.mouse_wheel(0.0, 2_400.0).await;
        let _ = page.scroll_by(2_400).await;
        tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;
    }

    let final_rows = collect_reply_rows(page, target_tweet_id).await;
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut replies = Vec::new();
    for row in final_rows {
        let Some(tweet) = row_to_tweet(&row) else {
            continue;
        };
        if tweet.id == target_tweet_id || seen.contains(&tweet.id) {
            continue;
        }
        seen.insert(tweet.id.clone());
        replies.push(tweet);
        if replies.len() >= max_replies {
            break;
        }
    }
    replies
}

pub async fn fetch_tweet(
    session: &Session,
    status_url: &str,
    action_delay_ms: Option<u64>,
    max_replies: Option<usize>,
) -> Result<FetchTweetResult, String> {
    let action_delay_ms = action_delay_ms.unwrap_or(1_500);
    let artifacts_dir = artifacts::default_artifacts_dir();
    let _ = artifacts::ensure_artifacts_dir(&artifacts_dir);
    let screenshot_path = artifacts::artifact_path(&artifacts_dir, "tweet");

    let page = session.new_page().await?;
    let _ = page.goto(status_url, 45_000).await;

    if is_login_form_ready(&page).await {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(
            "X profile is not logged in. Run `pnpm profile:x:manual`, log into X, close that browser, then retry.".to_string(),
        );
    }

    let loaded = wait_for_tweet_ready(&page).await;
    if !loaded {
        let diag = page
            .evaluate_value(
                r#"(() => ({
                    url: location.href.slice(0, 120),
                    title: document.title.slice(0, 60),
                    visibility: document.visibilityState,
                    bodyPreview: document.body?.innerText?.slice(0, 160)
                }))()"#,
            )
            .await
            .unwrap_or(serde_json::Value::Null);
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(format!(
            "Timed out waiting for the target tweet to render at {status_url}. {diag}"
        ));
    }

    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;

    let Some(tweet) = extract_tweet_from_status_page(&page, status_url).await else {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(format!(
            "Could not extract the target tweet from {status_url}"
        ));
    };
    if tweet.text.trim().is_empty() {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(format!(
            "Could not extract the target tweet from {status_url}"
        ));
    }

    let max_replies = max_replies.unwrap_or(0);
    let replies = if max_replies > 0 {
        Some(extract_status_replies(&page, &tweet.id, max_replies, 2, action_delay_ms).await)
    } else {
        None
    };

    Ok(FetchTweetResult {
        tweet,
        url: status_url.to_string(),
        replies,
    })
}

async fn wait_for_tweet_ready(page: &CdpPage) -> bool {
    for _attempt in 0..3 {
        let deadline = chrono::Utc::now().timestamp_millis() + 20_000;
        while chrono::Utc::now().timestamp_millis() < deadline {
            if tweet_ready(page).await {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
        }
        let _ = page.reload(30_000).await;
    }
    false
}

async fn tweet_ready(page: &CdpPage) -> bool {
    page.evaluate_value(
        r#"(() => {
            const hasArticle = !!document.querySelector('article[data-testid="tweet"]');
            const hasText = !!document.querySelector('[data-testid="tweetText"], [data-testid="longformRichTextComponent"]');
            const hasPermalink = Array.from(document.querySelectorAll('a[href*="/status/"]')).some(
                (anchor) => /\/status\/\d+\/?$/.test(anchor.getAttribute("href") ?? "")
            );
            return hasArticle && (hasText || hasPermalink);
        })()"#,
    )
    .await
    .map(|value| value == serde_json::Value::Bool(true))
    .unwrap_or(false)
}

pub async fn fetch_tweet_performance(
    session: &Session,
    input: &FetchTweetPerformanceInput,
) -> Result<FetchTweetPerformanceResult, String> {
    let action_delay_ms = input.action_delay_ms.unwrap_or(1_500);
    let artifacts_dir = resolve_artifacts_dir(&input.artifacts_dir);
    artifacts::ensure_artifacts_dir(&artifacts_dir)?;
    let screenshot_path = artifacts::artifact_path(&artifacts_dir, "performance");

    let page = session.new_page().await?;
    let _ = page.goto(&input.status_url, 45_000).await;

    if is_login_form_ready(&page).await {
        return Err(
            "X profile is not logged in. Run `pnpm profile:x:manual`, log into X, close that browser, then retry."
                .to_string(),
        );
    }

    let loaded = wait_for_metrics_ready(&page).await;
    if !loaded {
        let _ = page.screenshot_full_page(&screenshot_path).await;
        return Err(format!(
            "Timed out waiting for tweet metrics to render at {}",
            input.status_url
        ));
    }

    tokio::time::sleep(std::time::Duration::from_millis(action_delay_ms)).await;
    let metrics = extract_tweet_performance(&page, &input.status_url).await?;
    Ok(FetchTweetPerformanceResult { metrics })
}

async fn wait_for_metrics_ready(page: &CdpPage) -> bool {
    for _attempt in 0..3 {
        let deadline = chrono::Utc::now().timestamp_millis() + 20_000;
        while chrono::Utc::now().timestamp_millis() < deadline {
            if metrics_ready(page).await {
                return true;
            }
            tokio::time::sleep(std::time::Duration::from_millis(1_500)).await;
        }
        let _ = page.reload(30_000).await;
    }
    false
}

async fn metrics_ready(page: &CdpPage) -> bool {
    page.evaluate_value(
        r#"(() => {
            const hasArticle = !!document.querySelector('article[data-testid="tweet"]');
            const hasText = !!document.querySelector('[data-testid="tweetText"], [data-testid="longformRichTextComponent"]');
            const hasActionBar = !!document.querySelector('[data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [data-testid="bookmark"]');
            return hasArticle && (hasText || hasActionBar);
        })()"#,
    )
    .await
    .map(|value| value == serde_json::Value::Bool(true))
    .unwrap_or(false)
}

#[derive(Debug, Clone, serde::Deserialize)]
struct RawPerformanceExtraction {
    #[serde(default)]
    labels: Vec<String>,
    #[serde(default)]
    containers: Vec<String>,
    #[serde(default)]
    body: String,
}

async fn extract_tweet_performance(
    page: &CdpPage,
    status_url: &str,
) -> Result<TweetPerformanceMetrics, String> {
    let permalink = extract_status_permalink(status_url).unwrap_or_else(|| status_url.to_string());
    let id = crate::fetched_types::tweet_id_from_status_url(&permalink).unwrap_or_default();

    let raw: RawPerformanceExtraction = page
        .evaluate(
            r#"(() => {
            const article = document.querySelector('article[data-testid="tweet"]');
            if (!article) return { labels: [], containers: [], body: "" };
            const labels = [];
            for (const element of Array.from(article.querySelectorAll("[aria-label]"))) {
                const label = element.getAttribute("aria-label");
                if (label) labels.push(label);
            }
            const containers = [];
            for (const element of Array.from(article.querySelectorAll('[data-testid="app-text-transition-container"]'))) {
                const text = element.textContent ?? "";
                if (text.trim()) containers.push(text.trim());
            }
            const body = (article).innerText ?? "";
            return { labels, containers, body };
        })()"#,
        )
        .await?;

    let sources = {
        let mut sources = raw.labels.clone();
        sources.extend(raw.containers.clone());
        sources.push(raw.body.clone());
        sources
    };

    let measured_at =
        chrono::DateTime::<chrono::Utc>::from_timestamp(chrono::Utc::now().timestamp(), 0)
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
            .unwrap_or_default();

    Ok(TweetPerformanceMetrics {
        id,
        url: permalink,
        views: crate::parse_utils::extract_unit_count(
            &sources,
            r"(?i)([\d.,]+\s*[kmb]?)\s*views?\b",
        ),
        replies: crate::parse_utils::extract_unit_count(
            &sources,
            r"(?i)([\d.,]+\s*[kmb]?)\s*repl\w*\b",
        ),
        reposts: crate::parse_utils::extract_unit_count(
            &sources,
            r"(?i)([\d.,]+\s*[kmb]?)\s*repost\w*\b",
        ),
        likes: crate::parse_utils::extract_unit_count(
            &sources,
            r"(?i)([\d.,]+\s*[kmb]?)\s*l\w*es?\b",
        ),
        bookmarks: crate::parse_utils::extract_unit_count(
            &sources,
            r"(?i)([\d.,]+\s*[kmb]?)\s*bookmark\w*\b",
        ),
        measured_at,
    })
}

async fn is_login_form_ready(page: &CdpPage) -> bool {
    page.evaluate_value(
        r#"(() => {
            return !!document.querySelector('input[name="text"], input[name="password"], a[href="/login"], [data-testid="loginButton"]');
        })()"#,
    )
    .await
    .map(|value| value == serde_json::Value::Bool(true))
    .unwrap_or(false)
}

async fn page_for_home_feed(session: &Session, target_url: &str) -> Result<CdpPage, String> {
    let page = page_for_session_check(session, target_url).await?;
    if is_home_feed_page(&page, Some(target_url)).await {
        return Ok(page);
    }
    let _ = page.goto(target_url, 15_000).await;
    Ok(page)
}

async fn page_for_mentions(session: &Session, target_url: &str) -> Result<CdpPage, String> {
    let page = page_for_session_check(session, target_url).await?;
    if is_mentions_page(&page, Some(target_url)).await {
        return Ok(page);
    }
    let _ = page.goto(target_url, 15_000).await;
    Ok(page)
}

async fn is_home_feed_page(page: &CdpPage, expected_url: Option<&str>) -> bool {
    let url = page.url().await;
    if let Some(expected) = expected_url {
        return url == expected;
    }
    is_x_page(&url)
        && url::Url::parse(&url)
            .map(|url| url.path() == "/home")
            .unwrap_or(false)
}

async fn is_mentions_page(page: &CdpPage, expected_url: Option<&str>) -> bool {
    let url = page.url().await;
    if let Some(expected) = expected_url {
        return url == expected;
    }
    url::Url::parse(&url)
        .map(|url| url.path() == "/notifications/mentions")
        .unwrap_or(false)
}

fn is_x_page(url: &str) -> bool {
    url.starts_with("https://x.com/") || url.starts_with("https://twitter.com/")
}

#[allow(dead_code)]
fn _unused_extraction(_path: &Path) -> String {
    _path.display().to_string()
}
