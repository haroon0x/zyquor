# Zyquor for agents

Zyquor is agent-native: every action is available to a harness without screen
scraping. Three surfaces, same local API behind them:

| Surface | Use it for |
| --- | --- |
| **MCP server** (`zyquor mcp`) | Claude Code, Cursor, Codex, Zed and any other MCP-capable harness. Typed tools, capability discovery, no curl wrangling. |
| **HTTP API** (`http://127.0.0.1:3001`) | Anything not covered by a tool, custom scripts, another language. The API is the source of truth. |
| **CLI** (`./zyquor`, `cargo run -p zyquor-cli -- …`) | Shell agents, cron, quick checks (`status --json`), and starting/stopping the stack. |

Everything is loopback-only and unauthenticated: an agent that can run shell
commands on this machine can already read the SQLite database, so there is no
extra perimeter. Treat the surfaces as privileged anyway — posting is public.

## Quick start

```bash
# 1. The app must be running (API + worker + web UI)
cargo run -p zyquor-cli -- start

# 2. One-shot state for any agent or script
./zyquor status --json

# 3. MCP server over stdio
./zyquor mcp
```

The `./zyquor` wrapper prefers a built `target/{debug,release}/zyquor` and only
falls back to `cargo run` when the binary is missing or stale, so MCP stdin and
stdout stay clean.

### Claude Code

This repository ships a project-scoped `.mcp.json`, so Claude Code offers the
`zyquor` server automatically when it starts in the repo (approve it once in
`/mcp`). Equivalent explicit registration:

```bash
# from the repo root
claude mcp add zyquor -- ./zyquor mcp

# or user-wide with an absolute path
claude mcp add zyquor -- /home/you/dev/projects/zyquor/zyquor mcp
```

Check with `/mcp` inside Claude Code or `claude mcp list` in a shell.

**Enable browser/post tiers only when the human explicitly asks.** These flags
are deliberately separate invocations:

```bash
./zyquor mcp --allow-browser                 # adds prepare_job (fills the composer, never posts)
./zyquor mcp --allow-browser --allow-post    # adds post_job + autopost approvals
```

Environment equivalents: `ZYQUOR_MCP_ALLOW_BROWSER=1`, `ZYQUOR_MCP_ALLOW_POST=1`.
API base override: `--api-url http://127.0.0.1:3001` or `ZYQUOR_API_URL`.

### Other MCP harnesses

Any stdio MCP client works; the config is just command + args:

```json
{
  "mcpServers": {
    "zyquor": {
      "command": "/home/you/dev/projects/zyquor/zyquor",
      "args": ["mcp"]
    }
  }
}
```

Docs for other clients: Cursor uses `~/.cursor/mcp.json`, Codex uses
`~/.codex/config.toml` (`[mcp_servers.zyquor]`), Zed uses its `context_servers`
block. The server speaks newline-delimited JSON-RPC 2.0 and negotiates protocol
version `2025-06-18` (it echoes the client's requested version).

## Tools

Default server: 14 read/draft/approve tools. Browser and posting tools appear
only with the matching flag.

| Tool | Tier | What it does |
| --- | --- | --- |
| `status` | read | Health, worker heartbeat, posting flags, generation model, queue counts |
| `list_accounts` | read | Configured X accounts |
| `list_jobs` | read | The queue, filtered by account/status |
| `get_job` | read | One job by id |
| `get_job_attempts` | read | Attempt log (started → text_inserted → post_clicked → verified / failed) |
| `list_pending_drafts` | read | Drafts awaiting review |
| `quality_gate_failures` | read | Rejected drafts with reasons |
| `list_history` | read | Posted content + permalinks (24h TTL) |
| `list_source_packets` | read | Ingested source packets |
| `create_draft` | write | Draft from an idea (optionally reply-to URL) |
| `generate_draft` | write | Run the LLM writer; the only slow network step |
| `get_draft` | read | Draft with candidates and scores |
| `select_candidate` | write | Pick (and optionally edit) the candidate |
| `approve_draft` | write | Queue a job. Always sends `screened:true`; default mode `prepare_only` |
| `prepare_job` | browser* | Fill the real X composer via CDP, never clicks Post |
| `post_job` | post* | **Publishes publicly**; needs `confirm: "post"` |

`*` only exposed with `--allow-browser` / `--allow-post`.

The server also exposes one MCP **resource**, `zyquor://guide`, which returns
the operating skill (`skills/zyquor/SKILL.md`): safety rules, workflows, API map.

## Safety contract (enforced in the server, not just prose)

1. **The review queue is the gate.** Drafting/generating/selecting are
   reversible; approving creates a job; posting is public.
2. **Approvals are always screened.** `approve_draft` hard-codes
   `screened:true`, so the API rejects slop, unclean text, invented claims and
   over-length drafts with a 409. Do not try to bypass this with HTTP.
3. **Posting needs a human ask and a flag.** `post_job` is not even listed
   unless the server was started with `--allow-post`, and the call must pass
   `confirm:"post"`. Approving with mode `autopost` is refused without it.
4. **Prepare is dry-run.** `prepare_job` opens the composer and inserts text
   but never clicks Post.
5. **Never retry failed posts autonomously.** A failed click may have reached
   X. Check the attempts and the profile first; retrying is a human decision.
6. **No destructive actions without an ask.** There are deliberately no
   delete/settings-write tools; use the HTTP API only on request.

## Default workflow

```
create_draft(accountId, idea, tweetType?)
  -> generate_draft(draftId, count?)
  -> get_draft(draftId)                    # show the user the candidates
  -> select_candidate(draftId, candidateId, editedText?)
  -> approve_draft(draftId, editedText, mode="prepare_only")
     # job is now in the review queue; the human reviews in the GUI
     # only after an explicit "post it": --allow-post server -> post_job(jobId, confirm="post")
```

Reply drafts use the same chain with `create_draft(..., replyToUrl: "https://x.com/…")`.
Source-packet drafting and ingest stay in the automated worker lane; agents
should not call run/post lanes on their own.

## HTTP fallback

The MCP tools are a curated subset. For everything else, call the local API
directly (same payloads the web UI uses):

```bash
API=$(./zyquor status --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["apiUrl"])')
curl -s "$API/health"
curl -s "$API/system/status" | jq '{counts, posting, worker}'
curl -s "$API/jobs?accountId=account_personal&statuses=approved" | jq '.jobs[:3]'
```

Conventions: JSON in/out; non-2xx bodies are `{"error": "…"}` (validation adds
`issues`); create/approve endpoints reply with shape families documented in
`CLAUDE.md` and `skills/zyquor/SKILL.md`.

## CLI

| Command | Purpose |
| --- | --- |
| `./zyquor status [--json]` | One-shot health + queue summary (exit 1 when unreachable) |
| `./zyquor mcp [--allow-browser] [--allow-post] [--api-url <url>]` | MCP stdio server |
| `cargo run -p zyquor-cli -- start` | Chrome CDP + API + worker + web UI |
| `cargo run -p zyquor-cli -- api` / `worker` | Individual pieces |
| `cargo run -p zyquor-cli -- post-loop` / `reply-loop` | Automated posting lanes — explicit human ask only |

`./zyquor` is a thin dev wrapper; in production/harness configs prefer an
absolute path to the built binary so MCP stdout stays protocol-only.

## Troubleshooting

- **MCP client shows the server but tools fail** — the API is not running.
  `./zyquor status --json` explains it, and tool errors include the API URL.
- **That tool is missing** — posting/prepare tools require the flags above;
  listing is per-process, so restart the MCP server after changing flags.
- **Diagnostics** — MCP logging goes to stderr (`zyquor mcp: api=… browser=…
  post=…`). stdout is JSON-RPC only.
- **API on another port** — use `--api-url`/`ZYQUOR_API_URL`; the CLI resolves
  `3001`, then `3000`, before falling back.
