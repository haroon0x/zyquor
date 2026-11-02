# Bloat audit: what is not worth porting

First-principles question for each area: **does this earn its maintenance cost
once it is running in Rust?** A port doubles the cost of anything that only
half-works, so anything unused, duplicated, or superseded should be deleted
rather than translated.

Each item lists the evidence found in the tree. Confidence is stated. **Nothing
here has been deleted** — these are proposals for the owner to accept or reject.

---

## 1. Delete outright (high confidence, low risk)

### 1.1 The `data/app.json` JSON fallback — already resolved

It does not exist. `CLAUDE.md` and older docs described "SQLite + JSON fallback
repositories" and `data/app.json`, but `packages/storage/src` contains only
`sqlite.ts`. The documentation was stale and has been corrected.

**Action:** none. Do not port it.

### 1.2 `detectSqliteSupport` — a Node-version shim

`packages/storage/src/index.ts` exports `detectSqliteSupport()`, which probes
whether `node:sqlite` loads. Rust always has SQLite (rusqlite is bundled).

**Action:** do not port. Same for `packages/storage/src/node-sqlite.d.ts`.

### 1.3 Legacy tweet types (DONE)

`news_context`, `lesson`, `tool`, `article_summary` and `hiring` are gone from
`TweetType` in both stacks. Existing rows in `post_history`, `source_packets`
and `tweet_measurements` are folded on open (all map to `useful_info` except
`lesson` → `guide`), so old data still validates.

### 1.4 `content_fingerprints` duplicates `post_history.text_hash` (DONE)

`approve_draft` writes a fingerprint row (account, draft, hash, normalised
text), and `create_post_history` also stores `text_hash`. Duplicate detection
reads whichever is convenient. Two sources of truth for "have I already posted
this text" is a bug generator.

**Done:** the pre-post duplicate check now queries `drafts.text_hash` (approved
rows only) and the table is dropped on open. `post_history.text_hash` remains
the source of truth for "have I already posted this".

### 1.5 Two generation-settings UIs

`apps/web/src/components/GenerationPanel.tsx` and `DesktopSettingsPanel.tsx`
both render provider + model pickers with their own state and their own
provider fallback lists (one had `openrouter` hardcoded, the other read from the
API). They drift independently.

**Action:** one panel, one source of provider options (`/generation`).

---

## 2. Prune before porting (needs an owner decision)

### 2.1 Source adapters — 22 modules

`packages/adapters/src/index.ts` re-exports 22 modules: hackernews,
hackernews-search, reddit, techcrunch, arxiv, github, gdelt, producthunt,
company-rss, hiring, crawl4ai, rss, aggregator, model-releases, x-feed,
deepseek-updates, cursor-changelog, xai-news, anthropic-release-notes, a16z,
goldfish, goldfish-context.

Several are single-purpose feeds for one vendor's changelog (`xai-news`,
`anthropic-release-notes`, `cursor-changelog`, `deepseek-updates`, `a16z`).
Each carries fetch + parse + health/cooldown behaviour, so porting all 22 is
one of the largest remaining line counts in the migration.

**Question for the owner:** which source types are actually enabled in ingest
configs? Port those; delete the rest. If that is 5–6 adapters, M3 shrinks a lot.

### 2.2 `services/` — demo-checker and crawl4ai (DONE: removed)

Both are referenced only from `package.json` scripts (`x:demo-check`,
`dev:crawl4ai`). `crawl4ai` is an optional external Python REST service; the
adapter degrades without it.

**Question:** is either used in practice? If not, delete rather than port.

### 2.3 `scripts/*.mjs` — 24 files, ~3,400 lines

Most are development harnesses: `tweet-eval`, `tweet-harness`,
`verify-spacing`, `propose-lessons`, `smoke-*`, `overseer`,
`open-x-profile-manual/cdp`, `check-x-login`. M8 currently says "port the
scripts"; that is likely the worst effort-to-value ratio in the plan.

**Recommendation:** keep only the `zyquor` entrypoint CLI and the smoke tests
that CI actually runs. Rewrite those two or three as Rust binaries; delete the
rest as their functionality moves into tests.

### 2.4 Electron vs Tauri — decide before M6

The desktop app runs the API, worker, and web UI in-process, and is the reason
`apps/desktop` wraps everything. Porting the Electron main-process logic to
Rust and *then* re-wrapping it in Tauri is double work.

**Decision needed before M6:** go straight to Tauri, or keep Electron and keep
its glue in TypeScript (which means the repo is not 100% Rust — say so
explicitly rather than discovering it later).

---

## 3. Do not port literally — rewrite (behaviour-preserving)

### 3.1 `apps/api/src/lib/errors.ts`

Classifies errors by matching message text (`startsWith("Duplicate ")`,
`includes("ZYQUOR_OPENROUTER_API_KEY")`, …). Translating string matches into
Rust is fragile and hides type information. Replace with a typed error enum
mapped to HTTP status codes.

### 3.2 Provider allowlists duplicated across layers

Model allowlists and `safe*Model` coercion exist in `config.ts` and again in
each provider, plus a parallel copy in the API's generation route. One
validation point, used by all callers.

### 3.3 Ad-hoc retry/stale-job logic

`retry-job.ts`, `stale-jobs.ts`, and the verify-then-retry path encode a real
state machine in scattered conditionals. `zyquor-core` already has the
transitions; make the workers use them rather than re-deriving rules.

---

## 4. Not product code (exclude from the port and from the repo)

| Path | Evidence | Note |
| --- | --- | --- |
| `third_party/x-algorithm` | 20 MB, **untracked** in git | Vendored reference material, nothing builds it |
| `.commandcode/`, `graphify-out/`, `tasks/`, `skills/` | tooling/agent scaffolding | Not part of the app |
| `.agents/`, `skills-lock.json` | created when Rust skills were loaded this session | Untracked; decide whether to commit vendored skills |
| `apps/*/dist`, `packages/*/dist` | build output | Not source |

Note: `apps/` looks like 60 MB, but almost all of that is `node_modules` and
`dist`. Deleting code here is about maintenance cost, not disk.

---

## Suggested order of decisions

1. Legacy tweet types → one-time data migration, delete the constants. (cheap)
2. `content_fingerprints` → collapsed into `drafts.text_hash` (decided 2026-11-02).
3. Source adapters → keep only the ones actually configured. (biggest win)
4. `scripts/` → keep the entrypoint and CI smoke tests only. (big win)
5. Electron vs Tauri → decide before starting M6.
6. `services/` → confirm usage, then delete the unused one.
