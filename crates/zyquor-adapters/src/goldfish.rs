//! Goldfish personal-memory MCP adapter, ported from
//! `packages/adapters/src/goldfish.ts`.
//!
//! Spawns the `goldfish-mcp` MCP server over stdio and speaks JSON-RPC to it.
//! The server binary is a Windows `.exe`; on other platforms TypeScript
//! invokes it through `powershell.exe`, which is preserved here.

use std::process::Stdio;
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::types::{
    AdapterError, AdapterFuture, AdapterResult, ConfigMetadata, SourceAdapter, SourceItem,
};

fn default_windows_mcp_path() -> String {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        if !local_app_data.is_empty() {
            return format!("{local_app_data}\\Goldfish\\goldfish-mcp.exe");
        }
    }
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        if !user_profile.is_empty() {
            return format!("{user_profile}\\AppData\\Local\\Goldfish\\goldfish-mcp.exe");
        }
    }
    "goldfish-mcp.exe".to_string()
}

pub fn goldfish_mcp_command() -> Vec<String> {
    #[cfg(windows)]
    {
        vec![default_windows_mcp_path()]
    }
    #[cfg(not(windows))]
    {
        vec![
            "powershell.exe".to_string(),
            "-NoProfile".to_string(),
            "-Command".to_string(),
            default_windows_mcp_path(),
        ]
    }
}

const MCP_TIMEOUT: Duration = Duration::from_millis(15_000);

/// Spawn the MCP server, issue `initialize` + one `tools/call`, and return the
/// parsed result (structured content, parsed text content, or raw text).
pub async fn call_goldfish_tool(tool: &str, params: &Map<String, Value>) -> AdapterResult<Value> {
    let command = goldfish_mcp_command();
    let args: Vec<String> = command.iter().skip(1).cloned().collect();

    let mut process = Command::new(&command[0]);
    process
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut child = process
        .spawn()
        .map_err(|error| AdapterError::new(error.to_string()))?;

    let payload_lines = [
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2025-03-26", "capabilities": {} }
        }),
        serde_json::json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }),
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": { "name": tool, "arguments": params }
        }),
    ];
    let payload = payload_lines
        .iter()
        .map(|line| line.to_string())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";

    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(payload.as_bytes()).await;
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let read_output = async {
        let mut stdout_text = String::new();
        let mut stderr_text = String::new();
        if let Some(stdout) = stdout {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => stdout_text.push_str(&line),
                    Err(_) => break,
                }
            }
        }
        if let Some(stderr) = stderr {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break,
                    Ok(_) => stderr_text.push_str(&line),
                    Err(_) => break,
                }
            }
        }
        (stdout_text, stderr_text)
    };

    let (stdout, stderr) = tokio::time::timeout(MCP_TIMEOUT, read_output)
        .await
        .map_err(|_| AdapterError::new("Goldfish MCP timeout"))?;
    let _ = child.kill().await;

    for raw_line in stdout.lines() {
        if raw_line.starts_with("[goldfish") {
            continue;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(raw_line) else {
            continue;
        };
        if parsed.get("id").and_then(Value::as_i64) == Some(2) {
            if let Some(result) = parsed.get("result") {
                if let Some(text) = result
                    .get("content")
                    .and_then(Value::as_array)
                    .and_then(|content| content.first())
                    .and_then(|first| first.get("text"))
                    .and_then(Value::as_str)
                {
                    return Ok(serde_json::from_str::<Value>(text)
                        .unwrap_or_else(|_| Value::String(text.to_string())));
                }
                if let Some(structured) = result.get("structuredContent") {
                    return Ok(structured.clone());
                }
                return Ok(result.clone());
            }
        }
    }

    if stderr.contains("proxy to http") {
        Err(AdapterError::new("Goldfish MCP no result"))
    } else {
        let stderr_snippet: String = stderr.chars().take(500).collect();
        Err(AdapterError::new(format!(
            "Goldfish MCP failed: {stderr_snippet}"
        )))
    }
}

fn chronicle_to_items(chronicle: &Map<String, Value>, max_items: usize) -> Vec<SourceItem> {
    let text = chronicle
        .get("summary_text")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        return Vec::new();
    }
    let period_key = chronicle
        .get("period_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    text.split("\n\n")
        .filter(|chunk| !chunk.is_empty())
        .take(max_items)
        .enumerate()
        .map(|(idx, chunk)| {
            let raw_title = chunk
                .split('\n')
                .next()
                .unwrap_or("")
                .chars()
                .take(80)
                .collect::<String>();
            // `title.replace(/^\[.*?\]\s*/, "")` — lenient: only strip when
            // the chunk starts with `[` and contains a `]`.
            let title = regex_replace_title(&raw_title);
            let title = if title.is_empty() {
                format!("Personal activity {period_key}")
            } else {
                title.chars().take(120).collect::<String>()
            };
            let mut metadata = Map::new();
            metadata.insert("period".to_string(), Value::String(period_key.clone()));
            metadata.insert(
                "snapshot_count".to_string(),
                chronicle
                    .get("snapshot_count")
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            metadata.insert(
                "source".to_string(),
                Value::String("goldfish-chronicle".to_string()),
            );
            SourceItem {
                title,
                url: format!(
                    "goldfish://chronicle/{}/{}",
                    chronicle
                        .get("period_key")
                        .and_then(Value::as_str)
                        .unwrap_or("today"),
                    idx
                ),
                content: chunk.chars().take(3000).collect::<String>(),
                image_url: None,
                metadata,
            }
        })
        .collect()
}

fn regex_replace_title(title: &str) -> String {
    if title.starts_with('[') {
        if let Some(close) = title.find(']') {
            return title[close + 1..].trim_start().to_string();
        }
    }
    title.to_string()
}

fn working_memory_to_items(memory: &[Map<String, Value>], max_items: usize) -> Vec<SourceItem> {
    let mut items = Vec::new();
    for snap in memory.iter().take(max_items) {
        let Some(content) = snap.get("content").and_then(Value::as_str) else {
            continue;
        };
        let content = content.trim();
        if content.len() < 80 {
            continue;
        }
        if content.contains("Goldfish — AI memory") {
            continue;
        }
        let app = snap.get("app").and_then(Value::as_str).unwrap_or("");
        let window_title = snap
            .get("window_title")
            .and_then(Value::as_str)
            .unwrap_or("");
        let title = {
            let title = window_title.chars().take(120).collect::<String>();
            if title.is_empty() {
                app.to_string()
            } else {
                title
            }
        };
        let url = snap
            .get("url")
            .and_then(Value::as_str)
            .filter(|url| !url.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("goldfish://snapshot/{app}"));

        let mut metadata = Map::new();
        metadata.insert("app".to_string(), Value::String(app.to_string()));
        metadata.insert(
            "window_title".to_string(),
            Value::String(window_title.to_string()),
        );
        metadata.insert(
            "source".to_string(),
            Value::String("goldfish-memory".to_string()),
        );
        items.push(SourceItem {
            title,
            url,
            content: content.chars().take(3000).collect::<String>(),
            image_url: None,
            metadata,
        });
    }
    items
}

fn as_object_map(value: &Value) -> Option<Map<String, Value>> {
    value.as_object().cloned()
}

fn as_array_of_object_maps(value: &Value) -> Vec<Map<String, Value>> {
    value
        .as_array()
        .map(|array| array.iter().filter_map(as_object_map).collect::<Vec<_>>())
        .unwrap_or_default()
}

fn string_field(map: &Map<String, Value>, key: &str) -> String {
    map.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

#[derive(Debug, Clone, Default)]
pub struct GoldfishAdapterOptions {
    pub max_items: Option<usize>,
    pub mode: Option<String>,
    pub query: Option<String>,
    pub allowed_keywords: Option<Vec<String>>,
}

pub struct GoldfishAdapter {
    max_items: usize,
    mode: String,
    query: Option<String>,
    allowed_keywords: Vec<String>,
}

impl GoldfishAdapter {
    pub fn new(options: GoldfishAdapterOptions) -> Self {
        Self {
            max_items: options.max_items.unwrap_or(5),
            mode: options
                .mode
                .filter(|mode| !mode.is_empty())
                .unwrap_or_else(|| "chronicle".to_string()),
            query: options.query,
            allowed_keywords: options.allowed_keywords.unwrap_or_default(),
        }
    }
}

impl SourceAdapter for GoldfishAdapter {
    fn name(&self) -> &str {
        "goldfish"
    }

    fn source_type(&self) -> &str {
        "goldfish"
    }

    fn fetch<'a>(
        &'a self,
        config_metadata: &'a ConfigMetadata,
    ) -> AdapterFuture<'a, Vec<SourceItem>> {
        let max_items = self.max_items;
        let mode = self.mode.clone();
        let query = self.query.clone();
        let options_keywords = self.allowed_keywords.clone();

        Box::pin(async move {
            // Normalize keywords: trim, lowercase, dedupe. Config overrides options.
            let raw_keywords: Vec<String> = match config_metadata.get("allowedKeywords") {
                Some(Value::Array(list)) => list
                    .iter()
                    .filter_map(Value::as_str)
                    .filter(|keyword| !keyword.trim().is_empty())
                    .map(|keyword| keyword.trim().to_lowercase())
                    .collect(),
                _ => options_keywords.clone(),
            };
            let mut allowed_keywords: Vec<String> = Vec::new();
            for keyword in raw_keywords {
                if !allowed_keywords.contains(&keyword) {
                    allowed_keywords.push(keyword);
                }
            }

            let should_filter = !allowed_keywords.is_empty();

            let passes_filter = |item: &SourceItem| -> bool {
                if !should_filter {
                    return true;
                }
                let text = format!("{} {}", item.title, item.content);
                allowed_keywords.iter().any(|keyword| {
                    // `(^|[^a-z0-9])${escapeRegExp(k)}([^a-z0-9]|$)` with `i` flag.
                    matches_keyword(keyword, &text)
                })
            };
            let filter_and_slice = |items: Vec<SourceItem>| -> Vec<SourceItem> {
                if !should_filter {
                    items.into_iter().take(max_items).collect()
                } else {
                    items
                        .into_iter()
                        .filter(|item| passes_filter(item))
                        .take(max_items)
                        .collect()
                }
            };

            // Over-fetch when filtering so slice-after-filter still yields
            // maxItems (capped 50).
            let pool_size = if should_filter {
                (max_items * 3).min(50)
            } else {
                max_items
            };
            let recent_limit = if should_filter { 12.max(pool_size) } else { 12 };

            if mode == "recent" {
                let mut params = Map::new();
                params.insert("minutes".to_string(), Value::from(60));
                params.insert("limit".to_string(), Value::from(recent_limit as i64));
                let Ok(recent) = call_goldfish_tool("get_recent_activity", &params).await else {
                    return Ok(Vec::new());
                };
                let raw: Vec<Map<String, Value>> = if recent.is_array() {
                    as_array_of_object_maps(&recent)
                } else {
                    recent
                        .get("events")
                        .map(as_array_of_object_maps)
                        .map(|events| {
                            events
                                .into_iter()
                                .map(|mut event| {
                                    let content =
                                        event.remove("content_excerpt").unwrap_or(Value::Null);
                                    event.insert("content".to_string(), content);
                                    event
                                })
                                .collect()
                        })
                        .unwrap_or_default()
                };
                return Ok(filter_and_slice(working_memory_to_items(&raw, pool_size)));
            }

            if let Some(query) = query {
                let mut params = Map::new();
                params.insert("query".to_string(), Value::String(query.clone()));
                params.insert("limit".to_string(), Value::from(pool_size as i64));
                let Ok(result) = call_goldfish_tool("search_memory", &params).await else {
                    return Ok(Vec::new());
                };
                let candidates: Vec<Map<String, Value>> = if result.is_array() {
                    as_array_of_object_maps(&result)
                } else {
                    result
                        .get("results")
                        .map(as_array_of_object_maps)
                        .unwrap_or_default()
                };
                let candidates: Vec<SourceItem> = candidates
                    .iter()
                    .enumerate()
                    .filter_map(|(index, entry)| {
                        let content = string_field(entry, "content_excerpt");
                        if content.len() <= 40 {
                            return None;
                        }
                        let title = {
                            let title = string_field(entry, "window_title");
                            if title.is_empty() {
                                format!("Goldfish memory {index}")
                            } else {
                                title.chars().take(120).collect::<String>()
                            }
                        };
                        let url = {
                            let url = string_field(entry, "url");
                            if url.is_empty() {
                                format!(
                                    "goldfish://search/{}/{}",
                                    crate::fetch::encode_uri_component(&query),
                                    index
                                )
                            } else {
                                url
                            }
                        };
                        let mut metadata = Map::new();
                        metadata
                            .insert("app".to_string(), Value::String(string_field(entry, "app")));
                        metadata.insert(
                            "source".to_string(),
                            Value::String("goldfish-search".to_string()),
                        );
                        Some(SourceItem {
                            title,
                            url,
                            content: content.chars().take(3000).collect::<String>(),
                            image_url: None,
                            metadata,
                        })
                    })
                    .collect();
                return Ok(filter_and_slice(candidates));
            }

            if mode == "working_memory" {
                let mut params = Map::new();
                params.insert(
                    "limit".to_string(),
                    Value::from(
                        (if should_filter {
                            pool_size
                        } else {
                            max_items * 2
                        }) as i64,
                    ),
                );
                let Ok(mem) = call_goldfish_tool("get_working_memory", &params).await else {
                    return Ok(Vec::new());
                };
                let mem = if mem.is_array() {
                    as_array_of_object_maps(&mem)
                } else {
                    Vec::new()
                };
                return Ok(filter_and_slice(working_memory_to_items(&mem, pool_size)));
            }

            let today = crate::dates::iso_from_unix_millis(chrono::Utc::now().timestamp_millis())
                .and_then(|stamp| stamp.get(0..10).map(str::to_string))
                .unwrap_or_default();
            let mut params = Map::new();
            params.insert("level".to_string(), Value::String("day".to_string()));
            params.insert("period".to_string(), Value::String(today));
            if let Ok(chronicle) = call_goldfish_tool("get_chronicle", &params).await {
                if let Some(chronicle_map) = as_object_map(&chronicle) {
                    if chronicle_map
                        .get("summary_text")
                        .and_then(Value::as_str)
                        .is_some_and(|text| !text.is_empty())
                    {
                        let filtered =
                            filter_and_slice(chronicle_to_items(&chronicle_map, pool_size));
                        if !filtered.is_empty() {
                            return Ok(filtered);
                        }
                        // fall through when chronicle filtered to empty
                    }
                }
            }

            let mut params = Map::new();
            params.insert(
                "limit".to_string(),
                Value::from(
                    (if should_filter {
                        pool_size
                    } else {
                        max_items * 2
                    }) as i64,
                ),
            );
            let Ok(mem) = call_goldfish_tool("get_working_memory", &params).await else {
                return Ok(Vec::new());
            };
            let mem = if mem.is_array() {
                as_array_of_object_maps(&mem)
            } else {
                Vec::new()
            };
            Ok(filter_and_slice(working_memory_to_items(&mem, pool_size)))
        })
    }
}

fn matches_keyword(keyword: &str, text: &str) -> bool {
    // `(^|[^a-z0-9])${escapeRegExp(k)}([^a-z0-9]|$)` with `i` flag: literal
    // match of the (lowercased) keyword with word-like boundaries.
    let keyword_lower = keyword.to_lowercase();
    let text_lower = text.to_lowercase();
    let mut start = 0_usize;
    while let Some(pos) = text_lower[start..].find(&keyword_lower) {
        let absolute = start + pos;
        let before_ok = absolute == 0
            || text_lower[..absolute]
                .chars()
                .next_back()
                .is_none_or(|c| !c.is_ascii_alphanumeric());
        let after_index = absolute + keyword_lower.len();
        let after_ok = after_index >= text_lower.len()
            || text_lower[after_index..]
                .chars()
                .next()
                .is_none_or(|c| !c.is_ascii_alphanumeric());
        if before_ok && after_ok {
            return true;
        }
        start = absolute + 1;
    }
    false
}
