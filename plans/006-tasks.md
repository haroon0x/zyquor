# Plan 006 — Task tracker (Electron desktop app)

Companion to `plans/006-electron-desktop-app.md` (full task specs live there).
Executor: command-code CLI with deepseek/deepseek-v4-pro, orchestrated by Claude
(dispatch → diff review → gate verification → commit). One commit per task.

| Task | Title | Status | Commit | Notes |
|------|-------|--------|--------|-------|
| 0.1 | Configurable data root (`ZYQUOR_DATA_ROOT`) | DONE | `ec0c712` | 1 correction: workspace-root fallback precedence regression |
| 0.2 | Split api app.ts into route modules | DONE | `f6cf5bc` | 1603→123 lines; behavior-neutral (verified via stash-baseline test run) |
| 0.3 | Embeddable `startWorker()` with stop/finished | DONE | `9c13e36` | 1 correction: startup failure must reject (was silent hang) |
| 1.1 | Electron shell scaffold (`apps/desktop`) | DONE | `edb5221` | Electron ^37 (Node 22.16); logic-smoke replaces GUI smoke on WSL |
| 1.2 | Web UI loadable from Electron | DONE | `76ca618` | apiUrl() helper, Vite base ./, build-only CSP; 1 transient CLI failure, retried |
| 1.3 | Shared first-run bootstrap | DONE | `63a183e` | ensureFirstRun() in storage; executor lost connection, orchestrator finished verify |
| 2.1 | Chrome discovery + CDP launch | DONE | `593cdd0` | Electron-only POST /browser/launch-chrome; win32 paths manual-verify |
| 2.2 | node:sqlite runtime probe | DONE | `1ec667c` | Light variant (Electron 37 has node:sqlite); createRequire dodges vitest resolver |
| 2.3 | settings.json replaces .env | DONE | `207fb14` | Masked GET/PATCH /settings; UI panel gated on window.zyquor |
| 3.1 | electron-builder packaging | DONE | `6348cf0` | playwright→playwright-core; 13MB asar verified; Windows NSIS via CI job |
| 3.2 | Background-first optimization | DONE | `8452f80` | 1 correction: profile dirs resolved vs cwd (packaged-app breaker), startup Chromium launch skipped when posting disabled |
| 3.3 | Ship polish (logging, version, docs) | DONE | see final commit | main.log rotation, tray tooltip failures, version footer, docs update |

## Standing verification gates (run per task)

1. `pnpm check` — all 11 packages typecheck.
2. Package tests for touched packages. Known pre-existing failures (present on
   the `e575fdb` baseline, NOT caused by this work): 6 in
   `apps/api/src/app.test.ts` (tweet post-process casing/ingest), and
   env-only failures in `packages/browser` (`libnspr4.so` missing on this WSL).
3. `ZYQUOR_DATA_ROOT=/tmp/<fresh> pnpm smoke:desktop` → `LOGIC SMOKE OK`,
   correct storage line, no stray writes outside the data root.

## Manual verification queue (Windows required)

- Run `pnpm dist:desktop` (or CI `dist-desktop-win` job) → install NSIS exe.
- App launches from Program Files; data lands in `%APPDATA%\Zyquor`.
- Tray: open/quit, window destroy/recreate, `--hidden` startup, start-with-Windows toggle.
- "Launch posting Chrome" finds system Chrome, CDP on 9222, `GET /browser/x-session` reflects login.
- Prepare a job dry-run end-to-end; explicit post with `ZYQUOR_ENABLE_BROWSER_POST=1`.
- Idle RSS with window closed (target < 150 MB main process).

## Deferred / future work

- App icon (.ico) and Windows code signing.
- OS keychain for API keys (currently plain JSON in userData, documented).
- ~~Fix the 6 pre-existing api test failures~~ — DONE in final commit (stale expectations from e575fdb lowercasing + missing quality field in test providers; generation suite also fixed).
- Auto-update (electron-updater).
- Tauri migration remains possible: Phases 0/2 work transfers; only the shell layer would change.
