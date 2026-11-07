//! Account generation context, ported from `context.ts`'s
//! `accountGenerationContext`.

use serde_json::Value;
use zyquor_generation::types::AccountKnowledgeEntry;
use zyquor_storage::SqliteRepository;

use crate::AutomationError;

#[derive(Debug, Clone, Default)]
pub struct AccountGenerationContext {
    pub banned_phrases: Vec<String>,
    pub example_posts: Vec<String>,
    pub objective: Option<String>,
    pub system_prompt_extra: Option<String>,
    pub system_feedback: Vec<String>,
    pub tone: Option<String>,
    pub account_knowledge: Vec<AccountKnowledgeEntry>,
    pub recent_post_history: Vec<String>,
}

const KNOWLEDGE_ENTRY_LIMIT: usize = 24;

fn parse_millis(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|dt| dt.timestamp_millis())
        .ok()
}

fn enabled_knowledge(
    repository: &SqliteRepository,
    account_id: &str,
) -> Result<Vec<AccountKnowledgeEntry>, AutomationError> {
    let entries = repository.list_knowledge_entries(account_id)?;
    Ok(entries
        .into_iter()
        .filter(|entry| entry.enabled)
        .take(KNOWLEDGE_ENTRY_LIMIT)
        .map(|entry| AccountKnowledgeEntry {
            kind: entry.kind,
            title: entry.title,
            content: entry.content,
        })
        .collect())
}

pub fn account_generation_context(
    repository: &SqliteRepository,
    account_id: &str,
) -> Result<AccountGenerationContext, AutomationError> {
    let account = repository.get_account(account_id)?;
    let style_profile = match &account {
        Some(account) => repository.get_style_profile(&account.style_profile_id)?,
        None => None,
    };

    let (banned_phrases, example_posts, objective, system_prompt_extra, tone) = match &style_profile
    {
        Some(profile) => (
            profile.banned_phrases.clone(),
            profile.example_posts.clone(),
            profile
                .rules
                .get("objective")
                .and_then(Value::as_str)
                .map(str::to_string),
            profile
                .rules
                .get("systemPromptExtra")
                .and_then(Value::as_str)
                .map(str::to_string),
            profile.tone.clone(),
        ),
        None => (Vec::new(), Vec::new(), None, None, None),
    };

    let history = repository.list_post_history()?;
    let mut history_sorted: Vec<(i64, String)> = history
        .into_iter()
        .filter(|item| item.account_id == account_id)
        .filter_map(|item| {
            let posted_at = parse_millis(&item.posted_at)?;
            Some((posted_at, item.posted_text))
        })
        .collect();
    // Newest first.
    history_sorted.sort_by_key(|(posted_at, _)| std::cmp::Reverse(*posted_at));
    let recent_post_history: Vec<String> = history_sorted
        .into_iter()
        .take(10)
        .map(|(_, text)| text)
        .collect();

    let system_feedback: Vec<String> = repository
        .list_system_feedback(account_id)?
        .into_iter()
        .take(5)
        .map(|item| item.text)
        .collect();
    let account_knowledge = enabled_knowledge(repository, account_id)?;

    Ok(AccountGenerationContext {
        banned_phrases,
        example_posts,
        objective,
        system_prompt_extra,
        system_feedback,
        tone,
        account_knowledge,
        recent_post_history,
    })
}
