# Roadmap

Where Zyquor stands and what is left. The plan of record for the migration is
[docs/rust-migration.md](docs/rust-migration.md); this file tracks the product
side and the honest state of each milestone.

## Where the project is

The TypeScript tree is the running product. The Rust workspace is the migration
target, ported crate by crate, with parity harnesses as the exit criterion for
each milestone. Nothing has been deleted from the TypeScript side yet.

| Milestone | State | Notes |
| --------- | ----- | ----- |
| M0: Scaffold | done | Workspace, `rust-toolchain.toml`, Rust CI job (fmt, clippy, test). |
| M1: `zyquor-core` | done | Domain types, lifecycle transitions, path rules, post spacing, reply-target parsing. Parity harness covers gate/transition and CDP-URL cases. |
| M2: `zyquor-storage` + `zyquor-accounts` | done (SQLite) | The SQLite repository surface is ported: schema, column migrations, first-run seeding, accounts, drafts, jobs, attempts, source packets, ingest configs, history, measurements. A database written by the TypeScript repository reads back with matching records. The JSON fallback the older docs mentioned never existed. |
| M3: generation / adapters / automation | done | `zyquor-generation` is complete: config resolution, deterministic quality scoring, text post-processing, prompt assembly (byte-for-byte parity, checked by `scripts/prompt-parity.mjs`), harness rendering, output parsing, the provider clients (opencode with failover ladder, command-code, ollama, gemini) behind a `Fetch` seam / shared CLI runner, the refine pass, and the `create_generation_provider_from_env` factory. `zyquor-adapters` is complete: all 19 source adapters, the aggregator with health tracking, and the Goldfish MCP adapter. `zyquor-automation` is complete: the ingest engine, tweet-type routing, quality gates, performance aggregation, and draft building. Provider behaviour is fake-`Fetch`-tested; live opencode verified 2026-11-06. |
| M4: `zyquor-browser` | partial | chromiumoxide CDP session + `CdpPage` primitives, login detection, all five feed fetchers, composer (open/type/verify + caller-gated click → verified permalink), delete-post flow, per-profile launch state, Chrome launcher with WSL/detached handling. Gaps: reduced actionability-stability check, trace-event JSON artifacts instead of Playwright `.zip`, not live-tested against X yet (see `docs/rust-migration.md` → Known gaps). |
| M5: `apps/api` + `apps/worker` | pending | axum server with the same routes and response shapes; worker poll loop. |
| M6: `apps/desktop` | pending | **Decided: Tauri v2** shell replacing Electron (locked 2026-11-06). |
| M7: `apps/web` | pending | React kept or ported; decision deferred to this milestone. |
| M8: scripts, retire pnpm | pending | Port `scripts/*.mjs` to binaries. |

## Next up

Ordered by what unblocks the migration first.

1. **M4 live verification**: prepare/playback against a live logged-in profile on two accounts concurrently; requires the "explicit human ask" per housekeeping rules before live CDP runs. (M4 is ported: chromiumoxide CDP session + `CdpPage` primitives, login detection, feed fetchers, composer, delete flow.)
2. **M5-M8**: axum API and worker, Tauri desktop shell, web UI decision,
   script port.
3. **Account editing in the UI**: `PATCH /accounts/:id` accepts handle, limits,
   and profile fields, and the web UI can create an account; the Accounts panel
   still only toggles `enabled` and deletes. Surface the rest of the editable
   fields.
4. **Split the large generation and adapters files**: the remaining
   `packages/generation` and `packages/adapters` modules that mix providers,
   parsing, and pipeline logic.

## Landed from the same list

`CLAUDE.md` keeps a running "Remaining" list. These items from it are in the
tree now:

| Item | Where |
| ---- | ----- |
| Account creation flow | `POST /accounts` / `DELETE /accounts/:id` in `apps/api/src/routes/accounts.ts`, profile-path validation via `assertDedicatedProfileDir`, and an "Add account" form in the web header. |
| Schedule clearing via `PATCH /jobs/:id` | The route accepts `scheduledFor: null`, and the jobs panel has a clear-schedule action. |
| Shuffled post-all | `POST /jobs/post-ready` shuffles due `approved`/`prepared` jobs before posting them sequentially. |
| Surface quality-gate failures in the UI | `GET /drafts/quality-gate-failures` plus the "Quality gate rejections" panel in the compose view. |
| App icon and Windows code signing | Icon generated from `apps/desktop/build/icon.svg` for the window, tray, and installer; Azure Trusted Signing in the `dist-desktop-win` CI job, documented in [docs/code-signing.md](docs/code-signing.md). What is left is cutting a signed release tag. |
| OS keychain for API keys | Electron `safeStorage` encrypts `geminiApiKey` in `settings.json` (with a plaintext fallback when encryption is unavailable); the generator CLIs keep their own credentials. |
| Auto-update | `electron-updater` wired to the GitHub publish provider, with download and install-on-quit enabled. Needs a published release to exercise. |

## Deferred

- Multi-account UI. Accounts can be created, switched, enabled, and deleted, and
  each runs its own profile and CDP port; per-account limits, quiet hours, and
  profile assignment are not editable in the UI yet.
- Voice input.
- An end-to-end test suite. Coverage today is unit and API-workflow tests plus
  the parity harnesses and the smoke scripts (`pnpm smoke`, `pnpm smoke:http`,
  `pnpm smoke:adapters`, `pnpm smoke:desktop`).
