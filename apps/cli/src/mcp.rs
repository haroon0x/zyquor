//! `zyquor mcp` — Model Context Protocol server over stdio.
//!
//! This is the agent-native integration point. Any MCP-capable harness
//! (Claude Code, Cursor, Codex, Zed, ...) can register the `zyquor` binary with
//! `mcp` as the argument and get typed tools for the whole review workflow
//! without hand-writing HTTP calls.
//!
//! Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout, per the MCP
//! stdio transport. All diagnostics go to stderr; stdout carries protocol
//! traffic only.
//!
//! Safety tiers (enforced here, not just documented):
//! - default: read tools + draft/select/approve (`prepare_only`/`scheduled`).
//!   Approval always sends `screened:true`, so the server-side quality gate
//!   cannot be skipped.
//! - `--allow-browser`: adds `prepare_job` (opens the composer, never posts).
//! - `--allow-post`: adds `post_job` (requires `confirm: "post"`) and allows
//!   `approve_draft` with mode `autopost`.
//!
//! Environment equivalents: `ZYQUOR_MCP_ALLOW_BROWSER=1`,
//! `ZYQUOR_MCP_ALLOW_POST=1`. API base: `--api-url <url>`, else the normal
//! `ZYQUOR_API_URL` / health probe resolution.

use serde_json::{Value, json};

use crate::cli;

const PROTOCOL_VERSION: &str = "2025-06-18";
const GUIDE: &str = include_str!("../../../skills/zyquor/SKILL.md");

/// Agent-facing operating instructions, returned by `initialize`.
const INSTRUCTIONS: &str = "\
Zyquor is the user's local-first X posting assistant. Nothing is posted without \
an explicit human ask: drafting, generating and selecting are safe; approval \
creates a queued job; prepare fills the real composer; post publishes publicly.

Recommended flow: create_draft -> generate_draft -> read the candidates -> \
select_candidate -> approve_draft (mode prepare_only) -> the human reviews the \
job -> only when they explicitly ask, prepare_job / post_job (those tools are \
only exposed when the server was started with the matching flags).

Always show the user the exact text before approving. Approvals sent through \
this server always include screened:true, so slop, invented claims and \
over-length text are refused by the API. Never retry a failed post on your own: \
a failed click may have reached X.";

#[derive(Debug, Clone, Default)]
struct Config {
    allow_browser: bool,
    allow_post: bool,
    api_url: Option<String>,
}

impl Config {
    fn parse(args: &[String]) -> Result<Self, String> {
        let mut config = Config {
            allow_browser: env_flag("ZYQUOR_MCP_ALLOW_BROWSER"),
            allow_post: env_flag("ZYQUOR_MCP_ALLOW_POST"),
            api_url: std::env::var("ZYQUOR_MCP_API_URL")
                .ok()
                .filter(|value| !value.is_empty()),
        };
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--allow-browser" => config.allow_browser = true,
                "--allow-post" => config.allow_post = true,
                "--api-url" => {
                    let value = args
                        .get(index + 1)
                        .ok_or_else(|| "missing value for --api-url".to_string())?;
                    config.api_url = Some(value.clone());
                    index += 1;
                }
                other => return Err(format!("unknown mcp flag: {other}")),
            }
            index += 1;
        }
        Ok(config)
    }
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).ok().as_deref() == Some("1")
}

pub async fn run(args: &[String]) -> Result<i32, String> {
    let config = Config::parse(args)?;
    let api_url = match config.api_url.clone() {
        Some(url) => url,
        None => cli::resolve_api_url().await,
    };
    let mut server = McpServer {
        allow_browser: config.allow_browser,
        allow_post: config.allow_post,
        http: cli::http(&api_url),
        api_url,
    };
    eprintln!(
        "zyquor mcp: api={} browser={} post={}",
        server.api_url,
        if server.allow_browser { "on" } else { "off" },
        if server.allow_post { "on" } else { "off" },
    );

    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = std::io::BufWriter::new(stdout.lock());
    use std::io::{BufRead, Write};
    for line in stdin.lock().lines() {
        let line = line.map_err(|error| format!("stdin: {error}"))?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = server.handle_line(&line).await {
            let text = serde_json::to_string(&response).map_err(|error| error.to_string())?;
            out.write_all(text.as_bytes())
                .and_then(|_| out.write_all(b"\n"))
                .and_then(|_| out.flush())
                .map_err(|error| format!("stdout: {error}"))?;
        }
    }
    Ok(0)
}

struct McpServer {
    allow_browser: bool,
    allow_post: bool,
    http: cli::Http,
    api_url: String,
}

impl McpServer {
    async fn handle_line(&mut self, line: &str) -> Option<Value> {
        let message: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                return Some(jsonrpc_error(
                    Value::Null,
                    -32700,
                    &format!("Parse error: {error}"),
                ));
            }
        };
        let id = message.get("id").cloned();
        let method = match message.get("method").and_then(Value::as_str) {
            Some(method) => method.to_string(),
            None => {
                // A response from the client (we never send requests) or junk.
                return id.map(|id| jsonrpc_error(id, -32600, "Invalid Request: no method"));
            }
        };
        // Notifications never get a reply.
        let id = id?;

        match method.as_str() {
            "initialize" => Some(jsonrpc_result(id, self.initialize_result(&message))),
            "ping" => Some(jsonrpc_result(id, json!({}))),
            "tools/list" => Some(jsonrpc_result(
                id,
                json!({ "tools": self.tool_definitions() }),
            )),
            "tools/call" => Some(self.handle_tools_call(id, &message).await),
            "resources/list" => Some(jsonrpc_result(
                id,
                json!({
                    "resources": [{
                        "uri": "zyquor://guide",
                        "name": "Zyquor operating guide",
                        "description": "Safety rules, API map and workflows for driving Zyquor.",
                        "mimeType": "text/markdown"
                    }]
                }),
            )),
            "resources/read" => {
                let uri = message
                    .pointer("/params/uri")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if uri == "zyquor://guide" {
                    Some(jsonrpc_result(
                        id,
                        json!({
                            "contents": [{
                                "uri": "zyquor://guide",
                                "mimeType": "text/markdown",
                                "text": GUIDE
                            }]
                        }),
                    ))
                } else {
                    Some(jsonrpc_error(id, -32602, "Unknown resource uri"))
                }
            }
            "prompts/list" => Some(jsonrpc_result(id, json!({ "prompts": [] }))),
            "logging/setLevel" => Some(jsonrpc_result(id, json!({}))),
            other => Some(jsonrpc_error(
                id,
                -32601,
                &format!("Method not found: {other}"),
            )),
        }
    }

    fn initialize_result(&self, message: &Value) -> Value {
        let requested = message
            .pointer("/params/protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(PROTOCOL_VERSION);
        json!({
            "protocolVersion": requested,
            "capabilities": {
                "tools": { "listChanged": false },
                "resources": {}
            },
            "serverInfo": {
                "name": "zyquor",
                "version": env!("CARGO_PKG_VERSION")
            },
            "instructions": INSTRUCTIONS
        })
    }

    async fn handle_tools_call(&self, id: Value, message: &Value) -> Value {
        let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
        let Some(name) = params.get("name").and_then(Value::as_str) else {
            return jsonrpc_error(id, -32602, "Invalid params: missing tool name");
        };
        let arguments = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let result = match self.call_tool(name, &arguments).await {
            Ok(value) => tool_success(value),
            Err(error) => tool_failure(&error),
        };
        jsonrpc_result(id, result)
    }

    fn tool_definitions(&self) -> Vec<Value> {
        let mut tools = vec![
            tool(
                "status",
                "Zyquor status",
                "Health, worker heartbeat, posting flags, generation model and queue counts.",
                json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                ReadOnly,
            ),
            tool(
                "list_accounts",
                "List accounts",
                "Configured X accounts in this Zyquor instance.",
                json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                ReadOnly,
            ),
            tool(
                "list_jobs",
                "List jobs",
                "Post jobs (the queue), optionally filtered by account and status.",
                json!({
                    "type": "object",
                    "properties": {
                        "accountId": { "type": "string", "description": "Account id, e.g. account_personal. Omit for all accounts." },
                        "statuses": { "type": "array", "items": { "type": "string" }, "description": "Filter by status (approved, prepared, posted, failed, running, ...)." },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200, "description": "Max jobs to return (default 50)." }
                    },
                    "additionalProperties": false
                }),
                ReadOnly,
            ),
            tool(
                "get_job",
                "Get one job",
                "One post job by id (search the queue; the API has no single-job GET route).",
                json!({
                    "type": "object",
                    "properties": {
                        "jobId": { "type": "string" },
                        "accountId": { "type": "string", "description": "Optional; speeds up the lookup." }
                    },
                    "required": ["jobId"],
                    "additionalProperties": false
                }),
                ReadOnly,
            ),
            tool(
                "get_job_attempts",
                "Job attempt log",
                "Attempt history for a job (started, text_inserted, post_clicked, verified, failed, with error messages).",
                json!({
                    "type": "object",
                    "properties": { "jobId": { "type": "string" } },
                    "required": ["jobId"],
                    "additionalProperties": false
                }),
                ReadOnly,
            ),
            tool(
                "list_pending_drafts",
                "Pending drafts",
                "Drafts waiting for review (generated candidates, not yet approved).",
                json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                ReadOnly,
            ),
            tool(
                "quality_gate_failures",
                "Quality gate rejections",
                "Drafts the server-side quality screen rejected, with reasons.",
                json!({ "type": "object", "properties": {}, "additionalProperties": false }),
                ReadOnly,
            ),
            tool(
                "list_history",
                "Post history",
                "Recently posted content with permalinks (post history has a 24h TTL).",
                json!({
                    "type": "object",
                    "properties": {
                        "accountId": { "type": "string" },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                    },
                    "additionalProperties": false
                }),
                ReadOnly,
            ),
            tool(
                "list_source_packets",
                "Source packets",
                "Ingested source packets awaiting drafting (or filtered by status).",
                json!({
                    "type": "object",
                    "properties": {
                        "accountId": { "type": "string" },
                        "status": { "type": "string", "enum": ["new", "drafted", "archived"] },
                        "limit": { "type": "integer", "minimum": 1, "maximum": 200 }
                    },
                    "additionalProperties": false
                }),
                ReadOnly,
            ),
            tool(
                "create_draft",
                "Create a draft",
                "Create a draft from an idea or source text. Returns the empty draft; call generate_draft next.",
                json!({
                    "type": "object",
                    "properties": {
                        "accountId": { "type": "string", "description": "Account id from list_accounts." },
                        "idea": { "type": "string", "description": "The idea, note or source text to write from." },
                        "tweetType": {
                            "type": "string",
                            "enum": ["feed_observation", "useful_info", "guide", "opinion", "reply", "narrative_history"],
                            "description": "Writing lane; defaults to useful_info."
                        },
                        "count": { "type": "integer", "minimum": 1, "maximum": 10, "description": "Candidate count (default 1)." },
                        "replyToUrl": { "type": "string", "description": "Optional X post URL to draft a reply to." }
                    },
                    "required": ["accountId", "idea"],
                    "additionalProperties": false
                }),
                Writes,
            ),
            tool(
                "generate_draft",
                "Generate candidates",
                "Run the LLM writer for a draft. This is the only slow, network-backed step.",
                json!({
                    "type": "object",
                    "properties": {
                        "draftId": { "type": "string" },
                        "count": { "type": "integer", "minimum": 1, "maximum": 10 }
                    },
                    "required": ["draftId"],
                    "additionalProperties": false
                }),
                Writes,
            ),
            tool(
                "get_draft",
                "Get a draft",
                "A draft with its candidates, scores and approval status.",
                json!({
                    "type": "object",
                    "properties": { "draftId": { "type": "string" } },
                    "required": ["draftId"],
                    "additionalProperties": false
                }),
                ReadOnly,
            ),
            tool(
                "select_candidate",
                "Select a candidate",
                "Pick the candidate to approve, optionally with edited text.",
                json!({
                    "type": "object",
                    "properties": {
                        "draftId": { "type": "string" },
                        "candidateId": { "type": "string" },
                        "editedText": { "type": "string", "description": "Optional final text overriding the candidate." }
                    },
                    "required": ["draftId", "candidateId"],
                    "additionalProperties": false
                }),
                Writes,
            ),
            tool(
                "approve_draft",
                "Approve a draft",
                "Create a queued job from the draft. Always screened server-side. Default mode prepare_only (human still clicks post); mode autopost requires the server's --allow-post flag.",
                json!({
                    "type": "object",
                    "properties": {
                        "draftId": { "type": "string" },
                        "editedText": { "type": "string", "description": "The exact approved text shown to the user." },
                        "mode": { "type": "string", "enum": ["prepare_only", "scheduled", "autopost"], "description": "Default prepare_only." },
                        "scheduledFor": { "type": "string", "description": "ISO datetime with offset; required for mode=scheduled." }
                    },
                    "required": ["draftId", "editedText"],
                    "additionalProperties": false
                }),
                Writes,
            ),
        ];
        if self.allow_browser {
            tools.push(tool(
                "prepare_job",
                "Prepare a job",
                "Open the real X composer for a queued job and insert the text via CDP. Never clicks Post. Requires --allow-browser.",
                json!({
                    "type": "object",
                    "properties": { "jobId": { "type": "string" } },
                    "required": ["jobId"],
                    "additionalProperties": false
                }),
                Browser,
            ));
        }
        if self.allow_post {
            tools.push(tool(
                "post_job",
                "Post a job (PUBLISHES)",
                "PUBLISHES to X. Only call after the human explicitly asked to post this exact text. Requires --allow-post and confirm=\"post\".",
                json!({
                    "type": "object",
                    "properties": {
                        "jobId": { "type": "string" },
                        "confirm": { "type": "string", "enum": ["post"], "description": "Must be the literal string post." }
                    },
                    "required": ["jobId", "confirm"],
                    "additionalProperties": false
                }),
                Destructive,
            ));
        }
        tools
    }

    async fn call_tool(&self, name: &str, args: &Value) -> Result<Value, String> {
        match name {
            "status" => {
                let mut status = self.get("/system/status", 10_000).await?;
                if let Ok(health) = self.get("/health", 5_000).await {
                    status["health"] = health;
                }
                Ok(status)
            }
            "list_accounts" => self.get("/accounts", 10_000).await,
            "list_jobs" => {
                let mut path = "/jobs".to_string();
                let mut query: Vec<String> = Vec::new();
                if let Some(account) = arg_str(args, "accountId") {
                    query.push(format!("accountId={}", encode(&account)));
                }
                if let Some(statuses) = arg_string_list(args, "statuses") {
                    if !statuses.is_empty() {
                        query.push(format!("statuses={}", encode(&statuses.join(","))));
                    }
                }
                if !query.is_empty() {
                    path.push('?');
                    path.push_str(&query.join("&"));
                }
                let value = self.get(&path, 15_000).await?;
                let limit = arg_u64(args, "limit").unwrap_or(50).clamp(1, 200) as usize;
                let mut jobs = value
                    .get("jobs")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                jobs.truncate(limit);
                Ok(json!({ "count": jobs.len(), "jobs": jobs }))
            }
            "get_job" => {
                let job_id = required_str(args, "jobId")?;
                let mut path = "/jobs".to_string();
                if let Some(account) = arg_str(args, "accountId") {
                    path.push_str(&format!("?accountId={}", encode(&account)));
                }
                let value = self.get(&path, 15_000).await?;
                let job = value
                    .get("jobs")
                    .and_then(Value::as_array)
                    .and_then(|jobs| {
                        jobs.iter().find(|job| {
                            job.get("id").and_then(Value::as_str) == Some(job_id.as_str())
                        })
                    })
                    .cloned();
                job.ok_or_else(|| format!("job not found: {job_id}"))
            }
            "get_job_attempts" => {
                let job_id = required_str(args, "jobId")?;
                self.get(&format!("/jobs/{}/attempts", encode(&job_id)), 15_000)
                    .await
            }
            "list_pending_drafts" => self.get("/drafts/pending", 15_000).await,
            "quality_gate_failures" => self.get("/drafts/quality-gate-failures", 15_000).await,
            "list_history" => {
                let mut path = "/history".to_string();
                if let Some(account) = arg_str(args, "accountId") {
                    path.push_str(&format!("?accountId={}", encode(&account)));
                }
                let value = self.get(&path, 15_000).await?;
                let limit = arg_u64(args, "limit").unwrap_or(50).clamp(1, 200) as usize;
                let mut history = value
                    .get("history")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                history.truncate(limit);
                Ok(json!({ "count": history.len(), "history": history }))
            }
            "list_source_packets" => {
                let mut path = "/source-packets".to_string();
                let mut query: Vec<String> = Vec::new();
                if let Some(account) = arg_str(args, "accountId") {
                    query.push(format!("accountId={}", encode(&account)));
                }
                if let Some(status) = arg_str(args, "status") {
                    query.push(format!("status={}", encode(&status)));
                }
                if !query.is_empty() {
                    path.push('?');
                    path.push_str(&query.join("&"));
                }
                let value = self.get(&path, 15_000).await?;
                let limit = arg_u64(args, "limit").unwrap_or(50).clamp(1, 200) as usize;
                let mut packets = value
                    .get("packets")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                packets.truncate(limit);
                Ok(json!({ "count": packets.len(), "packets": packets }))
            }
            "create_draft" => {
                let account_id = required_str(args, "accountId")?;
                let idea = required_str(args, "idea")?;
                let mut body = json!({
                    "accountId": account_id,
                    "idea": idea,
                    "count": arg_u64(args, "count").unwrap_or(1).clamp(1, 10),
                    "tweetType": arg_str(args, "tweetType").unwrap_or_else(|| "useful_info".to_string())
                });
                if let Some(reply_to) = arg_str(args, "replyToUrl") {
                    body["replyToUrl"] = Value::String(reply_to);
                }
                self.post("/drafts", Some(&body), 30_000).await
            }
            "generate_draft" => {
                let draft_id = required_str(args, "draftId")?;
                let body = match arg_u64(args, "count") {
                    Some(count) => json!({ "count": count.clamp(1, 10) }),
                    None => json!({}),
                };
                self.post(
                    &format!("/drafts/{}/generate", encode(&draft_id)),
                    Some(&body),
                    300_000,
                )
                .await
            }
            "get_draft" => {
                let draft_id = required_str(args, "draftId")?;
                self.get(&format!("/drafts/{}", encode(&draft_id)), 15_000)
                    .await
            }
            "select_candidate" => {
                let draft_id = required_str(args, "draftId")?;
                let candidate_id = required_str(args, "candidateId")?;
                let mut body = json!({ "candidateId": candidate_id });
                if let Some(text) = arg_str(args, "editedText") {
                    body["editedText"] = Value::String(text);
                }
                self.post(
                    &format!("/drafts/{}/select", encode(&draft_id)),
                    Some(&body),
                    30_000,
                )
                .await
            }
            "approve_draft" => {
                let draft_id = required_str(args, "draftId")?;
                let edited_text = required_str(args, "editedText")?;
                let mode = arg_str(args, "mode").unwrap_or_else(|| "prepare_only".to_string());
                if mode == "autopost" && !self.allow_post {
                    return Err(
                        "autopost approval is disabled for this server. Restart with --allow-post \
                         only after the human explicitly asked, or approve as prepare_only and let \
                         them click post."
                            .to_string(),
                    );
                }
                if !matches!(mode.as_str(), "prepare_only" | "scheduled" | "autopost") {
                    return Err(format!(
                        "invalid mode {mode}; expected prepare_only, scheduled or autopost"
                    ));
                }
                let mut body = json!({
                    "editedText": edited_text,
                    "mode": mode,
                    // Agents must always send the screen; the API refuses slop.
                    "screened": true
                });
                if let Some(scheduled) = arg_str(args, "scheduledFor") {
                    body["scheduledFor"] = Value::String(scheduled);
                }
                self.post(
                    &format!("/drafts/{}/approve", encode(&draft_id)),
                    Some(&body),
                    30_000,
                )
                .await
            }
            "prepare_job" => {
                if !self.allow_browser {
                    return Err(
                        "prepare_job is disabled; restart the server with --allow-browser"
                            .to_string(),
                    );
                }
                let job_id = required_str(args, "jobId")?;
                self.post(&format!("/jobs/{}/prepare", encode(&job_id)), None, 240_000)
                    .await
            }
            "post_job" => {
                if !self.allow_post {
                    return Err(
                        "post_job is disabled; restart the server with --allow-post and only after \
                         the human explicitly asked to post"
                            .to_string(),
                    );
                }
                if arg_str(args, "confirm").as_deref() != Some("post") {
                    return Err("post_job requires confirm=\"post\"".to_string());
                }
                let job_id = required_str(args, "jobId")?;
                self.post(&format!("/jobs/{}/post", encode(&job_id)), None, 300_000)
                    .await
            }
            other => Err(format!("unknown tool: {other}")),
        }
    }

    async fn get(&self, path: &str, timeout_ms: u64) -> Result<Value, String> {
        self.http
            .get_json(path, timeout_ms)
            .await
            .map_err(|error| api_error(&self.api_url, error))
    }

    async fn post(
        &self,
        path: &str,
        body: Option<&Value>,
        timeout_ms: u64,
    ) -> Result<Value, String> {
        self.http
            .post_json(path, body, timeout_ms)
            .await
            .map_err(|error| api_error(&self.api_url, error))
    }
}

fn api_error(api_url: &str, error: String) -> String {
    format!(
        "{error} (API: {api_url} — is the app running? `./zyquor status --json` or \
         `cargo run -p zyquor-cli -- start` may be needed)"
    )
}

fn tool(name: &str, title: &str, description: &str, schema: Value, kind: ToolKind) -> Value {
    let (read_only, destructive) = match kind {
        ToolKind::ReadOnly => (true, false),
        ToolKind::Writes => (false, false),
        ToolKind::Browser => (false, false),
        ToolKind::Destructive => (false, true),
    };
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": schema,
        "annotations": {
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "idempotentHint": false,
            "openWorldHint": false
        }
    })
}

#[derive(Clone, Copy)]
enum ToolKind {
    ReadOnly,
    Writes,
    Browser,
    Destructive,
}

use ToolKind::{Browser, Destructive, ReadOnly, Writes};

fn tool_success(value: Value) -> Value {
    let text = serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    let structured = if value.is_object() {
        value
    } else {
        json!({ "data": value })
    };
    json!({
        "content": [{ "type": "text", "text": text }],
        "structuredContent": structured,
        "isError": false
    })
}

fn tool_failure(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": format!("Error: {message}") }],
        "isError": true
    })
}

fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message }
    })
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(|value| value.to_string())
        .filter(|value| !value.trim().is_empty())
}

fn required_str(args: &Value, key: &str) -> Result<String, String> {
    arg_str(args, key).ok_or_else(|| format!("missing required argument: {key}"))
}

fn arg_u64(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

fn arg_string_list(args: &Value, key: &str) -> Option<Vec<String>> {
    match args.get(key) {
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .filter_map(Value::as_str)
                .map(|value| value.to_string())
                .collect(),
        ),
        Some(Value::String(value)) => Some(
            value
                .split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(|part| part.to_string())
                .collect(),
        ),
        _ => None,
    }
}
