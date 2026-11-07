//! Goldfish reply-context lookup, ported from
//! `packages/adapters/src/goldfish-context.ts`.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, OnceLock};

use indexmap::IndexMap;

use serde_json::Map;

use crate::goldfish::call_goldfish_tool;

#[derive(Debug, Clone, Default)]
pub struct GoldfishContextInput {
    pub author_handle: Option<String>,
    pub author_name: Option<String>,
    pub tweet_text: Option<String>,
    pub max_wiki: Option<usize>,
    pub max_memories: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct GoldfishContextWiki {
    pub slug: String,
    pub title: String,
    pub kind: String,
    pub summary: String,
}

#[derive(Debug, Clone, Default)]
pub struct GoldfishContextMemory {
    pub app: String,
    pub captured_at: String,
    pub title: String,
    pub excerpt: String,
}

#[derive(Debug, Clone, Default)]
pub struct GoldfishContextBundle {
    pub terms: Vec<String>,
    pub wiki: Vec<GoldfishContextWiki>,
    pub memories: Vec<GoldfishContextMemory>,
}

const WIKI_LIMIT: usize = 4;
const MEMORY_LIMIT: usize = 5;
const DEFAULT_MAX_WIKI: usize = 2;
const DEFAULT_MAX_MEMORIES: usize = 3;
const KEYWORD_LIMIT: usize = 4;
const TERM_LIMIT: usize = 6;
const WIKI_SUMMARY_CAP: usize = 300;
const MEMORY_EXCERPT_CAP: usize = 280;
const RENDER_CAP: usize = 1600;
const CONTEXT_CACHE_TTL_MS: i64 = 10 * 60 * 1000;
const CONTEXT_CACHE_MISS_TTL_MS: i64 = 60 * 1000;
const CONTEXT_CACHE_LIMIT: usize = 50;

const STOPWORDS: &[&str] = &[
    "about", "after", "again", "also", "been", "before", "being", "between", "both", "com",
    "could", "does", "done", "down", "each", "even", "every", "from", "have", "here", "http",
    "https", "into", "just", "like", "made", "make", "many", "more", "most", "much", "must",
    "never", "only", "other", "over", "same", "should", "since", "some", "still", "such", "than",
    "that", "their", "them", "then", "there", "these", "they", "this", "those", "through", "under",
    "until", "very", "were", "what", "when", "where", "which", "while", "with", "will", "would",
    "www", "your",
];

fn normalize_handle(value: Option<&str>) -> String {
    value
        .unwrap_or("")
        .trim()
        .trim_start_matches('@')
        .to_string()
}

fn keywords_from_text(text: Option<&str>) -> Vec<String> {
    let stopwords: HashSet<&str> = STOPWORDS.iter().copied().collect();
    let mut keywords: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for token in text
        .unwrap_or("")
        .to_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 4)
        .filter(|token| !token.chars().all(|c| c.is_ascii_digit()))
        .filter(|token| !stopwords.contains(token))
    {
        if seen.contains(token) {
            continue;
        }
        seen.insert(token.to_string());
        keywords.push(token.to_string());
        if keywords.len() >= KEYWORD_LIMIT {
            break;
        }
    }
    keywords
}

/// `deriveGoldfishTerms` from `goldfish-context.ts`.
pub fn derive_goldfish_terms(input: &GoldfishContextInput) -> Vec<String> {
    let mut terms: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut push = |value: Option<&str>| {
        let term = value.unwrap_or("").trim().to_string();
        if term.is_empty() {
            return;
        }
        let key = term.to_lowercase();
        if seen.contains(&key) || terms.len() >= TERM_LIMIT {
            return;
        }
        seen.insert(key);
        terms.push(term);
    };

    let handle = normalize_handle(input.author_handle.as_deref());
    push(Some(&handle));
    let name = input
        .author_name
        .clone()
        .unwrap_or_default()
        .trim()
        .to_string();
    if !name.is_empty() && name.to_lowercase() != handle.to_lowercase() {
        push(Some(&name));
    }
    for keyword in keywords_from_text(input.tweet_text.as_deref()) {
        push(Some(&keyword));
    }
    terms
}

fn as_record(value: &serde_json::Value) -> Option<Map<String, serde_json::Value>> {
    value.as_object().cloned()
}

fn list_from(result: &serde_json::Value) -> Vec<serde_json::Value> {
    if result.is_array() {
        return result.as_array().cloned().unwrap_or_default();
    }
    let Some(record) = as_record(result) else {
        return Vec::new();
    };
    for key in ["results", "pages", "items"] {
        if let Some(serde_json::Value::Array(list)) = record.get(key) {
            return list.clone();
        }
    }
    Vec::new()
}

fn text_field(record: &Map<String, serde_json::Value>, keys: &[&str]) -> String {
    for key in keys {
        match record.get(*key) {
            Some(serde_json::Value::String(text)) if !text.trim().is_empty() => {
                return text.trim().to_string();
            }
            Some(serde_json::Value::Number(number))
                if number.as_f64().is_some_and(f64::is_finite) =>
            {
                return number.to_string();
            }
            _ => {}
        }
    }
    String::new()
}

fn map_wiki_results(result: &serde_json::Value, limit: usize) -> Vec<GoldfishContextWiki> {
    if limit == 0 {
        return Vec::new();
    }
    let mut items = Vec::new();
    for raw in list_from(result) {
        let Some(record) = as_record(&raw) else {
            continue;
        };
        let title = text_field(&record, &["title", "name", "slug"]);
        let summary = text_field(&record, &["summary", "description"])
            .chars()
            .take(WIKI_SUMMARY_CAP)
            .collect::<String>();
        if title.is_empty() || summary.is_empty() {
            continue;
        }
        items.push(GoldfishContextWiki {
            slug: {
                let slug = text_field(&record, &["slug", "id"]);
                if slug.is_empty() { title.clone() } else { slug }
            },
            title,
            kind: {
                let kind = text_field(&record, &["type", "kind"]);
                if kind.is_empty() {
                    "topic".to_string()
                } else {
                    kind
                }
            },
            summary,
        });
        if items.len() >= limit {
            break;
        }
    }
    items
}

fn map_memory_results(result: &serde_json::Value, limit: usize) -> Vec<GoldfishContextMemory> {
    if limit == 0 {
        return Vec::new();
    }
    let mut items = Vec::new();
    for raw in list_from(result) {
        let Some(record) = as_record(&raw) else {
            continue;
        };
        let excerpt = text_field(&record, &["content_excerpt", "content", "excerpt"])
            .chars()
            .take(MEMORY_EXCERPT_CAP)
            .collect::<String>();
        if excerpt.is_empty() {
            continue;
        }
        items.push(GoldfishContextMemory {
            app: {
                let app = text_field(&record, &["app", "domain"]);
                if app.is_empty() {
                    "unknown".to_string()
                } else {
                    app
                }
            },
            captured_at: text_field(&record, &["captured_at", "capturedAt"]),
            title: {
                let title = text_field(&record, &["window_title", "title"]);
                if title.is_empty() {
                    excerpt.chars().take(80).collect::<String>()
                } else {
                    title
                }
            },
            excerpt,
        });
        if items.len() >= limit {
            break;
        }
    }
    items
}

/// LRU cache of resolved bundles (+ recent nulls), keyed by normalized
/// handle + terms.
static CACHE: OnceLock<Mutex<ContextCacheSharedState>> = OnceLock::new();

#[derive(Debug)]
struct ContextCacheSharedState {
    entries: IndexMap<String, (Option<Arc<GoldfishContextBundle>>, i64)>,
}

fn cache() -> &'static Mutex<ContextCacheSharedState> {
    CACHE.get_or_init(|| {
        Mutex::new(ContextCacheSharedState {
            entries: IndexMap::new(),
        })
    })
}

pub fn clear_goldfish_context_cache() {
    if let Ok(mut guard) = cache().lock() {
        guard.entries.clear();
    }
}

fn context_cache_key(input: &GoldfishContextInput) -> String {
    let handle = normalize_handle(input.author_handle.as_deref()).to_lowercase();
    let terms: Vec<String> = derive_goldfish_terms(input)
        .iter()
        .map(|term| term.to_lowercase())
        .collect();
    // Limits are part of the key: a wiki-only lookup (maxMemories 0) must never
    // hit a cached bundle that still carries activity memories.
    serde_json::to_string(&(handle, terms, input.max_wiki, input.max_memories)).unwrap_or_default()
}

fn cached_bundle(key: &str) -> Option<Option<Arc<GoldfishContextBundle>>> {
    let mut cache = cache().lock().ok()?;
    let (value, expires_at) = cache.entries.get(key)?.clone();
    if chrono::Utc::now().timestamp_millis() >= expires_at {
        cache.entries.shift_remove(key);
        return None;
    }
    // Refresh insertion order so the LRU cap evicts the oldest entry.
    cache.entries.shift_remove(key);
    cache
        .entries
        .insert(key.to_string(), (value.clone(), expires_at));
    Some(value)
}

fn store_bundle(key: String, value: Option<Arc<GoldfishContextBundle>>) {
    let now = chrono::Utc::now().timestamp_millis();
    let ttl_ms = if value.is_none() {
        CONTEXT_CACHE_MISS_TTL_MS
    } else {
        CONTEXT_CACHE_TTL_MS
    };
    let Ok(mut cache) = cache().lock() else {
        return;
    };
    if cache.entries.len() >= CONTEXT_CACHE_LIMIT {
        cache.entries.shift_remove_index(0);
    }
    cache.entries.insert(key, (value, now + ttl_ms));
}

pub async fn fetch_goldfish_reply_context(
    input: GoldfishContextInput,
) -> Option<Arc<GoldfishContextBundle>> {
    let key = context_cache_key(&input);
    if let Some(cached) = cached_bundle(&key) {
        return cached;
    }

    let terms = derive_goldfish_terms(&input);
    let wiki_limit = input.max_wiki.unwrap_or(DEFAULT_MAX_WIKI);
    let memory_limit = input.max_memories.unwrap_or(DEFAULT_MAX_MEMORIES);

    let wiki_query = if wiki_limit > 0 {
        let name = input
            .author_name
            .clone()
            .unwrap_or_default()
            .trim()
            .to_string();
        if !name.is_empty() {
            name
        } else {
            normalize_handle(input.author_handle.as_deref())
        }
    } else {
        String::new()
    };
    let memory_query = if memory_limit > 0 {
        terms.join(" ")
    } else {
        String::new()
    };

    let wiki_future = async {
        if wiki_query.is_empty() {
            return Err(crate::types::AdapterError::new(
                "goldfish wiki query unavailable",
            ));
        }
        let mut params = Map::new();
        params.insert("query".to_string(), serde_json::Value::String(wiki_query));
        params.insert(
            "limit".to_string(),
            serde_json::Value::from(WIKI_LIMIT as i64),
        );
        call_goldfish_tool("search_wiki", &params).await
    };
    let memory_future = async {
        if memory_query.is_empty() {
            return Err(crate::types::AdapterError::new(
                "goldfish memory query unavailable",
            ));
        }
        let mut params = Map::new();
        params.insert("query".to_string(), serde_json::Value::String(memory_query));
        params.insert(
            "limit".to_string(),
            serde_json::Value::from(MEMORY_LIMIT as i64),
        );
        call_goldfish_tool("search_memory", &params).await
    };

    let (wiki_result, memory_result) = futures::future::join(wiki_future, memory_future).await;

    if wiki_result.is_err() && memory_result.is_err() {
        store_bundle(key, None);
        return None;
    }

    let bundle = GoldfishContextBundle {
        terms,
        wiki: wiki_result
            .as_ref()
            .map(|value| map_wiki_results(value, input.max_wiki.unwrap_or(DEFAULT_MAX_WIKI)))
            .unwrap_or_default(),
        memories: memory_result
            .as_ref()
            .map(|value| {
                map_memory_results(value, input.max_memories.unwrap_or(DEFAULT_MAX_MEMORIES))
            })
            .unwrap_or_default(),
    };
    let bundle = Arc::new(bundle);
    store_bundle(key, Some(bundle.clone()));
    Some(bundle)
}

/// `renderGoldfishMemory` from `goldfish-context.ts`.
pub fn render_goldfish_memory(bundle: &GoldfishContextBundle) -> String {
    if bundle.wiki.is_empty() && bundle.memories.is_empty() {
        return String::new();
    }
    let mut lines = vec!["Personal memory from the account owner's own machine:".to_string()];
    for item in &bundle.wiki {
        lines.push(format!(
            "- Wiki [{}] {}: {}",
            item.kind, item.title, item.summary
        ));
    }
    for item in &bundle.memories {
        lines.push(format!(
            "- Activity ({}, {}): {}: {}",
            item.app, item.captured_at, item.title, item.excerpt
        ));
    }

    let mut kept: Vec<String> = Vec::new();
    let mut length = 0_usize;
    for line in lines {
        let projected = if kept.is_empty() {
            line.len()
        } else {
            length + 1 + line.len()
        };
        if projected > RENDER_CAP {
            break;
        }
        length = projected;
        kept.push(line);
    }
    kept.join("\n")
}
