# Plan 006 — Zyquor Electron Desktop App (Windows, background-first)

**Status:** approved, not started
**Decision (2026-07-07):** Electron over Tauri. Rationale: backend is 100% TypeScript/Node (Fastify, Playwright, node:sqlite); Electron runs it in-process with no sidecar packaging, no Rust toolchain, no child-process lifecycle management. App is tray-resident with window closed by default, so idle RAM difference vs Tauri is ~30–50 MB (renderer destroyed when window closed). Real Chrome spawned for posting dwarfs both. Tauri migration stays possible later — Phases 0/2 work transfers unchanged.

**Executor:** tasks below are written as self-contained prompts for command-code CLI (DeepSeek v4 pro). Each task lists files, exact changes, and verification. Orchestrator (Claude) dispatches tasks in order, reviews diffs between tasks, and runs the gate commands.

**Global rules for the executor (repeat in every task prompt):**
- TypeScript only. No refactors outside the named files. Keep changes minimal and typed.
- Never touch `packages/browser` automation semantics: no stealth, no engagement automation, final post action stays explicit and logged.
- After every task: `pnpm check` and `pnpm test` must pass. Report exact failures verbatim; do not paper over them.
- Do not commit; leave changes in working tree for orchestrator review.

**Current facts (verified against code):**
- `apps/api/src/app.ts` is 1602 lines; `buildApp(options)` factory already exists at line 624. `server.ts` (40 lines) boots it.
- Worker already exports `runWorker(options)`, `runWorkerCycle`, `checkWorkerStartup` from `apps/worker/src/index.ts` — in-process start is already possible.
- Hardcoded paths: `packages/storage/src/memory.ts:18` (`data/app.json`), `packages/storage/src/sqlite.ts:258` + `memory.ts:51` (`profiles/personal-main`), `packages/browser/src/index.ts:17` (workspace root from `process.cwd()`, env `ZYQUOR_WORKSPACE_ROOT` exists), `:22` (hardcoded WSL profile path `/mnt/c/Users/asus/...`), `:54,:387` (`profiles/chrome-config` relative).
- Web UI: Vite 6 + React 19, no router libs, builds static.
- Node/Electron constraint: `node:sqlite` requires Node ≥22.5. Electron ≥33 ships Node 20.x; Electron 35+ ships Node 22.x. **Pin Electron to a version with Node ≥22.5, else swap storage to better-sqlite3 (Task 2.2 fallback).**

---

## Phase 0 — Framework-agnostic refactor

### Task 0.1 — Configurable data root
**Goal:** all disk paths resolve from one base dir instead of CWD.
- Add `packages/core/src/paths.ts`: `export function resolveDataRoot(): string` — returns `process.env.ZYQUOR_DATA_ROOT` if set, else `process.cwd()`. Export helpers `dataPath(...segments)`, `profilesPath(...segments)` that join from data root. Re-export from `packages/core/src/index.ts`.
- `packages/storage/src/memory.ts`: `DEFAULT_JSON_DATABASE_PATH` becomes `dataPath("data", "app.json")` resolved at construction time (keep the exported constant name; make it a function `defaultJsonDatabasePath()` if a constant can't be lazy — update call sites).
- `packages/storage/src/sqlite.ts`: same treatment for its default DB path.
- `packages/browser/src/index.ts:17`: workspace root becomes `ZYQUOR_DATA_ROOT ?? ZYQUOR_WORKSPACE_ROOT ?? resolve(process.cwd(), "../..")` (preserve back-compat). Line 22: gate the WSL `/mnt/c/Users/asus/...` path behind an env check (`ZYQUOR_WSL_PROFILE_BASE`), never hardcoded username. Lines 54/387: resolve `profiles/chrome-config` via `profilesPath`.
- `packages/accounts` profile validation (`must live under profiles/`) must still pass for absolute paths under the data root — adjust `assertDedicatedProfileDir` to accept `<dataRoot>/profiles/...`.
- Tests: add unit tests for `resolveDataRoot` with/without env; update any tests asserting the old literals.
**Verify:** `pnpm check && pnpm test`; then `ZYQUOR_DATA_ROOT=/tmp/zyq-test pnpm smoke` writes under `/tmp/zyq-test/data/`.

### Task 0.2 — Split apps/api/src/app.ts into route modules
**Goal:** `app.ts` becomes a thin composition file; behavior identical.
- Create `apps/api/src/routes/` with one module per resource, matching CLAUDE.md route groups: `drafts.ts`, `batches.ts`, `jobs.ts`, `source-packets.ts`, `ingest.ts`, `style-profiles.ts`, `generation.ts`, `browser.ts`, `accounts.ts`, `history.ts`, `worker.ts`.
- Each exports `registerXRoutes(app: FastifyInstance, deps: AppDeps)`. Define `AppDeps` (repositories, generation client, browser functions, config) in `apps/api/src/deps.ts` — extract from the current `buildApp` options/closures.
- `buildApp` keeps its exact signature and behavior (same options, same CORS, same error shapes). Pure mechanical move: no route logic changes, no renamed response fields.
- Move shared helpers (validation, mode derivation) to `apps/api/src/lib/` only if used by >1 route module; otherwise keep them in the route file.
**Verify:** `pnpm check && pnpm test` (api tests in `app.test.ts` must pass unmodified — if a test needs edits, that signals a behavior change: stop and report).

### Task 0.3 — Worker embeddable entrypoint
**Goal:** worker startable/stoppable in-process.
- In `apps/worker/src/index.ts` add `export function startWorker(options: WorkerOptions): { stop(): Promise<void> }` wrapping the existing `runWorker` loop with an abort/stop signal (clear interval/loop flag, await in-flight cycle).
- Keep the CLI entry (`node dist/index.js`) working exactly as before.
- Test: start with mock deps, assert a cycle runs, stop, assert no further cycles.
**Verify:** `pnpm check && pnpm test`.

**Phase 0 gate (orchestrator):** full `pnpm check`, `pnpm test`, `pnpm smoke`, plus manual `./zyquor` boot confirming API on :3000 and web on :5173 behave as before.

---

## Phase 1 — Electron shell (`apps/desktop`)

### Task 1.1 — Scaffold
- New workspace package `apps/desktop`: `package.json` (deps: `electron` pinned to a Node≥22.5 release, devDeps: `electron-builder`, `typescript`), `tsconfig.json` matching repo conventions, `src/main.ts`, `src/preload.ts`.
- `main.ts` responsibilities, in order:
  1. `app.requestSingleInstanceLock()` — quit if not obtained; focus existing window on second launch.
  2. Set `ZYQUOR_DATA_ROOT = app.getPath("userData")` **before** importing any zyquor package (use dynamic `await import` after env is set).
  3. Boot API in-process: `const api = buildApp({...}); await api.listen({ host: "127.0.0.1", port: 0 })` — capture the assigned port.
  4. Start worker in-process via `startWorker(...)` from Task 0.3.
  5. Create `BrowserWindow` with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; load built web UI (Task 1.2). Window `close` → hide to tray, not quit.
  6. Tray icon: menu with Open, Worker status, Quit. Quit = stop worker, close API, `app.quit()`.
- `preload.ts`: `contextBridge.exposeInMainWorld("zyquor", { apiBaseUrl: "http://127.0.0.1:<port>" })` (port passed via `additionalArguments` or IPC handshake).
- Dev script: `pnpm --filter @zyquor/desktop dev` = build then `electron dist/main.js`.
**Verify:** `pnpm check`; on a machine with a display: app launches, tray appears, `GET <apiBaseUrl>/accounts` returns 200. On WSL/headless, verify main.ts compiles and API+worker boot logic via a `--headless-smoke` flag that skips window creation, hits the API, and exits 0. **Note for executor: full GUI verification happens on Windows; do not fail the task on missing display — implement the headless smoke and report.**

### Task 1.2 — Web UI served from the app
- Web build must call the API at a runtime-provided base URL: replace any hardcoded `http://127.0.0.1:3000` in `apps/web/src` with `window.zyquor?.apiBaseUrl ?? "http://127.0.0.1:3000"` (fallback keeps browser dev flow working). Add a typed `window.zyquor` declaration.
- Electron loads via `win.loadFile(<path to apps/web/dist/index.html>)`. Ensure Vite `base: "./"` so assets resolve from file://.
- Strict CSP meta tag in built index.html allowing only self + `http://127.0.0.1:*` connect-src.
**Verify:** `pnpm --filter @zyquor/web build` succeeds; browser dev mode (`pnpm dev:web` + `pnpm dev:api`) still works.

### Task 1.3 — First-run bootstrap
- On first launch (no `<userData>/data/app.json` and no sqlite db): create `data/`, `profiles/` dirs under userData; seed default account (reuse existing bootstrap logic from `scripts/bootstrap.mjs` — extract shared parts into `packages/storage` or `packages/accounts` rather than duplicating).
**Verify:** delete userData dir, launch headless smoke, assert dirs + default account exist.

**Phase 1 gate:** headless smoke green in CI/WSL; manual GUI run on Windows shows UI, drafts flow works end-to-end with mock provider.

---

## Phase 2 — Windows integration

### Task 2.1 — Chrome discovery + CDP launch from main process
- New `apps/desktop/src/chrome.ts`: locate system Chrome on Windows (check `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LocalAppData%` standard paths; fall back to `where chrome`), port the launch logic from `scripts/start-chrome.ps1` and `scripts/open-x-profile-cdp.mjs` to TypeScript: spawn Chrome with `--remote-debugging-port=9222 --user-data-dir=<dataRoot>/profiles/personal-main`.
- Expose via tray menu item "Launch posting Chrome" and an IPC-backed button in the web UI (route through the existing API: add `POST /browser/launch-chrome` guarded so it only exists when running inside Electron — inject as an optional dep in `AppDeps`).
- Never touch the user's everyday Chrome profile; only profiles under data root. Detect an already-running CDP session (probe `http://127.0.0.1:9222/json/version`) and reuse instead of double-launch.
**Verify:** `pnpm check && pnpm test`; unit-test path discovery with mocked fs; manual on Windows.

### Task 2.2 — SQLite runtime check
- At desktop startup, probe `node:sqlite` availability (`await import("node:sqlite")` in try/catch). If unavailable in the pinned Electron's Node: **fallback plan** — add `better-sqlite3` implementation of the storage repository interface in `packages/storage/src/better-sqlite3.ts` (same tests as sqlite.ts, parameterized over impl), select impl at runtime. Only implement the fallback if the probe actually fails on the pinned Electron; otherwise this task is a 5-line startup assertion.
**Verify:** headless smoke logs which impl is active; storage tests pass against active impl.

### Task 2.3 — Settings instead of .env
- `apps/desktop/src/settings.ts`: JSON config at `<userData>/settings.json` for: LLM provider + API keys, `ZYQUOR_ENABLE_BROWSER_PREPARE/POST`, Chrome path override, CDP port. Loaded at startup **before** package imports, written into `process.env` (existing precedence rules unchanged: saved generation.json > env).
- Minimal settings section in web UI (new panel calling new `GET/PATCH /settings` routes, Electron-only dep like 2.1). Keys stored plain in userData (documented; OS keychain is future work — note it, don't build it).
**Verify:** change provider via UI → `GET /generation` reflects it after restart.

**Phase 2 gate:** on Windows — launch app, launch posting Chrome from tray, `GET /browser/x-session` shows login state, prepare a job dry-run.

---

## Phase 3 — Packaging & optimization

### Task 3.1 — electron-builder config
- `apps/desktop/electron-builder.yml`: NSIS target, x64, asar enabled, app id `so.brace.zyquor` (adjust), icon placeholder.
- Two-package pattern: desktop `package.json` lists only runtime deps; bundle built `dist/` of all workspace packages (use `files` globs; verify no `src/`, tests, or dev deps land in the asar).
- **Exclude Playwright browser downloads** (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` at install/build; runtime uses system Chrome via `channel: "chrome"` / CDP connect — confirm `packages/browser` connect path doesn't require bundled Chromium; if `playwright` full package is only used for CDP connect, depend on `playwright-core` instead and update imports).
- CI: extend `.github/workflows` with a Windows build job producing the NSIS artifact (build only, no signing yet; note code-signing as future work).
**Verify:** `pnpm --filter @zyquor/desktop dist` produces installer < 130 MB; install on Windows, app runs from `Program Files` with data in `%APPDATA%/zyquor`.

### Task 3.2 — Background-first optimization
- Lazy-load heavy modules: `packages/browser` (playwright-core) and generation providers imported dynamically at first use, not at API boot. Measure: main-process RSS at idle (tray, window closed) target < 150 MB.
- On-demand Chrome: after a post job completes (or N minutes idle), offer/perform Chrome shutdown (config flag, default off — closing the user's session Chrome is user-visible; make it explicit opt-in).
- Window closed by default on auto-start; `app.setLoginItemSettings` opt-in "Start with Windows" toggle in settings.
- Renderer: no changes needed beyond ensuring window destruction on close (hide vs destroy: destroy to reclaim RAM, recreate on tray Open — implement destroy+recreate).
**Verify:** log RSS at idle in headless smoke; assert lazy imports via a test that boots API and checks playwright is not in `process.moduleLoadList`/require cache.

### Task 3.3 — Ship polish
- Crash/error surface: main-process unhandled errors logged to `<userData>/logs/main.log` (rotate at 5 MB); worker failures already stored as attempt artifacts — surface count in tray tooltip.
- Version display in UI footer from `app.getVersion()`.
- Update docs: README "Desktop app" section, CLAUDE.md Current Runtime section, `docs/development.md`.
**Verify:** `pnpm check && pnpm test`; docs mention matches actual commands.

**Phase 3 gate / definition of done:** clean Windows machine → run installer → app in tray → open window → generate draft (mock provider) → launch posting Chrome → prepare dry-run → job history visible → quit cleanly, no orphan processes.

---

## Orchestration protocol (Claude ↔ command-code/DeepSeek)

1. Precondition: working tree committed/stashed (currently dirty — must be resolved before Task 0.1).
2. One task per executor invocation, prompt = the task section verbatim + global rules + relevant file excerpts if the executor lacks repo context.
3. After each task: orchestrator reviews the diff (correctness + scope creep), runs the verify commands, and either accepts (commit `feat(desktop): task N.N — <title>`) or returns a correction prompt with the exact failure.
4. Tasks within a phase are sequential (each builds on the last). Phases are strictly sequential with gates.
5. Anything the executor cannot verify (Windows GUI, installer) is flagged `manual-verify` and queued for the user.

## Risks
- **Electron/Node version vs node:sqlite** — resolved by Task 2.2 probe + fallback. Biggest unknown.
- **playwright vs playwright-core packaging** — checked in Task 3.1; worst case ship full playwright (+~5 MB, acceptable).
- **WSL dev vs Windows target** — GUI/browser tasks are only fully verifiable on Windows; headless smokes keep CI honest.
- **X UI changes breaking posting** — out of scope; unchanged from today.
