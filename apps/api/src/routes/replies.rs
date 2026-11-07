//! Reply routes, ported from `apps/api/src/routes/replies.ts`.

use std::collections::{HashMap, HashSet};

use axum::{
    Json, Router,
    extract::{Query, State},
    http::StatusCode,
    routing::{get, post},
};
use serde_json::{Map, Value, json};

use crate::errors::{ApiError, HttpError, Issue};
use crate::post_process::trace_post_process_tweet_text;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/replies/feed", get(feed))
        .route("/replies/from-url", post(from_url))
        .route("/replies/mentions", get(mentions))
        .route("/replies/mentions/draft", post(mentions_draft))
        .route("/replies/mentions/scan-and-draft", post(scan_and_draft))
        .route(
            "/replies/mentions/scan-and-auto-approve",
            post(scan_and_auto_approve),
        )
        .route("/replies/drafts", get(reply_drafts))
}

fn api_error_message(error: &ApiError) -> String {
    match error {
        ApiError::Invalid { message, .. } => message.clone(),
        ApiError::Http(error) => error.message.clone(),
        ApiError::Conflict(message) => message.clone(),
        ApiError::Generation(message) => message.clone(),
        ApiError::Internal(message) => message.clone(),
    }
}

const MENTION_FRESH_WINDOW_MS: i64 = 48 * 60 * 60 * 1000;
const MAX_SCANNED_MENTIONS: usize = 50;
const MAX_DRAFT_MENTIONS_PER_CALL: usize = 10;
const MAX_REPLY_SOURCE: usize = 2_500;
const MEMORY_FETCH_TIMEOUT_MS: u64 = 10_000;
const DEFAULT_AUTO_APPROVE_DAILY_CAP: i64 = 3;
const MAX_AUTO_APPROVE_DAILY_CAP: i64 = 50;

fn mentions_auto_approve_daily_cap() -> i64 {
    let configured = std::env::var("ZYQUOR_MENTIONS_AUTO_APPROVE_DAILY_CAP").ok();
    let value = configured
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .and_then(|text| text.parse::<f64>().ok());
    match value {
        Some(parsed) if parsed.is_finite() => {
            (parsed.floor() as i64).clamp(0, MAX_AUTO_APPROVE_DAILY_CAP)
        }
        _ => DEFAULT_AUTO_APPROVE_DAILY_CAP,
    }
}

fn is_same_local_day(iso: Option<&str>, reference: chrono::DateTime<chrono::Utc>) -> bool {
    let Some(iso) = iso else { return false };
    if iso.is_empty() {
        return false;
    }
    let Ok(parsed) = chrono::DateTime::parse_from_rfc3339(iso) else {
        return false;
    };
    let local = parsed.with_timezone(&chrono::Local);
    let reference_local = reference.with_timezone(&chrono::Local);
    local.format("%Y-%m-%d").to_string() == reference_local.format("%Y-%m-%d").to_string()
}

fn is_ad_post(is_promoted: Option<bool>, has_link: Option<bool>) -> bool {
    is_promoted == Some(true) || has_link == Some(true)
}

fn target_from_tweet(tweet: &zyquor_browser::XFeedTweet) -> zyquor_core::ReplyTarget {
    zyquor_core::ReplyTarget {
        tweet_id: tweet.id.clone(),
        author_handle: tweet.author_handle.clone(),
        url: tweet.url.clone(),
        author_name: Some(tweet.author_name.clone()),
        text: Some(tweet.text.clone()),
    }
}

fn truncated_reply_source(mut reply_to: zyquor_core::ReplyTarget) -> zyquor_core::ReplyTarget {
    if let Some(text) = reply_to.text.clone() {
        if text.len() > MAX_REPLY_SOURCE {
            let truncated: String = text
                .chars()
                .take(MAX_REPLY_SOURCE)
                .collect::<String>()
                .trim_end()
                .to_string();
            reply_to.text = Some(format!("{truncated}…"));
        }
    }
    reply_to
}

fn status_key(url: &str) -> String {
    let mut value = url.trim_end_matches('/').to_string();
    // Case-insensitive replacements mirror the TS `statusKey`.
    let lower = value.to_lowercase();
    if lower.starts_with("https://twitter.com/") {
        value = format!("https://x.com/{}", &value["https://twitter.com/".len()..]);
    } else if lower.starts_with("http://") {
        value = format!("https:{}", &value["http://".len()..]);
    }
    value
}

fn resolve_profile_dir(profile_dir: &str) -> String {
    let path = std::path::Path::new(profile_dir);
    if path.is_absolute() {
        profile_dir.to_string()
    } else {
        zyquor_core::paths::resolve_data_root()
            .join(profile_dir)
            .to_string_lossy()
            .to_string()
    }
}

fn account_id_from_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        _ => "account_personal".to_string(),
    }
}

struct AccountProfile {
    account_id: String,
    profile_dir: String,
    style_profile_id: Option<String>,
    profile_cdp_url: String,
    action_delay_ms: Option<u64>,
}

async fn account_profile(state: &AppState, account_id: &str) -> Result<AccountProfile, ApiError> {
    let repository = state.repository();
    let account = repository.get_account(account_id).await?;
    let Some(account) = account else {
        return Err(ApiError::Http(HttpError::new(404, "Account not found")));
    };
    zyquor_accounts::assert_dedicated_profile_dir(&account.profile_dir)
        .map_err(|error| ApiError::Http(HttpError::new(409, error.to_string())))?;
    let profile_dir = resolve_profile_dir(&account.profile_dir);
    let (cdp_base, action_delay_ms) = {
        let browser = state
            .browser
            .lock()
            .map_err(|_| ApiError::Internal("browser mutex poisoned".to_string()))?;
        (browser.cdp_url.clone(), browser.action_delay_ms)
    };
    let profile_cdp_url =
        zyquor_core::paths::per_profile_cdp_url(cdp_base.as_deref(), &account.profile_dir);
    Ok(AccountProfile {
        account_id: account.id.clone(),
        profile_dir,
        style_profile_id: Some(account.style_profile_id.clone()),
        profile_cdp_url,
        action_delay_ms,
    })
}

async fn browser_session(profile: &AccountProfile) -> Result<zyquor_browser::Session, String> {
    let launched =
        zyquor_browser::ensure_browser_cdp(&profile.profile_cdp_url, &profile.profile_dir).await;
    if !launched {
        return Err(format!(
            "Could not launch Chrome at {}",
            profile.profile_cdp_url
        ));
    }
    zyquor_browser::Session::connect(&profile.profile_cdp_url).await
}

fn feed_input(
    profile: &AccountProfile,
    max_tweets: usize,
    min_tweets: Option<usize>,
    scrolls: usize,
) -> zyquor_browser::FeedFetchInput {
    zyquor_browser::FeedFetchInput {
        profile_dir: profile.profile_dir.clone(),
        cdp_url: profile.profile_cdp_url.clone(),
        max_tweets: Some(max_tweets),
        min_tweets,
        scrolls: Some(scrolls),
        action_delay_ms: profile.action_delay_ms,
        artifacts_dir: None,
        x_home_url: None,
        mentions_url: None,
    }
}

struct FreshMentions {
    mentions: Vec<zyquor_browser::XFeedTweet>,
    ads_skipped: usize,
    scanned: usize,
}

async fn fetch_fresh_mentions(
    profile: &AccountProfile,
    max_tweets: usize,
) -> Result<FreshMentions, String> {
    let session = browser_session(profile).await?;
    let input = feed_input(profile, max_tweets.min(MAX_SCANNED_MENTIONS), None, 4);
    let result = zyquor_browser::fetch_x_mentions(&session, &input).await?;
    let scanned_total = result.tweets.len();
    let cutoff = chrono::Utc::now().timestamp_millis() - MENTION_FRESH_WINDOW_MS;
    let mut seen: HashSet<String> = HashSet::new();
    let mut mentions = Vec::new();
    let mut ads_skipped = 0usize;
    for tweet in result.tweets {
        if tweet.is_promoted == Some(true) {
            ads_skipped += 1;
            continue;
        }
        if seen.contains(&tweet.url) {
            continue;
        }
        seen.insert(tweet.url.clone());
        let published_millis = tweet
            .published_at
            .as_deref()
            .and_then(|text| {
                chrono::DateTime::parse_from_rfc3339(text)
                    .map(|parsed| parsed.timestamp_millis())
                    .ok()
            })
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        if published_millis < cutoff {
            continue;
        }
        mentions.push(tweet);
    }
    Ok(FreshMentions {
        mentions,
        ads_skipped,
        scanned: scanned_total,
    })
}

async fn reply_memory_default(
    repository: &crate::state::Repository,
    style_profile_id: Option<&str>,
) -> Result<bool, ApiError> {
    let Some(style_profile_id) = style_profile_id else {
        return Ok(true);
    };
    let profile = repository.get_style_profile(style_profile_id).await?;
    let reply_memory = profile
        .as_ref()
        .and_then(|profile| profile.rules.get("replyMemory"))
        .cloned();
    Ok(!matches!(reply_memory, Some(Value::Bool(false))))
}

#[derive(Debug, Clone)]
struct ReplyMemorySelection {
    used: bool,
    reason: Option<&'static str>,
    terms: Vec<String>,
    wiki: Vec<zyquor_adapters::GoldfishContextWiki>,
    memories: Vec<zyquor_adapters::GoldfishContextMemory>,
}

impl ReplyMemorySelection {
    fn new(used: bool, reason: Option<&'static str>) -> Self {
        Self {
            used,
            reason,
            terms: Vec::new(),
            wiki: Vec::new(),
            memories: Vec::new(),
        }
    }
}

async fn resolve_reply_memory(
    author_handle: Option<String>,
    author_name: Option<String>,
    tweet_text: Option<String>,
    use_memory: bool,
    max_memories: Option<usize>,
) -> ReplyMemorySelection {
    if !use_memory {
        return ReplyMemorySelection::new(false, Some("disabled"));
    }
    let input = zyquor_adapters::GoldfishContextInput {
        author_handle,
        author_name,
        tweet_text,
        max_wiki: None,
        max_memories,
    };
    let bundle = tokio::time::timeout(
        std::time::Duration::from_millis(MEMORY_FETCH_TIMEOUT_MS),
        zyquor_adapters::fetch_goldfish_reply_context(input),
    )
    .await
    .ok()
    .flatten();
    let Some(bundle) = bundle else {
        return ReplyMemorySelection::new(false, Some("unavailable"));
    };
    if bundle.wiki.is_empty() && bundle.memories.is_empty() {
        return ReplyMemorySelection::new(false, Some("empty"));
    }
    ReplyMemorySelection {
        used: true,
        reason: None,
        terms: bundle.terms.clone(),
        wiki: bundle.wiki.clone(),
        memories: bundle.memories.clone(),
    }
}

fn memory_metadata(selection: &ReplyMemorySelection) -> Option<Map<String, Value>> {
    if !selection.used {
        return None;
    }
    let wiki_titles: Vec<Value> = selection
        .wiki
        .iter()
        .map(|item| Value::String(item.title.clone()))
        .collect();
    let memory_titles: Vec<Value> = selection
        .memories
        .iter()
        .map(|item| Value::String(item.title.clone()))
        .collect();
    if wiki_titles.is_empty() && memory_titles.is_empty() {
        return None;
    }
    let mut map = Map::new();
    map.insert(
        "terms".to_string(),
        Value::Array(
            selection
                .terms
                .iter()
                .map(|term| Value::String(term.clone()))
                .collect(),
        ),
    );
    map.insert("wikiTitles".to_string(), Value::Array(wiki_titles.clone()));
    map.insert("memories".to_string(), Value::Array(memory_titles.clone()));
    map.insert(
        "wikiCount".to_string(),
        Value::from(wiki_titles.len() as i64),
    );
    map.insert(
        "memoryCount".to_string(),
        Value::from(memory_titles.len() as i64),
    );
    Some(map)
}

fn memory_response(selection: &ReplyMemorySelection) -> Value {
    if selection.used {
        json!({
            "used": true,
            "terms": selection.terms,
            "wikiCount": selection.wiki.len(),
            "memoryCount": selection.memories.len(),
        })
    } else {
        json!({"used": false, "reason": selection.reason.unwrap_or("unavailable")})
    }
}

async fn mint_reply_metadata(
    repository: &crate::state::Repository,
    style_profile_id: Option<&str>,
    reply_to: &zyquor_core::ReplyTarget,
    base_metadata: Map<String, Value>,
    use_memory: Option<bool>,
    max_memories: Option<usize>,
) -> Result<(Map<String, Value>, ReplyMemorySelection), ApiError> {
    let use_memory_effective = match use_memory {
        Some(value) => value,
        None => reply_memory_default(repository, style_profile_id).await?,
    };
    let memory = resolve_reply_memory(
        Some(reply_to.author_handle.clone()),
        reply_to.author_name.clone(),
        reply_to.text.clone(),
        use_memory_effective,
        max_memories,
    )
    .await;
    let mut metadata = base_metadata;
    if let Some(memory_value) = memory_metadata(&memory) {
        metadata.insert("memory".to_string(), Value::Object(memory_value));
    }
    Ok((metadata, memory))
}

async fn account_context(
    repository: &crate::state::Repository,
    account_id: &str,
) -> Result<zyquor_automation::AccountGenerationContext, ApiError> {
    let account_id = account_id.to_string();
    repository
        .call(move |repo| {
            zyquor_automation::account_generation_context(repo, &account_id).map_err(|error| {
                match error {
                    zyquor_automation::AutomationError::Storage(inner) => inner,
                    other => zyquor_storage::StorageError::Invalid(other.to_string()),
                }
            })
        })
        .await
        .map_err(ApiError::from)
}

fn features_value(text: &str) -> Value {
    let features = zyquor_automation::analyze_post_features(text);
    json!({
        "chars": features.chars,
        "words": features.words,
        "hasDigits": features.has_digits,
        "endsWithQuestion": features.ends_with_question,
        "linkCount": features.link_count,
        "hashtagCount": features.hashtag_count,
        "opener": features.opener,
    })
}

#[allow(clippy::too_many_arguments)]
async fn create_reply_draft(
    state: &AppState,
    account_id: &str,
    reply_to: zyquor_core::ReplyTarget,
    base_metadata: Map<String, Value>,
    use_memory: Option<bool>,
    style_profile_id: Option<&str>,
    max_memories: Option<usize>,
    other_replies: Option<Vec<String>>,
) -> Result<(zyquor_storage::DraftWithCandidates, ReplyMemorySelection), ApiError> {
    let repository = state.repository();
    let (metadata, memory) = mint_reply_metadata(
        &repository,
        style_profile_id,
        &reply_to,
        base_metadata.clone(),
        use_memory,
        max_memories,
    )
    .await?;
    let created = repository
        .create_draft(zyquor_storage::NewDraft {
            account_id: account_id.to_string(),
            source_input: reply_to
                .text
                .clone()
                .unwrap_or_else(|| reply_to.url.clone()),
            candidates: Vec::new(),
            reply_to: Some(reply_to.clone()),
            reply_to_url: None,
            metadata,
        })
        .await?;
    let context = account_context(&repository, account_id).await?;
    let candidate_count = {
        let count = base_metadata
            .get("count")
            .and_then(Value::as_f64)
            .unwrap_or(1.0);
        (count as i64).clamp(1, 3) as usize
    };
    let mut input = zyquor_generation::types::GenerateDraftCandidatesInput {
        idea: created.draft.source_input.clone(),
        count: Some(candidate_count),
        preserve_case: true,
        banned_phrases: context.banned_phrases.clone(),
        example_posts: context.example_posts.clone(),
        objective: context.objective.clone(),
        system_prompt_extra: context.system_prompt_extra.clone(),
        system_feedback: context.system_feedback.clone(),
        tone: context.tone.clone(),
        account_knowledge: context.account_knowledge.clone(),
        recent_post_history: context.recent_post_history.clone(),
        tweet_type: Some(
            zyquor_automation::normalize_tweet_type("reply")
                .as_str()
                .to_string(),
        ),
        reply_context: Some(zyquor_generation::types::ReplyContext {
            author_handle: reply_to.author_handle.clone(),
            url: reply_to.url.clone(),
            author_name: reply_to.author_name.clone(),
            text: reply_to.text.clone(),
            other_replies: other_replies.clone().unwrap_or_default(),
        }),
        ..Default::default()
    };
    if memory.used {
        let bundle = zyquor_adapters::GoldfishContextBundle {
            terms: memory.terms.clone(),
            wiki: memory.wiki.clone(),
            memories: memory.memories.clone(),
        };
        let rendered = zyquor_adapters::render_goldfish_memory(&bundle);
        if !rendered.is_empty() {
            input.memory_context = Some(rendered);
        }
    }
    let generated = state
        .generation_provider
        .generate_draft_candidates(&input)
        .await
        .map_err(ApiError::from)?;
    let new_candidates: Vec<zyquor_storage::NewCandidate> = generated
        .into_iter()
        .map(|candidate| {
            let mut score = Map::new();
            score.insert(
                "provider".to_string(),
                Value::String(candidate.provider.clone()),
            );
            score.insert("model".to_string(), Value::String(candidate.model.clone()));
            score.insert("rank".to_string(), Value::from(candidate.rank as i64));
            score.insert("quality".to_string(), Value::from(candidate.quality));
            zyquor_storage::NewCandidate {
                text: candidate.text.clone(),
                score,
            }
        })
        .collect();
    let updated = repository
        .save_draft_candidates(&created.draft.id, new_candidates)
        .await?;
    Ok((updated, memory))
}

fn drafted_url_set(drafts: &[zyquor_storage::Draft]) -> HashSet<String> {
    let mut urls = HashSet::new();
    for draft in drafts {
        if let Some(reply_to) = &draft.reply_to {
            urls.insert(status_key(&reply_to.url));
        }
    }
    urls
}

fn is_valid_url(value: &str) -> bool {
    url::Url::parse(value).is_ok()
}

async fn feed(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let account_id = account_id_from_value(
        query
            .get("accountId")
            .map(|text| Value::String(text.clone()))
            .as_ref(),
    );
    let profile = account_profile(&state, &account_id).await?;
    match browser_session(&profile).await {
        Ok(session) => {
            let input = feed_input(&profile, 30, Some(5), 4);
            match zyquor_browser::fetch_x_home_feed(&session, &input).await {
                Ok(result) => {
                    let mut seen: HashSet<String> = HashSet::new();
                    let mut accounts: Vec<Value> = Vec::new();
                    let mut account_keys: HashSet<String> = HashSet::new();
                    let mut ads_skipped = 0usize;
                    let mut tweets = Vec::new();
                    for tweet in result.tweets.iter() {
                        if is_ad_post(tweet.is_promoted, tweet.has_link) {
                            ads_skipped += 1;
                            continue;
                        }
                        if seen.contains(&tweet.url) {
                            continue;
                        }
                        seen.insert(tweet.url.clone());
                        let key = format!("@{}", tweet.author_handle);
                        if !account_keys.contains(&key) {
                            account_keys.insert(key);
                            accounts.push(json!({"authorHandle": tweet.author_handle, "authorName": tweet.author_name}));
                        }
                        tweets.push(tweet_to_value(tweet));
                    }
                    Ok(Json(json!({
                        "url": result.url,
                        "tweets": tweets,
                        "accounts": accounts,
                        "adsSkipped": ads_skipped,
                    })))
                }
                Err(error) => Err(ApiError::Http(HttpError::new(502, error))),
            }
        }
        Err(error) => Err(ApiError::Http(HttpError::new(502, error))),
    }
}

fn tweet_to_value(tweet: &zyquor_browser::XFeedTweet) -> Value {
    json!({
        "id": tweet.id,
        "authorHandle": tweet.author_handle,
        "authorName": tweet.author_name,
        "text": tweet.text,
        "url": tweet.url,
        "publishedAt": tweet.published_at,
        "isRetweet": tweet.is_retweet,
        "isPromoted": tweet.is_promoted.unwrap_or(false),
        "hasLink": tweet.has_link.unwrap_or(false),
    })
}

struct FromUrlInput {
    account_id: String,
    url: String,
    use_memory: Option<bool>,
    count: Option<usize>,
}

fn parse_from_url(value: &Value) -> Result<FromUrlInput, ApiError> {
    let obj = value.as_object().ok_or_else(|| {
        ApiError::invalid_with_issues(vec![Issue {
            path: String::new(),
            message: "expected an object".to_string(),
        }])
    })?;
    let mut issues = Vec::new();
    let account_id = match obj.get("accountId") {
        None => "account_personal".to_string(),
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            String::new()
        }
        Some(_) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let url = match obj.get("url") {
        Some(Value::String(text)) => {
            if is_valid_url(text) {
                text.clone()
            } else {
                issues.push(Issue {
                    path: "url".to_string(),
                    message: "Invalid url".to_string(),
                });
                String::new()
            }
        }
        Some(_) => {
            issues.push(Issue {
                path: "url".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
        None => {
            issues.push(Issue {
                path: "url".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let use_memory = match obj.get("useMemory") {
        None => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => {
            issues.push(Issue {
                path: "useMemory".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    let count = match obj.get("count") {
        None => None,
        Some(Value::Number(number)) => match number.as_i64() {
            Some(value)
                if number.as_f64().is_some_and(|f| f.fract() == 0.0)
                    && (1..=50).contains(&value) =>
            {
                Some(value as usize)
            }
            _ => {
                issues.push(Issue {
                    path: "count".to_string(),
                    message: "Number must be an integer between 1 and 50".to_string(),
                });
                None
            }
        },
        Some(_) => {
            issues.push(Issue {
                path: "count".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    if issues.is_empty() {
        Ok(FromUrlInput {
            account_id,
            url,
            use_memory,
            count,
        })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

async fn from_url(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let input = parse_from_url(&body)?;
    if zyquor_core::parse_reply_target_url(&input.url).is_none() {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "url must be a valid x.com or twitter.com post URL"})),
        ));
    }
    let profile = account_profile(&state, &input.account_id).await?;
    let session = match browser_session(&profile).await {
        Ok(session) => session,
        Err(error) => {
            return Ok((StatusCode::BAD_GATEWAY, Json(json!({"error": error}))));
        }
    };
    let fetched =
        match zyquor_browser::fetch_tweet(&session, &input.url, profile.action_delay_ms, Some(6))
            .await
        {
            Ok(fetched) => fetched,
            Err(error) => {
                return Ok((StatusCode::BAD_GATEWAY, Json(json!({"error": error}))));
            }
        };
    if is_ad_post(fetched.tweet.is_promoted, fetched.tweet.has_link) {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(
                json!({"error": "That post looks like an advertisement (it is tagged as promoted or contains a link). Nothing to reply to."}),
            ),
        ));
    }
    let reply_to = truncated_reply_source(target_from_tweet(&fetched.tweet));
    let mut other_replies: Vec<String> = Vec::new();
    let mut seen_reply_text: HashSet<String> = HashSet::new();
    if let Some(replies) = fetched.replies {
        for reply in replies {
            if other_replies.len() >= 6 {
                break;
            }
            if reply.is_promoted == Some(true) {
                continue;
            }
            let collapsed: String = reply.text.split_whitespace().collect::<Vec<_>>().join(" ");
            let text: String = collapsed.chars().take(220).collect();
            if text.len() < 8 {
                continue;
            }
            if (text.contains("http://") || text.contains("https://")) && text.len() < 80 {
                continue;
            }
            if seen_reply_text.contains(&text) {
                continue;
            }
            seen_reply_text.insert(text.clone());
            other_replies.push(text);
        }
    }
    let repository = state.repository();
    if !reply_to.url.is_empty()
        && repository
            .has_post_history_source_url(&profile.account_id, &reply_to.url)
            .await?
    {
        return Ok((
            StatusCode::CONFLICT,
            Json(json!({"error": "This tweet was already posted to in the past"})),
        ));
    }
    let mut base_metadata = Map::new();
    base_metadata.insert("yolo".to_string(), Value::Bool(false));
    base_metadata.insert("autopost".to_string(), Value::Bool(false));
    base_metadata.insert(
        "count".to_string(),
        Value::from(input.count.unwrap_or(1) as i64),
    );
    base_metadata.insert("tweetType".to_string(), Value::String("reply".to_string()));
    base_metadata.insert(
        "sourceReplies".to_string(),
        Value::from(other_replies.len() as i64),
    );
    let other = if other_replies.is_empty() {
        None
    } else {
        Some(other_replies.clone())
    };
    let (updated, memory) = create_reply_draft(
        &state,
        &profile.account_id,
        reply_to.clone(),
        base_metadata,
        input.use_memory,
        profile.style_profile_id.as_deref(),
        None,
        other,
    )
    .await?;
    let mut response = json!({
        "draft": updated.draft,
        "candidates": updated.candidates,
        "replyTo": reply_to,
        "memory": memory_response(&memory),
    });
    if !other_replies.is_empty() {
        response["otherReplies"] = Value::Array(
            other_replies
                .iter()
                .map(|text| Value::String(text.clone()))
                .collect(),
        );
    }
    Ok((StatusCode::CREATED, Json(response)))
}

struct MentionsQuery {
    account_id: Option<String>,
    max_tweets: usize,
}

fn parse_mentions_query(query: &HashMap<String, String>) -> Result<MentionsQuery, ApiError> {
    let mut issues = Vec::new();
    let account_id = query.get("accountId").cloned();
    if let Some(value) = &account_id {
        if value.is_empty() {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
        }
    }
    let max_tweets = match query.get("maxTweets") {
        None => 30,
        Some(text) => {
            let parsed: f64 = text.trim().parse().unwrap_or(f64::NAN);
            if parsed.is_finite() && parsed.fract() == 0.0 && (1..=50).contains(&(parsed as i64)) {
                parsed as usize
            } else {
                issues.push(Issue {
                    path: "maxTweets".to_string(),
                    message: "Number must be an integer between 1 and 50".to_string(),
                });
                30
            }
        }
    };
    if issues.is_empty() {
        Ok(MentionsQuery {
            account_id,
            max_tweets,
        })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

async fn mentions(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let parsed = parse_mentions_query(&query)?;
    let account_id = account_id_from_value(parsed.account_id.map(Value::String).as_ref());
    let profile = account_profile(&state, &account_id).await?;
    let scan = match fetch_fresh_mentions(&profile, parsed.max_tweets).await {
        Ok(scan) => scan,
        Err(error) => {
            return Err(ApiError::Http(HttpError::new(502, error)));
        }
    };
    let repository = state.repository();
    let drafted = drafted_url_set(&repository.list_drafts(Some(&account_id)).await?);
    let mut annotated = Vec::new();
    for item in &scan.mentions {
        let posted = repository
            .has_post_history_source_url(&account_id, &item.url)
            .await?;
        let drafted_flag = !posted && drafted.contains(&status_key(&item.url));
        annotated.push(json!({
            "id": item.id,
            "authorHandle": item.author_handle,
            "authorName": item.author_name,
            "text": item.text,
            "url": item.url,
            "publishedAt": item.published_at,
            "isRetweet": item.is_retweet,
            "isPromoted": item.is_promoted.unwrap_or(false),
            "hasLink": item.has_link.unwrap_or(false),
            "drafted": drafted_flag,
            "posted": posted,
        }));
    }
    Ok(Json(
        json!({"mentions": annotated, "scanned": scan.scanned, "adsSkipped": scan.ads_skipped}),
    ))
}

struct MentionsDraftInput {
    account_id: String,
    mentions: Vec<String>,
    use_memory: Option<bool>,
}

fn parse_mentions_draft(value: &Value) -> Result<MentionsDraftInput, ApiError> {
    let obj = value.as_object().ok_or_else(|| {
        ApiError::invalid_with_issues(vec![Issue {
            path: String::new(),
            message: "expected an object".to_string(),
        }])
    })?;
    let mut issues = Vec::new();
    let account_id = match obj.get("accountId") {
        None => "account_personal".to_string(),
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            String::new()
        }
        Some(_) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let mentions = match obj.get("mentions") {
        Some(Value::Array(items)) => {
            if items.is_empty() || items.len() > 10 {
                issues.push(Issue {
                    path: "mentions".to_string(),
                    message: "Array must contain between 1 and 10 item(s)".to_string(),
                });
            }
            let mut out = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let Some(map) = item.as_object() else {
                    issues.push(Issue {
                        path: format!("mentions.{index}"),
                        message: "Required".to_string(),
                    });
                    continue;
                };
                match map.get("url") {
                    Some(Value::String(text)) if is_valid_url(text) => out.push(text.clone()),
                    Some(Value::String(_)) => issues.push(Issue {
                        path: format!("mentions.{index}.url"),
                        message: "Invalid url".to_string(),
                    }),
                    Some(_) => issues.push(Issue {
                        path: format!("mentions.{index}.url"),
                        message: "Required".to_string(),
                    }),
                    None => issues.push(Issue {
                        path: format!("mentions.{index}.url"),
                        message: "Required".to_string(),
                    }),
                }
            }
            out
        }
        Some(_) => {
            issues.push(Issue {
                path: "mentions".to_string(),
                message: "Required".to_string(),
            });
            Vec::new()
        }
        None => {
            issues.push(Issue {
                path: "mentions".to_string(),
                message: "Required".to_string(),
            });
            Vec::new()
        }
    };
    let use_memory = match obj.get("useMemory") {
        None => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => {
            issues.push(Issue {
                path: "useMemory".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    if issues.is_empty() {
        Ok(MentionsDraftInput {
            account_id,
            mentions,
            use_memory,
        })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

async fn mentions_draft(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let input = parse_mentions_draft(&body)?;
    let profile = account_profile(&state, &input.account_id).await?;
    let repository = state.repository();
    let mut by_url: HashMap<String, zyquor_browser::XFeedTweet> = HashMap::new();
    // The scan is an optimization: without it each requested tweet is fetched individually below.
    if let Ok(session) = browser_session(&profile).await {
        let scan_input = feed_input(&profile, MAX_SCANNED_MENTIONS, None, 4);
        if let Ok(scan) = zyquor_browser::fetch_x_mentions(&session, &scan_input).await {
            for tweet in scan.tweets {
                by_url.insert(status_key(&tweet.url), tweet);
            }
        }
    }
    let mut drafted = drafted_url_set(&repository.list_drafts(Some(&input.account_id)).await?);
    let mut created = Vec::new();
    let mut skipped = Vec::new();
    for url in &input.mentions {
        let key = status_key(url);
        if repository
            .has_post_history_source_url(&input.account_id, &key)
            .await?
        {
            skipped.push(json!({"url": url, "reason": "posted"}));
            continue;
        }
        if drafted.contains(&key) {
            skipped.push(json!({"url": url, "reason": "drafted"}));
            continue;
        }
        let tweet = if let Some(tweet) = by_url.get(&key) {
            Some(tweet.clone())
        } else {
            if zyquor_core::parse_reply_target_url(url).is_none() {
                skipped.push(json!({"url": url, "reason": "unavailable"}));
                continue;
            }
            match browser_session(&profile).await {
                Ok(session) => {
                    match zyquor_browser::fetch_tweet(&session, url, profile.action_delay_ms, None)
                        .await
                    {
                        Ok(fetched) => Some(fetched.tweet),
                        Err(_) => {
                            skipped.push(json!({"url": url, "reason": "unavailable"}));
                            continue;
                        }
                    }
                }
                Err(_) => {
                    skipped.push(json!({"url": url, "reason": "unavailable"}));
                    continue;
                }
            }
        };
        let Some(tweet) = tweet else {
            skipped.push(json!({"url": url, "reason": "unavailable"}));
            continue;
        };
        if tweet.is_promoted == Some(true) {
            skipped.push(json!({"url": url, "reason": "promoted"}));
            continue;
        }
        let reply_to = truncated_reply_source(target_from_tweet(&tweet));
        let mut base_metadata = Map::new();
        base_metadata.insert("yolo".to_string(), Value::Bool(false));
        base_metadata.insert("autopost".to_string(), Value::Bool(false));
        base_metadata.insert("count".to_string(), Value::from(1));
        base_metadata.insert("tweetType".to_string(), Value::String("reply".to_string()));
        base_metadata.insert(
            "origin".to_string(),
            Value::String("mention-scan".to_string()),
        );
        base_metadata.insert(
            "authorHandle".to_string(),
            Value::String(reply_to.author_handle.clone()),
        );
        let (updated, _) = create_reply_draft(
            &state,
            &input.account_id,
            reply_to,
            base_metadata,
            input.use_memory,
            profile.style_profile_id.as_deref(),
            None,
            None,
        )
        .await?;
        created.push(json!({"draft": updated.draft, "candidates": updated.candidates}));
        drafted.insert(key);
    }
    Ok(Json(json!({"created": created, "skipped": skipped})))
}

struct ScanDraftInput {
    account_id: String,
    max_tweets: usize,
    use_memory: Option<bool>,
}

fn parse_scan_draft(value: &Value) -> Result<ScanDraftInput, ApiError> {
    let obj = value.as_object().ok_or_else(|| {
        ApiError::invalid_with_issues(vec![Issue {
            path: String::new(),
            message: "expected an object".to_string(),
        }])
    })?;
    let mut issues = Vec::new();
    let account_id = match obj.get("accountId") {
        None => "account_personal".to_string(),
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            String::new()
        }
        Some(_) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let max_tweets = match obj.get("maxTweets") {
        None => 30,
        Some(Value::Number(number)) => match number.as_i64() {
            Some(value)
                if number.as_f64().is_some_and(|f| f.fract() == 0.0)
                    && (1..=50).contains(&value) =>
            {
                value as usize
            }
            _ => {
                issues.push(Issue {
                    path: "maxTweets".to_string(),
                    message: "Number must be an integer between 1 and 50".to_string(),
                });
                30
            }
        },
        Some(_) => {
            issues.push(Issue {
                path: "maxTweets".to_string(),
                message: "Required".to_string(),
            });
            30
        }
    };
    let use_memory = match obj.get("useMemory") {
        None => None,
        Some(Value::Bool(value)) => Some(*value),
        Some(_) => {
            issues.push(Issue {
                path: "useMemory".to_string(),
                message: "Required".to_string(),
            });
            None
        }
    };
    if issues.is_empty() {
        Ok(ScanDraftInput {
            account_id,
            max_tweets,
            use_memory,
        })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

async fn scan_and_draft(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let input = parse_scan_draft(&body)?;
    let profile = account_profile(&state, &input.account_id).await?;
    let repository = state.repository();
    let scan = match fetch_fresh_mentions(&profile, input.max_tweets).await {
        Ok(scan) => scan,
        Err(error) => {
            return Err(ApiError::Http(HttpError::new(502, error)));
        }
    };
    let mut drafted = drafted_url_set(&repository.list_drafts(Some(&input.account_id)).await?);
    let mut created = Vec::new();
    let mut skipped = Vec::new();
    for item in &scan.mentions {
        if created.len() >= MAX_DRAFT_MENTIONS_PER_CALL {
            break;
        }
        let key = status_key(&item.url);
        if repository
            .has_post_history_source_url(&input.account_id, &key)
            .await?
        {
            skipped.push(json!({"url": item.url, "reason": "posted"}));
            continue;
        }
        if drafted.contains(&key) {
            skipped.push(json!({"url": item.url, "reason": "drafted"}));
            continue;
        }
        let reply_to = truncated_reply_source(target_from_tweet(item));
        let mut base_metadata = Map::new();
        base_metadata.insert("yolo".to_string(), Value::Bool(false));
        base_metadata.insert("autopost".to_string(), Value::Bool(false));
        base_metadata.insert("count".to_string(), Value::from(1));
        base_metadata.insert("tweetType".to_string(), Value::String("reply".to_string()));
        base_metadata.insert(
            "origin".to_string(),
            Value::String("mention-scan".to_string()),
        );
        base_metadata.insert(
            "authorHandle".to_string(),
            Value::String(reply_to.author_handle.clone()),
        );
        let (updated, _) = create_reply_draft(
            &state,
            &input.account_id,
            reply_to,
            base_metadata,
            input.use_memory,
            profile.style_profile_id.as_deref(),
            None,
            None,
        )
        .await?;
        created.push(json!({"draft": updated.draft, "candidates": updated.candidates}));
        drafted.insert(key);
    }
    Ok(Json(json!({
        "scanned": scan.scanned,
        "created": created,
        "skipped": skipped,
        "adsSkipped": scan.ads_skipped,
    })))
}

struct ScanAutoApproveInput {
    account_id: String,
    max_tweets: usize,
}

fn parse_scan_auto_approve(value: &Value) -> Result<ScanAutoApproveInput, ApiError> {
    let obj = value.as_object().ok_or_else(|| {
        ApiError::invalid_with_issues(vec![Issue {
            path: String::new(),
            message: "expected an object".to_string(),
        }])
    })?;
    let mut issues = Vec::new();
    let account_id = match obj.get("accountId") {
        None => "account_personal".to_string(),
        Some(Value::String(text)) if !text.is_empty() => text.clone(),
        Some(Value::String(_)) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "String must contain at least 1 character(s)".to_string(),
            });
            String::new()
        }
        Some(_) => {
            issues.push(Issue {
                path: "accountId".to_string(),
                message: "Required".to_string(),
            });
            String::new()
        }
    };
    let max_tweets = match obj.get("maxTweets") {
        None => 30,
        Some(Value::Number(number)) => match number.as_i64() {
            Some(value)
                if number.as_f64().is_some_and(|f| f.fract() == 0.0)
                    && (1..=50).contains(&value) =>
            {
                value as usize
            }
            _ => {
                issues.push(Issue {
                    path: "maxTweets".to_string(),
                    message: "Number must be an integer between 1 and 50".to_string(),
                });
                30
            }
        },
        Some(_) => {
            issues.push(Issue {
                path: "maxTweets".to_string(),
                message: "Required".to_string(),
            });
            30
        }
    };
    if issues.is_empty() {
        Ok(ScanAutoApproveInput {
            account_id,
            max_tweets,
        })
    } else {
        Err(ApiError::invalid_with_issues(issues))
    }
}

async fn scan_and_auto_approve(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let input = parse_scan_auto_approve(&body)?;
    let profile = account_profile(&state, &input.account_id).await?;
    let repository = state.repository();
    let scan = match fetch_fresh_mentions(&profile, input.max_tweets).await {
        Ok(scan) => scan,
        Err(error) => {
            return Err(ApiError::Http(HttpError::new(502, error)));
        }
    };
    let daily_cap = mentions_auto_approve_daily_cap();
    let drafts = repository.list_drafts(Some(&input.account_id)).await?;
    let auto_approved_draft_ids: HashSet<String> = drafts
        .iter()
        .filter(|draft| matches!(draft.metadata.get("autoApproved"), Some(Value::Bool(true))))
        .map(|draft| draft.id.clone())
        .collect();
    let jobs = repository
        .list_jobs(Some(&input.account_id), None, None)
        .await?;
    let now = chrono::Utc::now();
    let approved_today: HashSet<String> = jobs
        .iter()
        .filter(|job| {
            auto_approved_draft_ids.contains(&job.draft_id)
                && is_same_local_day(job.approved_at.as_deref(), now)
        })
        .map(|job| job.draft_id.clone())
        .collect();
    let approved_today_count = approved_today.len() as i64;
    let mut remaining_today = (daily_cap - approved_today_count).max(0);

    let mut drafted = drafted_url_set(&drafts);
    let mut created = Vec::new();
    let mut approved = Vec::new();
    let mut held = Vec::new();
    let mut skipped = Vec::new();
    let quality_min = state.automation_deps.quality_min;

    for item in &scan.mentions {
        let key = status_key(&item.url);
        if repository
            .has_post_history_source_url(&input.account_id, &key)
            .await?
        {
            skipped.push(json!({"url": item.url, "reason": "posted"}));
            continue;
        }
        if drafted.contains(&key) {
            skipped.push(json!({"url": item.url, "reason": "drafted"}));
            continue;
        }
        let reply_to = truncated_reply_source(target_from_tweet(item));
        let mut base_metadata = Map::new();
        base_metadata.insert("yolo".to_string(), Value::Bool(false));
        base_metadata.insert("autopost".to_string(), Value::Bool(false));
        base_metadata.insert("count".to_string(), Value::from(1));
        base_metadata.insert("tweetType".to_string(), Value::String("reply".to_string()));
        base_metadata.insert(
            "origin".to_string(),
            Value::String("mention-scan".to_string()),
        );
        base_metadata.insert(
            "authorHandle".to_string(),
            Value::String(reply_to.author_handle.clone()),
        );
        let updated = match create_reply_draft(
            &state,
            &input.account_id,
            reply_to.clone(),
            base_metadata,
            Some(true),
            profile.style_profile_id.as_deref(),
            Some(0),
            None,
        )
        .await
        {
            Ok((updated, _)) => updated,
            Err(error) => {
                held.push(json!({"url": item.url, "reason": format!("draft_failed: {}", api_error_message(&error))}));
                continue;
            }
        };
        created.push(json!({"draft": updated.draft, "candidates": updated.candidates}));
        drafted.insert(key.clone());

        let Some(selected) = updated
            .candidates
            .iter()
            .find(|candidate| candidate.selected)
            .cloned()
        else {
            held.push(json!({"url": item.url, "reason": "no_candidates"}));
            continue;
        };
        let preserve_case = selected
            .score
            .get("provider")
            .and_then(Value::as_str)
            .is_some_and(|provider| provider == state.generation_provider_name());
        let approved_text =
            trace_post_process_tweet_text("mentions-auto-approve", &selected.text, preserve_case);
        if zyquor_generation::is_interrogation_dodge_reply(&approved_text) {
            held.push(json!({"url": item.url, "reason": zyquor_generation::REPLY_DODGE_REASON}));
            continue;
        }
        if !zyquor_generation::passes_tweet_quality_floor(&approved_text, quality_min) {
            held.push(json!({"url": item.url, "reason": "quality_below_floor"}));
            continue;
        }
        if approved_text.len() > 275 {
            held.push(json!({"url": item.url, "reason": format!("too_long: {} chars", approved_text.len())}));
            continue;
        }
        if remaining_today <= 0 {
            held.push(json!({"url": item.url, "reason": "daily_cap_reached"}));
            continue;
        }
        let mut new_metadata = updated.draft.metadata.clone();
        new_metadata.insert("features".to_string(), features_value(&approved_text));
        new_metadata.insert("autoApproved".to_string(), Value::Bool(true));
        if let Err(error) = repository
            .update_draft_metadata(&updated.draft.id, new_metadata)
            .await
        {
            held.push(json!({"url": item.url, "reason": format!("approve_failed: {error}")}));
            continue;
        }
        match repository
            .approve_draft(zyquor_storage::ApproveDraft {
                draft_id: updated.draft.id.clone(),
                edited_text: approved_text.clone(),
                mode: Some(zyquor_core::types::PostingMode::ReviewRequired),
                scheduled_for: None,
                reply_to: updated.draft.reply_to.clone(),
                reply_to_url: None,
            })
            .await
        {
            Ok((draft, _job)) => {
                approved.push(json!({
                    "url": item.url,
                    "draftId": draft.id,
                    "text": draft.edited_text.clone().unwrap_or_else(|| approved_text.clone()),
                }));
                remaining_today -= 1;
            }
            Err(error) => {
                held.push(json!({"url": item.url, "reason": format!("approve_failed: {error}")}));
            }
        }
    }

    Ok(Json(json!({
        "scanned": scan.scanned,
        "created": created,
        "approved": approved,
        "held": held,
        "skipped": skipped,
        "adsSkipped": scan.ads_skipped,
        "dailyCap": daily_cap,
        "remainingToday": remaining_today.max(0),
    })))
}

async fn reply_drafts(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let account_id = account_id_from_value(
        query
            .get("accountId")
            .map(|text| Value::String(text.clone()))
            .as_ref(),
    );
    let repository = state.repository();
    let drafts: Vec<_> = repository
        .list_drafts(Some(&account_id))
        .await?
        .into_iter()
        .filter(|draft| draft.reply_to.is_some())
        .collect();
    Ok(Json(json!({"drafts": drafts})))
}
