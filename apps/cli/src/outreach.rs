//! `zyquor outreach` — find live threads where someone describes the pain a
//! repo solves, rank them, and put review-only answers in a separate queue.
//!
//! This command has no posting path. It never calls the X browser, never
//! creates a post job, and never touches `ZYQUOR_ENABLE_BROWSER_POST`. The
//! queue is for a human to copy into Reddit or Hacker News manually.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zyquor_adapters::{
    ConfigMetadata, HackerNewsSearchAdapter, HackerNewsSearchAdapterOptions, RedditAdapter,
    RedditAdapterOptions, RedditCommentsAdapter, RedditCommentsAdapterOptions, ReqwestFetch,
    SourceAdapter, SourceItem,
};

const ARCTIC: &str = "https://arctic-shift.photon-reddit.com";
const HN_ITEM: &str = "https://hacker-news.firebaseio.com/v0/item";
const HN_POLICY: &str = "Hacker News: comments may mention your own work when they answer the question, but promotional or repetitive comments are flagged. Disclose that you built it; do not lead with the link.";
const MAX_AGE_HOURS: f64 = 14.0 * 24.0;
const QUEUE_AGE_HOURS: f64 = 7.0 * 24.0;

// ---------------------------------------------------------------------------
// profile and run types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Profile {
    repo: String,
    name: String,
    one_liner: String,
    #[serde(default)]
    pains: Vec<String>,
    #[serde(default)]
    keywords: Vec<String>,
    /// Groups of alternatives. A candidate must match at least one term in
    /// every group; this is what keeps "email" + unrelated "agent" from
    /// ranking as a fit.
    #[serde(default)]
    pain_groups: Vec<Vec<String>>,
    /// Exact phrases that name the repo's pain. A hit is worth more than a
    /// bag-of-words keyword match.
    #[serde(default)]
    exact_pains: Vec<String>,
    /// Terms that should appear in the thread title for a queueable HN reply.
    #[serde(default)]
    title_keywords: Vec<String>,
    /// Groups of alternatives that must all match the thread title. This is
    /// the precision gate: a comment can mention "email" in a thread about
    /// something else, and that is not a thread we want to answer.
    #[serde(default)]
    title_groups: Vec<Vec<String>>,
    #[serde(default)]
    reddit_queries: Vec<RedditQuery>,
    #[serde(default)]
    hn_queries: Vec<String>,
    #[serde(default)]
    utm: Utm,
    #[serde(default)]
    voice: String,
    #[serde(default)]
    link_policy: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RedditQuery {
    subreddit: String,
    term: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Utm {
    campaign: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Access {
    reddit: String,
    hackernews: String,
    notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Candidate {
    id: String,
    platform: String,
    subreddit: Option<String>,
    thread_url: String,
    thread_title: String,
    comment_url: String,
    parent_id: Option<String>,
    author: String,
    text: String,
    is_post: bool,
    age_hours: f64,
    score_raw: i64,
    comments: i64,
    matched: Vec<String>,
    pain_group: bool,
    title_hits: usize,
    title_group: bool,
    exact_pains: Vec<String>,
    rules: RulesInfo,
    removals: RemovalsInfo,
    existing_answer: bool,
    answer_exists: bool,
    fit_score: f64,
    reasons: Vec<String>,
    queueable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RulesInfo {
    known: bool,
    subreddit: String,
    self_promo: String,
    source: String,
    rules: Vec<RuleItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RuleItem {
    name: String,
    description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct RemovalsInfo {
    known: bool,
    removed: usize,
    total: usize,
    locked: bool,
    mod_sticky: bool,
    existing_answer: bool,
    target_replies: usize,
    answered: bool,
    sample: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftInput {
    candidate_id: String,
    text: String,
    hypothesis: String,
    #[serde(default)]
    utm_content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftFile {
    #[serde(default)]
    drafts: Vec<DraftInput>,
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

pub async fn run(args: &[String]) -> Result<i32, String> {
    let command = args.first().map(String::as_str).unwrap_or("help");
    let rest: &[String] = if args.is_empty() { &[] } else { &args[1..] };
    match command {
        "find" => find(rest).await,
        "queue" => queue(rest),
        "review" => review(rest),
        "list" => list(rest),
        "mark-sent" => mark_sent(rest),
        "skip" => skip(rest),
        "verify" => verify(rest).await,
        "help" | "--help" | "-h" => {
            print_usage();
            Ok(0)
        }
        other => Err(format!("unknown outreach command: {other}")),
    }
}

fn print_usage() {
    println!(
        "Usage: zyquor outreach <find|queue|review|list|mark-sent|skip|verify> [flags]\n\
         \n\
         find --profile <path> [--limit 6] [--hn-only|--reddit-only] [--live-only]\n\
         queue --run <run-id> [--file <drafts.json>]\n\
         review [--id <item-id>]\n\
         list\n\
         mark-sent --id <item-id> --url <comment-url>\n\
         skip --id <item-id> [--reason <text>]\n\
         verify\n\
         \n\
         The queue is local-only. Nothing is posted, and no X job is created."
    );
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

async fn find(args: &[String]) -> Result<i32, String> {
    let repo_root = crate::cli::repo_root();
    let data_root = repo_root.join("data").join("outreach");
    let profile_path = flag_value(args, "--profile")
        .map(|value| resolve_path(&repo_root, &value))
        .unwrap_or_else(|| data_root.join("profiles").join("herald.json"));
    let profile: Profile = serde_json::from_str(
        &fs::read_to_string(&profile_path)
            .map_err(|error| format!("read profile {}: {error}", profile_path.display()))?,
    )
    .map_err(|error| format!("parse profile {}: {error}", profile_path.display()))?;
    let limit = flag_value(args, "--limit")
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(6)
        .clamp(1, 12);
    let hn_only = has_flag(args, "--hn-only");
    let reddit_only = has_flag(args, "--reddit-only");
    let live_only = has_flag(args, "--live-only");

    let run_id = Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let run_dir = data_root.join("runs").join(&run_id);
    fs::create_dir_all(&run_dir)
        .map_err(|error| format!("create run dir {}: {error}", run_dir.display()))?;

    let client = reqwest::Client::builder()
        .user_agent("Zyquor-Outreach/0.1 (+https://github.com/haroon0x/zyquor)")
        .timeout(Duration::from_secs(35))
        .build()
        .map_err(|error| format!("http client: {error}"))?;

    let mut access = Access {
        reddit: "not-tried".to_string(),
        hackernews: "not-tried".to_string(),
        notes: Vec::new(),
    };
    let mut candidates: Vec<Candidate> = Vec::new();

    if !reddit_only {
        access.hackernews = "direct".to_string();
        let fetch = ReqwestFetch::new();
        for query in &profile.hn_queries {
            let adapter = HackerNewsSearchAdapter::new(
                fetch.clone(),
                HackerNewsSearchAdapterOptions {
                    crawl_service: None,
                    max_items: Some(50),
                    now: Some(Utc::now()),
                    tags: Some("comment".to_string()),
                    window_days: Some(30),
                    topic: query.clone(),
                },
            );
            match adapter.fetch(&ConfigMetadata::new()).await {
                Ok(items) => {
                    for item in items {
                        if let Some(candidate) = candidate_from_item(item, &profile) {
                            candidates.push(candidate);
                        }
                    }
                }
                Err(error) => access.notes.push(format!("hackernews '{query}': {error}")),
            }
        }
    }

    if !hn_only {
        let fetch = ReqwestFetch::new();
        let mut direct_count = 0usize;
        for query in &profile.reddit_queries {
            let adapter = RedditAdapter::new(
                fetch.clone(),
                RedditAdapterOptions {
                    crawl_service: None,
                    max_items: Some(50),
                    min_comments: Some(0),
                    min_score: Some(-100),
                    subreddit: Some(query.subreddit.clone()),
                    sort_by: Some("new".to_string()),
                    query: Some(query.term.clone()),
                    time_window: Some("month".to_string()),
                },
            );
            match adapter.fetch(&ConfigMetadata::new()).await {
                Ok(items) => {
                    direct_count += items.len();
                    for item in items {
                        if let Some(candidate) = candidate_from_item(item, &profile) {
                            candidates.push(candidate);
                        }
                    }
                }
                Err(error) => access
                    .notes
                    .push(format!("reddit search '{}': {error}", query.subreddit)),
            }

            let comments = RedditCommentsAdapter::new(
                fetch.clone(),
                RedditCommentsAdapterOptions {
                    max_items: Some(100),
                    subreddit: query.subreddit.clone(),
                    sort_by: Some("new".to_string()),
                },
            );
            match comments.fetch(&ConfigMetadata::new()).await {
                Ok(items) => {
                    direct_count += items.len();
                    for item in items {
                        if let Some(candidate) = candidate_from_item(item, &profile) {
                            candidates.push(candidate);
                        }
                    }
                }
                Err(error) => access
                    .notes
                    .push(format!("reddit comments '{}': {error}", query.subreddit)),
            }
        }

        if !live_only {
            access.reddit = if direct_count == 0 {
                "archive-fallback".to_string()
            } else {
                "direct+archive".to_string()
            };
            let mut archive = fetch_archive_candidates(&client, &profile, &mut access).await;
            candidates.append(&mut archive);
        } else {
            access.reddit = if direct_count == 0 {
                "unavailable".to_string()
            } else {
                "direct".to_string()
            };
            if direct_count == 0 {
                access.notes.push(
                    "Reddit returned no items and --live-only was set; no archive fallback used."
                        .to_string(),
                );
            }
        }
    }

    candidates = dedupe_candidates(candidates);
    candidates.retain(|candidate| keep_candidate(candidate, &profile));
    for candidate in &mut candidates {
        score_candidate(candidate);
    }
    candidates.sort_by(|left, right| {
        right
            .fit_score
            .partial_cmp(&left.fit_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(limit.max(1) * 3);

    // Enrich only what we might show. Rules and removal trees are the slow
    // part; never fetch them for fifty candidates.
    let mut rules_cache: HashMap<String, RulesInfo> = HashMap::new();
    let mut story_cache: HashMap<String, Value> = HashMap::new();
    for candidate in candidates.iter_mut() {
        match candidate.platform.as_str() {
            "hackernews" => {
                if let Some(story_id) = candidate
                    .thread_url
                    .split("id=")
                    .nth(1)
                    .and_then(|value| value.parse::<i64>().ok())
                {
                    let key = story_id.to_string();
                    let story = match story_cache.get(&key) {
                        Some(value) => Some(value.clone()),
                        None => {
                            let fetched = hn_story(&client, story_id).await;
                            if let Some(value) = &fetched {
                                story_cache.insert(key, value.clone());
                            }
                            fetched
                        }
                    };
                    if let Some(story) = story {
                        candidate.score_raw = story
                            .get("score")
                            .and_then(Value::as_i64)
                            .unwrap_or(candidate.score_raw);
                        candidate.comments = story
                            .get("descendants")
                            .and_then(Value::as_i64)
                            .unwrap_or(candidate.comments);
                    }
                }
                candidate.rules = RulesInfo {
                    known: true,
                    subreddit: "Hacker News".to_string(),
                    self_promo: HN_POLICY.to_string(),
                    source: "HN guidelines (manual)".to_string(),
                    rules: vec![RuleItem {
                        name: "Comments".to_string(),
                        description: HN_POLICY.to_string(),
                    }],
                };
                candidate.removals = RemovalsInfo {
                    known: true,
                    removed: 0,
                    total: candidate.comments.max(0) as usize,
                    locked: false,
                    mod_sticky: false,
                    existing_answer: false,
                    target_replies: 0,
                    answered: false,
                    sample: Vec::new(),
                };
            }
            "reddit" => {
                if let Some(subreddit) = candidate.subreddit.clone() {
                    candidate.rules = fetch_rules(&client, &subreddit, &mut rules_cache).await;
                }
                if let Some(link_id) = reddit_link_id(&candidate.thread_url) {
                    let target_id = candidate
                        .id
                        .strip_prefix("reddit:")
                        .unwrap_or("")
                        .to_string();
                    candidate.removals =
                        fetch_removals(&client, &link_id, &profile.repo, &target_id).await;
                }
                candidate.existing_answer = candidate.removals.existing_answer;
                candidate.answer_exists = candidate.removals.answered;
            }
            _ => {}
        }
        score_candidate(candidate);
    }
    candidates.sort_by(|left, right| {
        right
            .fit_score
            .partial_cmp(&left.fit_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.truncate(limit);

    let candidates_json = json!({
        "run_id": run_id,
        "generated_at": Utc::now().to_rfc3339(),
        "profile": profile,
        "access": access,
        "candidates": candidates,
    });
    let candidates_path = run_dir.join("candidates.json");
    fs::write(
        &candidates_path,
        serde_json::to_string_pretty(&candidates_json).unwrap_or_default(),
    )
    .map_err(|error| format!("write {}: {error}", candidates_path.display()))?;

    let report = render_report(&run_id, &profile, &access, &candidates);
    let report_path = run_dir.join("report.md");
    fs::write(&report_path, report)
        .map_err(|error| format!("write {}: {error}", report_path.display()))?;

    let prompt = render_draft_prompt(&profile, &candidates);
    let prompt_path = run_dir.join("draft_prompt.md");
    fs::write(&prompt_path, prompt)
        .map_err(|error| format!("write {}: {error}", prompt_path.display()))?;

    println!("outreach run {run_id}");
    println!("  profile:   {}", profile_path.display());
    println!("  reddit:    {}", access.reddit);
    println!("  hackernews: {}", access.hackernews);
    for note in &access.notes {
        println!("  note:      {note}");
    }
    if candidates.is_empty() {
        println!("  candidates: 0 — no live thread matched this profile.");
    } else {
        println!("  candidates: {}", candidates.len());
        for (index, candidate) in candidates.iter().enumerate() {
            println!(
                "  {}. [{:>5.1}] {} :: {}",
                index + 1,
                candidate.fit_score,
                candidate.subreddit.as_deref().unwrap_or("hackernews"),
                truncate(&candidate.text.replace('\n', " "), 92)
            );
            println!("     {}", candidate.comment_url);
            if !candidate.queueable {
                println!("     not queueable: {}", candidate.reasons.join("; "));
            }
        }
    }
    println!("  report:    {}", report_path.display());
    println!("  prompt:    {}", prompt_path.display());
    println!(
        "  next:      write {}/drafts.json, then `zyquor outreach queue --run {run_id}`",
        run_dir.display()
    );
    Ok(0)
}

// ---------------------------------------------------------------------------
// archive fallback
// ---------------------------------------------------------------------------

async fn fetch_archive_candidates(
    client: &reqwest::Client,
    profile: &Profile,
    access: &mut Access,
) -> Vec<Candidate> {
    let mut found: Vec<(Value, String)> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for query in &profile.reddit_queries {
        let terms = archive_terms(&query.term);
        let mut fetched = false;
        for term in terms {
            match arctic_comments(client, &query.subreddit, &term, 21, 100).await {
                Ok(rows) => {
                    fetched = true;
                    for row in rows {
                        let id = row
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if id.is_empty() || !seen.insert(id) {
                            continue;
                        }
                        found.push((row, query.subreddit.clone()));
                    }
                    break;
                }
                Err(error) => {
                    access.notes.push(format!(
                        "archive r/{} '{}': {}",
                        query.subreddit, term, error
                    ));
                }
            }
            tokio::time::sleep(Duration::from_millis(2_500)).await;
        }
        if !fetched {
            access.notes.push(format!(
                "archive r/{} '{}': no reachable query",
                query.subreddit, query.term
            ));
        }
        tokio::time::sleep(Duration::from_millis(2_000)).await;
    }

    let mut post_ids: Vec<String> = Vec::new();
    let mut seen_posts: HashSet<String> = HashSet::new();
    for (row, _) in &found {
        if let Some(link_id) = row.get("link_id").and_then(Value::as_str) {
            let id = link_id.trim_start_matches("t3_").to_string();
            if !id.is_empty() && seen_posts.insert(id.clone()) {
                post_ids.push(id);
            }
        }
    }

    let mut posts: HashMap<String, Value> = HashMap::new();
    for chunk in post_ids.chunks(100) {
        match arctic_posts(client, chunk).await {
            Ok(values) => {
                for value in values {
                    if let Some(id) = value.get("id").and_then(Value::as_str) {
                        posts.insert(id.to_string(), value);
                    }
                }
            }
            Err(error) => access.notes.push(format!("archive post lookup: {error}")),
        }
        tokio::time::sleep(Duration::from_millis(2_000)).await;
    }

    let mut candidates = Vec::new();
    for (row, subreddit) in &found {
        let link_id = row
            .get("link_id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_start_matches("t3_")
            .to_string();
        let post = posts.get(&link_id);
        if let Some(candidate) = candidate_from_arctic(row, post, subreddit, profile) {
            candidates.push(candidate);
        }
    }
    for post in posts.values() {
        let subreddit = post.get("subreddit").and_then(Value::as_str).unwrap_or("");
        if let Some(candidate) = candidate_from_arctic_post(post, subreddit, profile) {
            candidates.push(candidate);
        }
    }
    candidates
}

fn candidate_from_arctic_post(
    post: &Value,
    subreddit: &str,
    profile: &Profile,
) -> Option<Candidate> {
    let id = post.get("id").and_then(Value::as_str)?;
    let title = post.get("title").and_then(Value::as_str)?.trim();
    if title.is_empty() {
        return None;
    }
    let selftext = post
        .get("selftext")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let text = if selftext.is_empty() {
        title.to_string()
    } else {
        format!("{title}\n\n{selftext}")
    };
    if text.len() > 4000 {
        return None;
    }
    let combined = text.clone();
    let matched = matched_keywords(&combined, &profile.keywords);
    if matched.is_empty() {
        return None;
    }
    let pain_group = pain_group_match(&combined, &profile.pain_groups);
    let title_group = pain_group_match(title, &profile.title_groups);
    let exact_pains = exact_pain_hits(&format!("{title} {text}"), profile);
    if !pain_group || !title_group {
        return None;
    }
    let created = post.get("created_utc").and_then(Value::as_f64)?;
    let published = DateTime::<Utc>::from_timestamp(created as i64, 0)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    Some(Candidate {
        id: format!("reddit-post:{id}"),
        platform: "reddit".to_string(),
        subreddit: Some(subreddit.to_string()),
        thread_url: format!("https://www.reddit.com/r/{subreddit}/comments/{id}/"),
        thread_title: title.to_string(),
        comment_url: format!("https://www.reddit.com/r/{subreddit}/comments/{id}/"),
        parent_id: None,
        author: post
            .get("author")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        text,
        is_post: true,
        age_hours: age_hours(Some(&published)),
        score_raw: post.get("score").and_then(Value::as_i64).unwrap_or(0),
        comments: post
            .get("num_comments")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        matched,
        pain_group,
        title_hits: 0,
        title_group,
        exact_pains,
        rules: RulesInfo::default(),
        removals: RemovalsInfo::default(),
        existing_answer: false,
        answer_exists: false,
        fit_score: 0.0,
        reasons: Vec::new(),
        queueable: false,
    })
}

fn archive_terms(term: &str) -> Vec<String> {
    let mut terms = vec![term.to_string()];
    let words: Vec<&str> = term.split_whitespace().collect();
    if words.len() > 1 {
        if let Some(first) = words.first() {
            terms.push((*first).to_string());
        }
        if let Some(last) = words.last() {
            terms.push((*last).to_string());
        }
    }
    let mut seen = HashSet::new();
    terms.retain(|value| !value.trim().is_empty() && seen.insert(value.clone()));
    terms
}

async fn arctic_comments(
    client: &reqwest::Client,
    subreddit: &str,
    term: &str,
    days: i64,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let mut last_error = String::new();
    for attempt in 0..3 {
        match arctic_comments_once(client, subreddit, term, days, limit.min(50)).await {
            Ok(values) => return Ok(values),
            Err(error) => {
                last_error = error;
                if !last_error.contains("422") || attempt == 2 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(4_000 * (attempt as u64 + 1))).await;
            }
        }
    }
    Err(last_error)
}

async fn arctic_comments_once(
    client: &reqwest::Client,
    subreddit: &str,
    term: &str,
    days: i64,
    limit: usize,
) -> Result<Vec<Value>, String> {
    let after = (Utc::now() - chrono::Duration::days(days))
        .format("%Y-%m-%d")
        .to_string();
    let url = format!(
        "{ARCTIC}/api/comments/search?subreddit={}&body={}&after={after}&limit={limit}&sort=desc",
        url_encode(subreddit),
        url_encode(term)
    );
    let value = get_json(client, &url).await?;
    Ok(value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn arctic_posts(client: &reqwest::Client, ids: &[String]) -> Result<Vec<Value>, String> {
    let url = format!("{ARCTIC}/api/posts/ids?ids={}", ids.join(","));
    let value = get_json(client, &url).await?;
    Ok(value
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

// ---------------------------------------------------------------------------
// candidate conversion
// ---------------------------------------------------------------------------

fn candidate_from_item(item: SourceItem, profile: &Profile) -> Option<Candidate> {
    let is_hn = item
        .metadata
        .get("source")
        .and_then(Value::as_str)
        .is_some_and(|source| source.contains("hackernews"));
    let text = if is_hn {
        clean_html(item.content.trim())
    } else {
        item.content.trim().to_string()
    };
    if text.len() < 80 || text.len() > 4000 {
        return None;
    }
    let matched = matched_keywords(&text, &profile.keywords);
    if matched.is_empty() {
        return None;
    }
    let pain_group = pain_group_match(&text, &profile.pain_groups);
    let title_hits = title_hits(&item.title, profile);
    let title_group = pain_group_match(&item.title, &profile.title_groups);
    let exact_pains = exact_pain_hits(&text, profile);
    let kind = item
        .metadata
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("post");
    let platform = if item
        .metadata
        .get("source")
        .and_then(Value::as_str)
        .is_some_and(|source| source.contains("hackernews"))
    {
        "hackernews"
    } else {
        "reddit"
    };
    let published = item
        .metadata
        .get("published")
        .and_then(Value::as_str)
        .map(str::to_string);
    let age = age_hours(published.as_deref());
    let author = item
        .metadata
        .get("author")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut thread_url = item.url.clone();
    let mut comment_url = item.url.clone();
    if platform == "reddit" && kind == "comment" {
        let link_id = item
            .metadata
            .get("linkId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim_start_matches("t3_")
            .to_string();
        let subreddit = item
            .metadata
            .get("subreddit")
            .and_then(Value::as_str)
            .unwrap_or("");
        if !link_id.is_empty() {
            thread_url = format!("https://www.reddit.com/r/{subreddit}/comments/{link_id}/");
        }
    }
    if platform == "hackernews" {
        if let Some(value) = item.metadata.get("threadUrl").and_then(Value::as_str) {
            thread_url = value.to_string();
        }
        comment_url = item.url.clone();
    }
    Some(Candidate {
        id: format!("{platform}:{}", stable_id(&comment_url)),
        platform: platform.to_string(),
        subreddit: item
            .metadata
            .get("subreddit")
            .and_then(Value::as_str)
            .map(str::to_string),
        thread_url,
        thread_title: item.title.clone(),
        comment_url,
        parent_id: item
            .metadata
            .get("parentId")
            .and_then(Value::as_str)
            .map(str::to_string),
        author,
        text,
        is_post: false,
        age_hours: age,
        score_raw: item
            .metadata
            .get("score")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        comments: item
            .metadata
            .get("comments")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        matched,
        pain_group,
        title_hits,
        title_group,
        exact_pains,
        rules: RulesInfo::default(),
        removals: RemovalsInfo::default(),
        existing_answer: false,
        answer_exists: false,
        fit_score: 0.0,
        reasons: Vec::new(),
        queueable: false,
    })
}

fn candidate_from_arctic(
    row: &Value,
    post: Option<&Value>,
    subreddit: &str,
    profile: &Profile,
) -> Option<Candidate> {
    let body = row.get("body").and_then(Value::as_str)?.trim();
    if body.len() < 80 || body.len() > 4000 {
        return None;
    }
    if body == "[removed]" || body == "[deleted]" {
        return None;
    }
    if row
        .get("removed_by_category")
        .is_some_and(|value| !value.is_null())
    {
        return None;
    }
    if row
        .get("collapsed")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return None;
    }
    let matched = matched_keywords(body, &profile.keywords);
    if matched.is_empty() {
        return None;
    }
    let pain_group = pain_group_match(body, &profile.pain_groups);
    let thread_title = post
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let title_hits = title_hits(thread_title, profile);
    let title_group = pain_group_match(thread_title, &profile.title_groups);
    let exact_pains = exact_pain_hits(body, profile);
    let created = row.get("created_utc").and_then(Value::as_f64)?;
    let published = DateTime::<Utc>::from_timestamp(created as i64, 0)
        .map(|value| value.to_rfc3339())
        .unwrap_or_default();
    let link_id = row
        .get("link_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_start_matches("t3_")
        .to_string();
    let permalink = row.get("permalink").and_then(Value::as_str).unwrap_or("");
    if permalink.is_empty() || link_id.is_empty() {
        return None;
    }
    let title = post
        .and_then(|value| value.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Reddit thread")
        .to_string();
    let comments = post
        .and_then(|value| value.get("num_comments"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Some(Candidate {
        id: format!(
            "reddit:{}",
            row.get("id").and_then(Value::as_str).unwrap_or("")
        ),
        platform: "reddit".to_string(),
        subreddit: Some(subreddit.to_string()),
        thread_url: format!("https://www.reddit.com/r/{subreddit}/comments/{link_id}/"),
        thread_title: title,
        comment_url: format!("https://www.reddit.com{permalink}"),
        parent_id: row
            .get("parent_id")
            .and_then(Value::as_str)
            .map(str::to_string),
        author: row
            .get("author")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        text: body.to_string(),
        is_post: false,
        age_hours: age_hours(Some(&published)),
        score_raw: row.get("score").and_then(Value::as_i64).unwrap_or(0),
        comments,
        matched,
        pain_group,
        title_hits,
        title_group,
        exact_pains,
        rules: RulesInfo::default(),
        removals: RemovalsInfo::default(),
        existing_answer: false,
        answer_exists: false,
        fit_score: 0.0,
        reasons: Vec::new(),
        queueable: false,
    })
}

fn dedupe_candidates(candidates: Vec<Candidate>) -> Vec<Candidate> {
    let mut seen = HashSet::new();
    candidates
        .into_iter()
        .filter(|candidate| seen.insert(candidate.comment_url.clone()))
        .collect()
}

fn keep_candidate(candidate: &Candidate, profile: &Profile) -> bool {
    if candidate.age_hours > MAX_AGE_HOURS {
        return false;
    }
    if candidate.text.trim().len() < 80 {
        return false;
    }
    if candidate.author.eq_ignore_ascii_case("automoderator") {
        return false;
    }
    if is_noise_thread(&candidate.thread_title) || is_self_promo(&candidate.text) {
        return false;
    }
    if candidate.matched.is_empty() || !candidate.pain_group || !candidate.title_group {
        return false;
    }
    if is_quote_heavy(&candidate.text) {
        return false;
    }
    let lower = candidate.text.to_lowercase();
    let pain_marker = candidate.text.contains('?')
        || lower.contains(" i ")
        || lower.contains("my ")
        || lower.contains("how ")
        || lower.contains("what ")
        || lower.contains("recommend")
        || lower.contains("looking for")
        || profile
            .pains
            .iter()
            .any(|pain| lower.contains(&pain.to_lowercase()));
    if !pain_marker {
        return false;
    }
    !candidate.matched.is_empty() && (candidate.matched.len() >= 2 || !profile.pains.is_empty())
}

fn is_noise_thread(title: &str) -> bool {
    let lower = title.to_lowercase();
    lower.contains("who wants to be hired")
        || lower.contains("who is hiring")
        || lower.contains("monthly")
        || lower.contains("megathread")
        || lower.contains("weekly thread")
        || lower.contains("show hn")
        || lower.contains("[removed by moderator]")
        || lower.contains("[ removed by moderator ]")
}

fn is_self_promo(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "i built",
        "i made",
        "i launched",
        "i shipped",
        "my project",
        "my app",
        "my tool",
        "we built",
        "we made",
        "check out my",
        "open-sourced my",
        "open sourced my",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
}

fn matched_keywords(text: &str, keywords: &[String]) -> Vec<String> {
    let lower = text.to_lowercase();
    keywords
        .iter()
        .filter(|keyword| lower.contains(&keyword.to_lowercase()))
        .cloned()
        .collect()
}

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

fn score_candidate(candidate: &mut Candidate) {
    let fresh = if candidate.age_hours <= 24.0 {
        1.0
    } else if candidate.age_hours <= 72.0 {
        0.85
    } else if candidate.age_hours <= 168.0 {
        0.7
    } else {
        0.2
    };
    let pain = if candidate.pain_group { 1.0 } else { 0.2 };
    let title_factor = if candidate.title_group { 1.0 } else { 0.4 };
    let lower = candidate.text.to_lowercase();
    let answer: f64 =
        (if candidate.text.contains('?') {
            0.35
        } else {
            0.0
        }) + (if lower.contains("how ") || lower.contains("what ") || lower.contains("recommend") {
            0.25
        } else {
            0.0
        }) + (if lower.contains("i ") || lower.contains("my ") {
            0.2
        } else {
            0.0
        }) + (if candidate.text.len() >= 120 {
            0.2
        } else {
            0.0
        });
    let activity = ((1.0 + (candidate.score_raw.max(0) + candidate.comments.max(0)) as f64).ln()
        / 101_f64.ln())
    .min(1.0);
    let rules = rules_safety(candidate);
    let removals = removal_safety(candidate);
    let exact = (candidate.exact_pains.len() as f64 / 2.0).min(1.0);
    let mut score = 100.0
        * (0.25 * fresh
            + 0.20 * pain
            + 0.15 * answer.min(1.0)
            + 0.10 * activity
            + 0.10 * rules
            + 0.10 * removals
            + 0.10 * exact);
    if candidate.thread_title.contains('?') {
        score += 8.0;
    }
    if is_news_thread(&candidate.thread_title) && candidate.exact_pains.is_empty() {
        score -= 10.0;
    }
    score *= title_factor;
    if candidate.answer_exists {
        score *= 0.4;
    }
    if candidate.existing_answer {
        score *= 0.3;
    }
    candidate.fit_score = (score * 10.0).round() / 10.0;
    candidate.queueable = !candidate.existing_answer
        && !candidate.answer_exists
        && candidate.age_hours <= QUEUE_AGE_HOURS
        && candidate.pain_group
        && candidate.title_group
        && (!candidate.exact_pains.is_empty() || candidate.thread_title.contains('?'))
        && !(is_news_thread(&candidate.thread_title) && candidate.exact_pains.is_empty())
        && (candidate.platform == "hackernews" || candidate.rules.known)
        && rules >= 0.5
        && removals >= 0.5
        && !candidate.removals.locked;
    candidate.reasons = vec![
        format!("{:.0}h old", candidate.age_hours),
        format!("{} keyword hits", candidate.matched.len()),
        format!("{} exact pain hits", candidate.exact_pains.len()),
        format!(
            "title {}",
            if candidate.title_group {
                "fits"
            } else {
                "off-topic"
            }
        ),
        format!(
            "rules {}",
            if candidate.rules.known {
                "checked"
            } else {
                "unknown"
            }
        ),
        format!(
            "removals {}/{}",
            candidate.removals.removed, candidate.removals.total
        ),
    ];
    if candidate.existing_answer {
        candidate.reasons.push("repo already mentioned".to_string());
    }
    if candidate.answer_exists {
        candidate.reasons.push(format!(
            "already answered ({} replies)",
            candidate.removals.target_replies
        ));
    }
    if candidate.removals.locked {
        candidate.reasons.push("thread locked".to_string());
    }
    if candidate.removals.mod_sticky {
        candidate.reasons.push("mod sticky present".to_string());
    }
}

fn pain_group_match(text: &str, groups: &[Vec<String>]) -> bool {
    if groups.is_empty() {
        return true;
    }
    let lower = text.to_lowercase();
    groups.iter().all(|group| {
        group
            .iter()
            .any(|term| lower.contains(&term.to_lowercase()))
    })
}

fn exact_pain_hits(text: &str, profile: &Profile) -> Vec<String> {
    let lower = text.to_lowercase();
    profile
        .exact_pains
        .iter()
        .filter(|pain| lower.contains(&pain.to_lowercase()))
        .cloned()
        .collect()
}

fn is_news_thread(title: &str) -> bool {
    let lower = title.to_lowercase();
    [
        "says ",
        " bill",
        "outage",
        "rejecting",
        "routes ",
        "sends your",
        "could cut off",
        "announces",
        "is down",
        "degradation",
        "is rejecting",
        "will ban",
        "forces ",
    ]
    .iter()
    .any(|marker| lower.contains(marker))
}

fn title_hits(title: &str, profile: &Profile) -> usize {
    if title.trim().is_empty() {
        return 0;
    }
    let lower = title.to_lowercase();
    let terms: &[String] = if profile.title_keywords.is_empty() {
        &profile.keywords
    } else {
        &profile.title_keywords
    };
    terms
        .iter()
        .filter(|term| lower.contains(&term.to_lowercase()))
        .count()
}

fn is_quote_heavy(text: &str) -> bool {
    let quoted = text
        .lines()
        .filter(|line| line.trim_start().starts_with('>'))
        .count();
    quoted > 2 || text.len() > 2200
}

fn clean_html(input: &str) -> String {
    let mut text = input
        .replace("<p>", "\n\n")
        .replace("</p>", "")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("&gt;", ">")
        .replace("&lt;", "<")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    while let Some(start) = text.find('<') {
        let Some(end) = text[start..].find('>') else {
            break;
        };
        text.replace_range(start..start + end + 1, "");
    }
    text.lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn rules_safety(candidate: &Candidate) -> f64 {
    if candidate.platform == "hackernews" {
        return 0.7;
    }
    if !candidate.rules.known {
        return 0.4;
    }
    let text = candidate.rules.self_promo.to_lowercase();
    if text.contains("no self-promotion")
        || text.contains("no self promotion")
        || text.contains("not allowed")
        || text.contains("spam = ban")
        || text.contains("spam/advertising")
        || text.contains("zero-tolerance")
        || text.contains("in advance")
        || text.contains("contact us first")
        || text.contains("message/compose")
    {
        0.15
    } else if text.contains("limit")
        || text.contains("1/10")
        || text.contains("weekly")
        || text.contains("megathread")
        || text.contains("show ih")
        || text.contains("be upfront")
        || text.contains("disclose")
    {
        0.6
    } else {
        0.9
    }
}

fn removal_safety(candidate: &Candidate) -> f64 {
    if !candidate.removals.known {
        return 0.7;
    }
    if candidate.removals.total == 0 {
        return 0.7;
    }
    let ratio = candidate.removals.removed as f64 / candidate.removals.total as f64;
    if ratio < 0.05 {
        1.0
    } else if ratio < 0.15 {
        0.6
    } else {
        0.2
    }
}

// ---------------------------------------------------------------------------
// rules and removals
// ---------------------------------------------------------------------------

async fn fetch_rules(
    client: &reqwest::Client,
    subreddit: &str,
    cache: &mut HashMap<String, RulesInfo>,
) -> RulesInfo {
    if let Some(value) = cache.get(subreddit) {
        return value.clone();
    }
    let mut info = RulesInfo {
        subreddit: subreddit.to_string(),
        ..RulesInfo::default()
    };
    let direct = format!("https://www.reddit.com/r/{subreddit}/about/rules.json?raw_json=1");
    if let Ok(value) = get_json(client, &direct).await {
        if let Some(rules) = value.pointer("/data/rules").and_then(Value::as_array) {
            fill_rules(&mut info, rules, "reddit");
        }
    }
    if !info.known {
        tokio::time::sleep(Duration::from_millis(2_000)).await;
        let archive = format!(
            "{ARCTIC}/api/subreddits/rules?subreddits={}",
            url_encode(subreddit)
        );
        if let Ok(value) = get_json(client, &archive).await {
            if let Some(rules) = value.pointer("/data/0/rules").and_then(Value::as_array) {
                fill_rules(&mut info, rules, "arctic-shift");
            }
        }
    }
    cache.insert(subreddit.to_string(), info.clone());
    info
}

fn fill_rules(info: &mut RulesInfo, rules: &[Value], source: &str) {
    let mut all: Vec<RuleItem> = Vec::new();
    for rule in rules {
        let name = rule
            .get("short_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let description = rule
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if name.is_empty() && description.is_empty() {
            continue;
        }
        all.push(RuleItem { name, description });
    }
    if all.is_empty() {
        return;
    }
    info.known = true;
    info.source = source.to_string();
    info.self_promo = all
        .iter()
        .find(|rule| {
            let text = format!("{} {}", rule.name, rule.description).to_lowercase();
            text.contains("self-promotion")
                || text.contains("self promotion")
                || text.contains("shill")
                || text.contains("spam")
                || text.contains("advertis")
        })
        .map(|rule| format!("{} — {}", rule.name, rule.description))
        .unwrap_or_else(|| "No explicit self-promotion rule found in the rules feed.".to_string());
    info.rules = all;
}

async fn fetch_removals(
    client: &reqwest::Client,
    link_id: &str,
    repo: &str,
    target_id: &str,
) -> RemovalsInfo {
    let mut info = RemovalsInfo::default();
    let archive = format!("{ARCTIC}/api/comments/tree?link_id=t3_{link_id}&limit=25000");
    if let Ok(value) = get_json(client, &archive).await {
        walk_node(&value, &mut info, repo);
        enrich_target_answers(&value, target_id, &mut info);
        info.known = info.total > 0;
        return info;
    }
    tokio::time::sleep(Duration::from_millis(1_500)).await;
    let direct = format!("https://www.reddit.com/comments/{link_id}.json?limit=500&raw_json=1");
    if let Ok(value) = get_json(client, &direct).await {
        walk_node(&value, &mut info, repo);
        enrich_target_answers(&value, target_id, &mut info);
        info.known = true;
    }
    info
}

fn enrich_target_answers(root: &Value, target_id: &str, info: &mut RemovalsInfo) {
    if target_id.is_empty() {
        return;
    }
    let Some(target) = find_comment_node(root, target_id) else {
        return;
    };
    let Some(replies) = target.get("data").and_then(|data| data.get("replies")) else {
        return;
    };
    let (count, answered) = count_comment_replies(replies);
    info.target_replies = count;
    info.answered = answered;
}

fn find_comment_node<'a>(node: &'a Value, id: &str) -> Option<&'a Value> {
    match node {
        Value::Array(items) => items.iter().find_map(|item| find_comment_node(item, id)),
        Value::Object(map) => {
            if let Some(data) = map.get("data") {
                if data.get("id").and_then(Value::as_str) == Some(id) {
                    return Some(node);
                }
                if let Some(found) = find_comment_node(data, id) {
                    return Some(found);
                }
            }
            if let Some(children) = map.get("children") {
                if let Some(found) = find_comment_node(children, id) {
                    return Some(found);
                }
            }
            if let Some(replies) = map.get("replies") {
                if let Some(found) = find_comment_node(replies, id) {
                    return Some(found);
                }
            }
            None
        }
        _ => None,
    }
}

fn count_comment_replies(node: &Value) -> (usize, bool) {
    let mut count = 0usize;
    let mut answered = false;
    fn walk(node: &Value, count: &mut usize, answered: &mut bool) {
        match node {
            Value::Array(items) => {
                for item in items {
                    walk(item, count, answered);
                }
            }
            Value::Object(map) => {
                if map.get("kind").and_then(Value::as_str) == Some("more") {
                    return;
                }
                if let Some(data) = map.get("data") {
                    if let Some(body) = data.get("body").and_then(Value::as_str) {
                        if body != "[removed]" && body != "[deleted]" {
                            *count += 1;
                            let score = data.get("score").and_then(Value::as_i64).unwrap_or(0);
                            if body.len() > 100 && score >= 1 {
                                *answered = true;
                            }
                        }
                    }
                    if let Some(replies) = data.get("replies") {
                        walk(replies, count, answered);
                    }
                    if let Some(children) = data.get("children") {
                        walk(children, count, answered);
                    }
                } else {
                    if let Some(children) = map.get("children") {
                        walk(children, count, answered);
                    }
                    if let Some(replies) = map.get("replies") {
                        walk(replies, count, answered);
                    }
                }
            }
            _ => {}
        }
    }
    walk(node, &mut count, &mut answered);
    (count, answered)
}

fn walk_node(node: &Value, info: &mut RemovalsInfo, repo: &str) {
    match node {
        Value::Array(items) => {
            for item in items {
                walk_node(item, info, repo);
            }
        }
        Value::Object(map) => {
            if map.get("kind").and_then(Value::as_str) == Some("more") {
                return;
            }
            if let Some(data) = map.get("data") {
                if let Some(children) = data.as_array() {
                    for child in children {
                        walk_node(child, info, repo);
                    }
                    return;
                }
            }
            if let Some(data) = map.get("data") {
                if let Some(body) = data.get("body").and_then(Value::as_str) {
                    info.total += 1;
                    let removed = body == "[removed]"
                        || body == "[deleted]"
                        || data
                            .get("removed_by_category")
                            .is_some_and(|value| !value.is_null());
                    if removed {
                        info.removed += 1;
                        if info.sample.len() < 3 {
                            info.sample.push(truncate(body, 120));
                        }
                    }
                    if body.to_lowercase().contains(&repo.to_lowercase()) {
                        info.existing_answer = true;
                    }
                }
                if data
                    .get("stickied")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    || data.get("distinguished").and_then(Value::as_str) == Some("moderator")
                {
                    info.mod_sticky = true;
                }
                if data.get("locked").and_then(Value::as_bool).unwrap_or(false) {
                    info.locked = true;
                }
                if let Some(children) = data.get("children").and_then(Value::as_array) {
                    for child in children {
                        walk_node(child, info, repo);
                    }
                }
                if let Some(replies) = data.get("replies") {
                    walk_node(replies, info, repo);
                }
            } else if let Some(children) = map.get("children").and_then(Value::as_array) {
                for child in children {
                    walk_node(child, info, repo);
                }
            }
        }
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// report and prompt
// ---------------------------------------------------------------------------

fn render_report(
    run_id: &str,
    profile: &Profile,
    access: &Access,
    candidates: &[Candidate],
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "# Outreach candidates — {} — {run_id}\n\n",
        profile.name
    ));
    out.push_str(&format!("Repo: `{}`\n\n", profile.repo));
    out.push_str(&format!(
        "Access: reddit `{}`, hackernews `{}`\n\n",
        access.reddit, access.hackernews
    ));
    if !access.notes.is_empty() {
        out.push_str("Notes:\n");
        for note in &access.notes {
            out.push_str(&format!("- {note}\n"));
        }
        out.push('\n');
    }
    out.push_str(
        "| # | fit | platform | thread | age | matches | rules | removals | queueable |\n",
    );
    out.push_str("| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n");
    for (index, candidate) in candidates.iter().enumerate() {
        out.push_str(&format!(
            "| {} | {:.1} | {} | {} | {:.0}h | {} | {} | {}/{} | {} |\n",
            index + 1,
            candidate.fit_score,
            candidate.platform,
            truncate(&candidate.thread_title, 48),
            candidate.age_hours,
            candidate.matched.join(", "),
            if candidate.rules.known {
                "checked"
            } else {
                "unknown"
            },
            candidate.removals.removed,
            candidate.removals.total,
            if candidate.queueable { "yes" } else { "no" }
        ));
    }
    out.push_str("\n## Details\n\n");
    for (index, candidate) in candidates.iter().enumerate() {
        out.push_str(&format!(
            "### {}. {} — {:.1}\n\n",
            index + 1,
            candidate.subreddit.as_deref().unwrap_or("Hacker News"),
            candidate.fit_score
        ));
        out.push_str(&format!("- Thread: {}\n", candidate.thread_url));
        out.push_str(&format!("- Reply target: {}\n", candidate.comment_url));
        out.push_str(&format!("- Author: u/{}\n", candidate.author));
        out.push_str(&format!(
            "- Age: {:.1}h, score {}, comments {}\n",
            candidate.age_hours, candidate.score_raw, candidate.comments
        ));
        out.push_str(&format!("- Rules: {}\n", candidate.rules.self_promo));
        out.push_str(&format!(
            "- Removals: {}/{} (locked: {}, mod sticky: {})\n",
            candidate.removals.removed,
            candidate.removals.total,
            candidate.removals.locked,
            candidate.removals.mod_sticky
        ));
        if !candidate.reasons.is_empty() {
            out.push_str(&format!("- Signals: {}\n", candidate.reasons.join("; ")));
        }
        out.push_str(&format!(
            "- Queueable: {}\n\n",
            if candidate.queueable { "yes" } else { "no" }
        ));
        out.push_str("> ");
        out.push_str(&candidate.text.replace('\n', "\n> "));
        out.push_str("\n\n");
    }
    out
}

fn render_draft_prompt(profile: &Profile, candidates: &[Candidate]) -> String {
    let mut out = String::new();
    out.push_str("# Draft prompt\n\n");
    out.push_str(&format!(
        "You are drafting a reply in the voice of the maintainer of {}.\n\n",
        profile.name
    ));
    out.push_str(&format!("Repo: https://github.com/{}\n", profile.repo));
    out.push_str(&format!("One line: {}\n\n", profile.one_liner));
    if !profile.voice.is_empty() {
        out.push_str(&format!("Voice notes: {}\n\n", profile.voice));
    }
    if !profile.link_policy.is_empty() {
        out.push_str(&format!("Link policy: {}\n\n", profile.link_policy));
    }
    out.push_str("Rules for every draft:\n\n");
    out.push_str("- Answer the parent comment first, in its own terms. The repo is the artifact, not the subject.\n");
    out.push_str(
        "- Disclose that you built it. No fake familiarity, no \"we\" if it is one person.\n",
    );
    out.push_str("- One link maximum, at the end, with the UTM URL supplied by the run.\n");
    out.push_str("- If the repo does not fit (for example, it reads Maildir and the person is on Gmail), say so before linking.\n");
    out.push_str("- 120–220 words. No openers like \"great question\". No listicle. No claims the README does not support.\n");
    out.push_str(
        "- One hypothesis per reply, written in the queue metadata, not in the reply.\n\n",
    );
    out.push_str("Candidates:\n\n");
    for (index, candidate) in candidates.iter().enumerate() {
        out.push_str(&format!(
            "## {}. {} — {}\n\n",
            index + 1,
            candidate.subreddit.as_deref().unwrap_or("Hacker News"),
            candidate.comment_url
        ));
        out.push_str(&format!("Thread: {}\n\n", candidate.thread_url));
        out.push_str(&format!(
            "Parent comment by u/{}:\n\n> {}\n\n",
            candidate.author,
            candidate.text.replace('\n', "\n> ")
        ));
        out.push_str(&format!("Rules: {}\n\n", candidate.rules.self_promo));
        out.push_str("Draft JSON item:\n\n```json\n");
        let example = json!({
            "candidate_id": candidate.id,
            "text": "…",
            "hypothesis": "…",
            "utm_content": format!("{}-{}", candidate.platform, stable_id(&candidate.comment_url))
        });
        out.push_str(&serde_json::to_string_pretty(&example).unwrap_or_default());
        out.push_str("\n```\n\n");
    }
    out
}

// ---------------------------------------------------------------------------
// queue / review / sent / verify
// ---------------------------------------------------------------------------

fn queue(args: &[String]) -> Result<i32, String> {
    let repo_root = crate::cli::repo_root();
    let data_root = repo_root.join("data").join("outreach");
    let run_id =
        flag_value(args, "--run").ok_or_else(|| "--run <run-id> is required".to_string())?;
    let run_dir = data_root.join("runs").join(&run_id);
    let candidates_path = run_dir.join("candidates.json");
    let candidates_value: Value = serde_json::from_str(
        &fs::read_to_string(&candidates_path)
            .map_err(|error| format!("read {}: {error}", candidates_path.display()))?,
    )
    .map_err(|error| format!("parse candidates.json: {error}"))?;
    let profile: Profile = serde_json::from_value(
        candidates_value
            .get("profile")
            .cloned()
            .ok_or_else(|| "candidates.json has no profile".to_string())?,
    )
    .map_err(|error| format!("parse profile from candidates.json: {error}"))?;
    let candidates: Vec<Candidate> = serde_json::from_value(
        candidates_value
            .get("candidates")
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
    )
    .map_err(|error| format!("parse candidates from candidates.json: {error}"))?;
    let by_id: HashMap<String, Candidate> = candidates
        .into_iter()
        .map(|candidate| (candidate.id.clone(), candidate))
        .collect();

    let drafts_path = flag_value(args, "--file")
        .map(|value| resolve_path(&run_dir, &value))
        .unwrap_or_else(|| run_dir.join("drafts.json"));
    let drafts: DraftFile = serde_json::from_str(
        &fs::read_to_string(&drafts_path)
            .map_err(|error| format!("read {}: {error}", drafts_path.display()))?,
    )
    .map_err(|error| format!("parse {}: {error}", drafts_path.display()))?;
    if drafts.drafts.is_empty() {
        return Err(format!("{} has no drafts", drafts_path.display()));
    }

    let db_path = data_root.join("outreach.sqlite");
    let connection = open_queue(&db_path)?;
    let now = Utc::now().to_rfc3339();
    let mut inserted = 0usize;
    for (index, draft) in drafts.drafts.iter().enumerate() {
        let candidate = by_id
            .get(&draft.candidate_id)
            .ok_or_else(|| format!("unknown candidate_id {}", draft.candidate_id))?;
        validate_draft(draft, candidate, &profile)?;
        let id = format!("outreach_{}_{}", Utc::now().timestamp_millis(), index);
        let utm_url = if draft.utm_content.is_empty() {
            utm_url(
                &profile,
                &candidate.platform,
                &stable_id(&candidate.comment_url),
            )
        } else {
            utm_url(&profile, &candidate.platform, &draft.utm_content)
        };
        connection
            .execute(
                "INSERT OR REPLACE INTO outreach_items (
                   id, run_id, repo, platform, subreddit, thread_url, thread_title,
                   comment_url, parent_author, parent_text, rules_json, removals_json,
                   candidate_json, hypothesis, text, utm_url, status, queued_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)",
                params![
                    id,
                    run_id,
                    profile.repo,
                    candidate.platform,
                    candidate.subreddit,
                    candidate.thread_url,
                    candidate.thread_title,
                    candidate.comment_url,
                    candidate.author,
                    candidate.text,
                    serde_json::to_string(&candidate.rules).unwrap_or_default(),
                    serde_json::to_string(&candidate.removals).unwrap_or_default(),
                    serde_json::to_string(candidate).unwrap_or_default(),
                    draft.hypothesis,
                    draft.text,
                    utm_url,
                    now,
                ],
            )
            .map_err(|error| format!("insert outreach item: {error}"))?;
        inserted += 1;
        println!("queued {id}");
        println!("  target: {}", candidate.comment_url);
        println!("  rules:  {}", candidate.rules.self_promo);
        println!("  link:   {utm_url}");
    }
    println!(
        "\n{inserted} item(s) queued in {}.\nReview with `zyquor outreach review`.",
        db_path.display()
    );
    println!("Nothing was posted. No X job was created.");
    Ok(0)
}

fn validate_draft(
    draft: &DraftInput,
    candidate: &Candidate,
    profile: &Profile,
) -> Result<(), String> {
    let text = draft.text.trim();
    if text.len() < 120 || text.len() > 4000 {
        return Err(format!(
            "{}: text is {} chars; want 120–4000",
            draft.candidate_id,
            text.len()
        ));
    }
    if draft.hypothesis.trim().len() < 20 {
        return Err(format!(
            "{}: hypothesis must be one sentence (20+ chars)",
            draft.candidate_id
        ));
    }
    let lower = text.to_lowercase();
    if lower.starts_with("great question")
        || lower.starts_with("hey op")
        || lower.starts_with("this is a great")
        || lower.starts_with("totally agree")
    {
        return Err(format!(
            "{}: opener reads like a template",
            draft.candidate_id
        ));
    }
    let urls = text.matches("http://").count() + text.matches("https://").count();
    if urls > 1 {
        return Err(format!(
            "{}: {} URLs; one link maximum",
            draft.candidate_id, urls
        ));
    }
    let repo_link = format!("github.com/{}", profile.repo);
    let has_repo = lower.contains(&repo_link.to_lowercase());
    let discloses = lower.contains("i built")
        || lower.contains("i wrote")
        || lower.contains("i'm the author")
        || lower.contains("i am the author")
        || lower.contains("my repo")
        || lower.contains("i made");
    if has_repo && !discloses {
        return Err(format!(
            "{}: repo link present but no disclosure (\"I built it\")",
            draft.candidate_id
        ));
    }
    if urls == 1 && !has_repo {
        return Err(format!(
            "{}: the one link is not the repo {}",
            draft.candidate_id, profile.repo
        ));
    }
    if candidate.existing_answer {
        return Err(format!(
            "{}: the repo is already mentioned in this thread",
            draft.candidate_id
        ));
    }
    if candidate.age_hours > QUEUE_AGE_HOURS {
        return Err(format!(
            "{}: thread is {:.0}h old; queue only threads under {:.0}h",
            draft.candidate_id, candidate.age_hours, QUEUE_AGE_HOURS
        ));
    }
    if !candidate.queueable {
        return Err(format!(
            "{}: candidate is not queueable ({})",
            draft.candidate_id,
            candidate.reasons.join("; ")
        ));
    }
    Ok(())
}

fn review(args: &[String]) -> Result<i32, String> {
    let repo_root = crate::cli::repo_root();
    let data_root = repo_root.join("data").join("outreach");
    let db_path = data_root.join("outreach.sqlite");
    if !db_path.is_file() {
        return Err(format!(
            "no queue at {}; run `zyquor outreach queue` first",
            db_path.display()
        ));
    }
    let connection = open_queue(&db_path)?;
    let only = flag_value(args, "--id");
    let mut statement = connection
        .prepare(
            "SELECT id, platform, subreddit, thread_url, thread_title, comment_url,
                    parent_author, parent_text, rules_json, removals_json, hypothesis,
                    text, utm_url, status
             FROM outreach_items
             WHERE status = 'queued'
             ORDER BY queued_at ASC",
        )
        .map_err(|error| format!("prepare review: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
                row.get::<_, String>(12)?,
            ))
        })
        .map_err(|error| format!("query review: {error}"))?;
    let mut items = Vec::new();
    for row in rows {
        let item = row.map_err(|error| format!("read review row: {error}"))?;
        if only.as_deref().is_some_and(|id| id != item.0) {
            continue;
        }
        items.push(item);
    }
    if items.is_empty() {
        println!("No queued outreach items.");
        return Ok(0);
    }

    let mut markdown = String::from("# Outreach review queue\n\n");
    markdown.push_str(
        "Every item is manual. No autoposting, no alt accounts, no engagement loops.\n\n",
    );
    for (index, item) in items.iter().enumerate() {
        let rules: RulesInfo = serde_json::from_str(&item.8).unwrap_or_default();
        let removals: RemovalsInfo = serde_json::from_str(&item.9).unwrap_or_default();
        markdown.push_str(&format!(
            "## {}. {} — {}\n\n",
            index + 1,
            item.2.as_deref().unwrap_or(&item.1),
            item.5
        ));
        markdown.push_str(&format!("- id: `{}`\n", item.0));
        markdown.push_str(&format!("- thread: {}\n", item.3));
        markdown.push_str(&format!("- thread title: {}\n", item.4));
        markdown.push_str(&format!("- reply target: {}\n", item.5));
        markdown.push_str(&format!("- parent author: u/{}\n", item.6));
        markdown.push_str(&format!(
            "- removals: {}/{} (locked: {}, mod sticky: {})\n",
            removals.removed, removals.total, removals.locked, removals.mod_sticky
        ));
        markdown.push_str(&format!("- self-promo rule: {}\n", rules.self_promo));
        markdown.push_str(&format!("- hypothesis: {}\n\n", item.10));
        markdown.push_str("Parent comment:\n\n> ");
        markdown.push_str(&item.7.replace('\n', "\n> "));
        markdown.push_str("\n\nReply:\n\n> ");
        markdown.push_str(&item.11.replace('\n', "\n> "));
        markdown.push_str("\n\nLink: ");
        markdown.push_str(&item.12);
        markdown.push_str("\n\nBefore sending:\n\n");
        markdown.push_str("- [ ] Read the full thread and the parent comment in context.\n");
        markdown.push_str("- [ ] Confirm the subreddit rules still match the excerpt above.\n");
        markdown.push_str("- [ ] Keep the disclosure; keep exactly one link.\n");
        markdown.push_str("- [ ] Send manually, then record the URL:\n");
        markdown.push_str(&format!(
            "  `zyquor outreach mark-sent --id {} --url <comment-url>`\n\n",
            item.0
        ));
        markdown.push_str("---\n\n");
    }
    let path = data_root.join("review.md");
    fs::write(&path, &markdown).map_err(|error| format!("write {}: {error}", path.display()))?;
    println!("{markdown}");
    println!("Review file: {}", path.display());
    Ok(0)
}

fn list(_args: &[String]) -> Result<i32, String> {
    let repo_root = crate::cli::repo_root();
    let db_path = repo_root
        .join("data")
        .join("outreach")
        .join("outreach.sqlite");
    if !db_path.is_file() {
        println!("No outreach queue yet.");
        return Ok(0);
    }
    let connection = open_queue(&db_path)?;
    let mut statement = connection
        .prepare("SELECT status, COUNT(*) FROM outreach_items GROUP BY status")
        .map_err(|error| format!("prepare list: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .map_err(|error| format!("query list: {error}"))?;
    for row in rows {
        let (status, count) = row.map_err(|error| format!("read list row: {error}"))?;
        println!("{status}: {count}");
    }
    Ok(0)
}

fn mark_sent(args: &[String]) -> Result<i32, String> {
    let repo_root = crate::cli::repo_root();
    let db_path = repo_root
        .join("data")
        .join("outreach")
        .join("outreach.sqlite");
    let id = flag_value(args, "--id").ok_or_else(|| "--id is required".to_string())?;
    let url = flag_value(args, "--url").ok_or_else(|| "--url is required".to_string())?;
    if !url.starts_with("https://www.reddit.com/")
        && !url.starts_with("https://reddit.com/")
        && !url.starts_with("https://news.ycombinator.com/")
    {
        return Err("--url must be a reddit.com or news.ycombinator.com comment URL".to_string());
    }
    let connection = open_queue(&db_path)?;
    let changed = connection
        .execute(
            "UPDATE outreach_items SET status='sent', sent_at=?, sent_url=?, survived='unknown' WHERE id=? AND status='queued'",
            params![Utc::now().to_rfc3339(), url, id],
        )
        .map_err(|error| format!("mark sent: {error}"))?;
    if changed == 0 {
        return Err(format!("no queued item with id {id}"));
    }
    println!("marked {id} sent: {url}");
    Ok(0)
}

fn skip(args: &[String]) -> Result<i32, String> {
    let repo_root = crate::cli::repo_root();
    let db_path = repo_root
        .join("data")
        .join("outreach")
        .join("outreach.sqlite");
    let id = flag_value(args, "--id").ok_or_else(|| "--id is required".to_string())?;
    let reason = flag_value(args, "--reason").unwrap_or_else(|| "skipped".to_string());
    let connection = open_queue(&db_path)?;
    let changed = connection
        .execute(
            "UPDATE outreach_items SET status='skipped', sent_at=NULL, survived=? WHERE id=? AND status='queued'",
            params![format!("skipped: {reason}"), id],
        )
        .map_err(|error| format!("skip: {error}"))?;
    if changed == 0 {
        return Err(format!("no queued item with id {id}"));
    }
    println!("skipped {id}: {reason}");
    Ok(0)
}

async fn verify(args: &[String]) -> Result<i32, String> {
    let _ = args;
    let repo_root = crate::cli::repo_root();
    let db_path = repo_root
        .join("data")
        .join("outreach")
        .join("outreach.sqlite");
    let items: Vec<(String, String, String)> = {
        let connection = open_queue(&db_path)?;
        let mut statement = connection
            .prepare("SELECT id, platform, sent_url FROM outreach_items WHERE status='sent'")
            .map_err(|error| format!("prepare verify: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })
            .map_err(|error| format!("query verify: {error}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|error| format!("read verify row: {error}"))?);
        }
        out
    };
    if items.is_empty() {
        println!("No sent items to verify.");
        return Ok(0);
    }
    let client = reqwest::Client::builder()
        .user_agent("Zyquor-Outreach/0.1")
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| format!("http client: {error}"))?;
    let connection = open_queue(&db_path)?;
    let now = Utc::now().to_rfc3339();
    for (id, platform, url) in items {
        let state = if platform == "hackernews" {
            verify_hn(&client, &url).await
        } else {
            verify_reddit(&client, &url).await
        };
        connection
            .execute(
                "UPDATE outreach_items SET survived=?, checked_at=? WHERE id=?",
                params![state, now, id],
            )
            .map_err(|error| format!("update verify: {error}"))?;
        println!("{id}: {state} — {url}");
    }
    Ok(0)
}

async fn verify_hn(client: &reqwest::Client, url: &str) -> String {
    let Some(id) = url
        .split("id=")
        .nth(1)
        .and_then(|value| value.split('&').next())
    else {
        return "unknown".to_string();
    };
    let url = format!("{HN_ITEM}/{id}.json");
    match get_json(client, &url).await {
        Ok(value) => {
            if value
                .get("deleted")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || value.get("dead").and_then(Value::as_bool).unwrap_or(false)
            {
                "removed".to_string()
            } else if value.get("text").is_some() {
                "alive".to_string()
            } else {
                "unknown".to_string()
            }
        }
        Err(_) => "unknown".to_string(),
    }
}

async fn verify_reddit(client: &reqwest::Client, url: &str) -> String {
    let segments: Vec<&str> = url
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let Some(id) = segments.last().copied() else {
        return "unknown".to_string();
    };
    let url = format!("{ARCTIC}/api/comments/ids?ids={id}");
    match get_json(client, &url).await {
        Ok(value) => {
            let Some(row) = value
                .get("data")
                .and_then(Value::as_array)
                .and_then(|rows| rows.first())
            else {
                return "removed-or-not-indexed".to_string();
            };
            let body = row.get("body").and_then(Value::as_str).unwrap_or("");
            if body == "[removed]"
                || body == "[deleted]"
                || row
                    .get("removed_by_category")
                    .is_some_and(|value| !value.is_null())
            {
                "removed".to_string()
            } else {
                "alive".to_string()
            }
        }
        Err(_) => "unknown".to_string(),
    }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

fn open_queue(path: &Path) -> Result<Connection, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("create queue dir {}: {error}", parent.display()))?;
    }
    let connection =
        Connection::open(path).map_err(|error| format!("open {}: {error}", path.display()))?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS outreach_items (
               id TEXT PRIMARY KEY NOT NULL,
               run_id TEXT NOT NULL,
               repo TEXT NOT NULL,
               platform TEXT NOT NULL,
               subreddit TEXT,
               thread_url TEXT NOT NULL,
               thread_title TEXT,
               comment_url TEXT NOT NULL,
               parent_author TEXT,
               parent_text TEXT,
               rules_json TEXT NOT NULL DEFAULT '{}',
               removals_json TEXT NOT NULL DEFAULT '{}',
               candidate_json TEXT NOT NULL DEFAULT '{}',
               hypothesis TEXT NOT NULL,
               text TEXT NOT NULL,
               utm_url TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'queued',
               queued_at TEXT NOT NULL,
               sent_at TEXT,
               sent_url TEXT,
               survived TEXT,
               checked_at TEXT
             );",
        )
        .map_err(|error| format!("create outreach table: {error}"))?;
    Ok(connection)
}

fn flag_value(args: &[String], name: &str) -> Option<String> {
    args.iter()
        .position(|arg| arg == name)
        .and_then(|index| args.get(index + 1))
        .filter(|value| !value.starts_with("--"))
        .cloned()
}

fn has_flag(args: &[String], name: &str) -> bool {
    args.iter().any(|arg| arg == name)
}

fn resolve_path(root: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
}

fn age_hours(published: Option<&str>) -> f64 {
    let Some(published) = published else {
        return 9999.0;
    };
    match DateTime::parse_from_rfc3339(published) {
        Ok(instant) => {
            let seconds = (Utc::now() - instant.with_timezone(&Utc)).num_seconds();
            (seconds as f64 / 3600.0).max(0.0)
        }
        Err(_) => 9999.0,
    }
}

fn stable_id(value: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in value.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn truncate(value: &str, max: usize) -> String {
    let mut chars = value.chars();
    let truncated: String = chars.by_ref().take(max).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn url_encode(value: &str) -> String {
    zyquor_adapters::encode_uri_component(value)
}

fn reddit_link_id(url: &str) -> Option<String> {
    let segments: Vec<&str> = url
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    let position = segments.iter().position(|segment| *segment == "comments")?;
    segments.get(position + 1).map(|value| (*value).to_string())
}

fn utm_url(profile: &Profile, platform: &str, content: &str) -> String {
    let source = match platform {
        "hackernews" => "news.ycombinator.com",
        _ => "reddit.com",
    };
    let campaign = if profile.utm.campaign.is_empty() {
        "threads"
    } else {
        &profile.utm.campaign
    };
    format!(
        "https://github.com/{}?utm_source={}&utm_medium=comment&utm_campaign={}&utm_content={}",
        profile.repo,
        url_encode(source),
        url_encode(campaign),
        url_encode(content)
    )
}

async fn hn_story(client: &reqwest::Client, id: i64) -> Option<Value> {
    get_json(client, &format!("{HN_ITEM}/{id}.json")).await.ok()
}

async fn get_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let response = client
        .get(url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {}",
            status.as_u16(),
            truncate(&body, 180)
        ));
    }
    serde_json::from_str(&body).map_err(|error| format!("invalid JSON: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> Profile {
        Profile {
            repo: "haroon0x/herald".to_string(),
            name: "Herald".to_string(),
            one_liner: "local-first mail".to_string(),
            pains: Vec::new(),
            keywords: Vec::new(),
            pain_groups: Vec::new(),
            exact_pains: Vec::new(),
            title_keywords: Vec::new(),
            title_groups: Vec::new(),
            reddit_queries: Vec::new(),
            hn_queries: Vec::new(),
            utm: Utm {
                campaign: "test".to_string(),
            },
            voice: String::new(),
            link_policy: String::new(),
        }
    }

    #[test]
    fn every_pain_group_must_match() {
        let groups = vec![
            vec!["email".to_string(), "mail".to_string()],
            vec!["agent".to_string(), "draft".to_string()],
        ];
        assert!(pain_group_match("email agent", &groups));
        assert!(!pain_group_match("email only", &groups));
        assert!(pain_group_match("anything", &[]));
    }

    #[test]
    fn news_threads_are_not_advice_threads() {
        assert!(is_news_thread(
            "Outlook.com is rejecting email from domains"
        ));
        assert!(is_news_thread(
            "Google says new Australian internet safety bill"
        ));
        assert!(!is_news_thread(
            "which model would you use to manage your gmail inbox?"
        ));
    }

    #[test]
    fn utm_link_carries_the_campaign() {
        let link = utm_url(&profile(), "reddit", "thread-1");
        assert!(link.contains("utm_source=reddit.com"));
        assert!(link.contains("utm_campaign=test"));
        assert!(link.contains("utm_content=thread-1"));
    }

    #[test]
    fn html_is_unescaped_for_review() {
        assert_eq!(clean_html("<p>hello &amp; goodbye</p>"), "hello & goodbye");
    }

    #[test]
    fn finds_target_and_counts_an_existing_answer() {
        let tree = json!({
            "data": [{
                "kind": "t1",
                "data": {
                    "id": "target",
                    "body": "parent comment",
                    "replies": {
                        "data": {
                            "children": [{
                                "kind": "t1",
                                "data": {
                                    "id": "reply",
                                    "score": 2,
                                    "body": "if the model only has permission to apply labels, the worst a prompt injection can do is mislabel a thread"
                                }
                            }]
                        }
                    }
                }
            }]
        });
        let target = find_comment_node(&tree, "target");
        assert!(target.is_some());
        let replies = target
            .and_then(|node| node.get("data"))
            .and_then(|data| data.get("replies"));
        assert!(replies.is_some());
        if let Some(replies) = replies {
            let (count, answered) = count_comment_replies(replies);
            assert_eq!(count, 1);
            assert!(answered);
        }
    }
}
