# M6 — `apps/desktop` (Tauri v2 shell) frozen spec

Decision locked 2026-11-06: Tauri v2 replaces Electron, same IPC surface.
React renderer (`apps/web`, built with Vite) stays; only the Electron
main/preload shell is replaced by Rust (`apps/desktop/`).

## Source surface (TS, port 1:1)

- `apps/desktop/src/settings.ts` (147 lines) — `loadSettings`/`saveSettings`
  (atomic write, `geminiApiKey` encryption via Electron `safeStorage`) +
  `applySettingsToEnv`/`applyDesktopEnvDefaults`. Keys: enableBrowserPrepare,
  enableBrowserPost, closeChromeAfterPost, headless, commandCodePath,
  opencodePath, opencodeVariant, llmProvider, geminiApiKey, chromePath,
  cdpPort, startWithWindows, feedbackDir, autoApproveSourcePackets.
- `apps/desktop/src/log.ts` (170) — buffered file logger `logs/main.log",
  5 MB rotation (`main.log.1` — remove old backup first, Windows rename
  rule), 100 ms delayed flush, 256 KiB immediate-flush threshold,
  `initFileLog`, `logLine`, `flushLogSync`, `logTail(lines)`,
  process crash handlers (log, never exit except on crashError).
- `apps/desktop/src/chrome.ts` (292) — `findChrome()` (env `ZYQUOR_CHROME_PATH`,
  win32 candidates, linux candidates incl. `CHROME_BIN` + system paths),
  `isCdpUp` (GET `{cdpUrl}/json/version`, 2 s timeout),
  `launchPostingChrome({profileDir, cdpPort})`, `closePostingChrome({cdpPort})`
  (via `closePostingChrome` crate + `dataPath(posting-chrome.json)` state —
  legacy single-record shape is read-compatible), `launchedPostingChromePid()`.
  Spawns per profile: validates dedicated profile dir, records
  `{cdpUrl, pid, profileDir}` per profile in `posting-chrome.json`,
  waits up to 15 s for CDP readiness (500 ms polls).
- `apps/desktop/src/main.ts` (745, Electron main) — boot, single-instance lock
  via `app.requestSingleInstanceLock`, `ZYQUOR_DATA_ROOT = app.userData`,
  engine/API bring-up, tray, window, updater (`zyquor:update-status` channel +
  `zyquor:update-status:get`), desktop API control surface
  (`launchPostingChrome`, `desktopSettings`, `desktopControl`:
  `closeChrome/logTail/quit/restart/setWorkerPaused/status`), shutdown
  (`quitEverything`: pause worker → stop worker → close API → close posting
  chromes → flush log, all time-boxed), external-link guard, `--headless-smoke`
  mode, `startWithWindows` login item, failed-job tray tooltip polling
  (`GET /jobs` every 60 s), API access-log stream (`makeApiLogStream`:
  JSONL over stdout of the API server, REST poll/routine-path filter).

## Rust crate layout (`apps/desktop/`)

- `Cargo.toml` — package `zyquor-desktop`, `default-run`/lib. Deps:
  `tauri = { version = "2", features = ["tray-icon"] }` (Tauri+webkit already
  installed; Linux deps present), `zyquor-api, zyquor-worker, zyquor-storage,
  zyquor-accounts, zyquor-core, zyquor-browser`, `serde/serde_json`,
  `tokio`, `reqwest`, `chrono`. Add `"apps/desktop"` to workspace members.
- `tauri.conf.json`, `build.rs`, `capabilities/` — objectProperty window
  (1024×768, title "Zyquor", icon optional), productName Zyquor,
  identifier `com.zyquor.app`, `frontendDist` pointing at built web assets.
- `src/settings.rs` — load/save (atomic write via tmp+rename), env map
  `apply_settings_to_env` (set-only-if-absent unless overwrite),
  `apply_desktop_env_defaults`. Key encryption: Tauri has no `safeStorage`;
  keep `enc:v1:` prefix + base64 but store **plaintext** with a warning when
  no keyring is available (documented gap: no secret storage on M6; the
  `settings.json` file shares the API's data root). On decrypt, treat
  `enc:v1:` values as plaintext-equivalent (they were never actually
  encrypted here) — never fail.
- `src/log.rs` — buffered writer mirror: init, line fn, flush/sync-flush,
  log_tail, rotation, no-block append.
- `src/chrome.rs` — launch/close per profile via `zyquor_browser::launch…` +
  `close_browser_cdp` + `find_chrome_executable` + `cdp_port` helpers and
  `posting-chrome.json` state; `find_chrome()` EXE resolution per platform;
  `is_cdp_up()` w/ timeout.
- `src/controls.rs` — `DesktopControl` handlers: `close_chrome`,
  `log_tail`, `quit`, `restart`, `set_worker_paused`, `status` (appVersion
  from `CARGO_PKG_VERSION`, platform, dataRoot, per-account chrome state) +
  `launch_posting_chrome({accountId})`; startWithWindows login-item wiring
  via Tauri `autostart` plugin or documented `cargo tauri`/`autostart-plugin`
  flag (best effort; report if unavailable).
- `src/main.rs` — Tauri app setup invocation, single-instance plugin,
  `setup` closure: init log, settings→env, DB ensure, `zyquor_api::build_app`
  with browser options from env, bind port 0, start `zyquor_worker`
  (`start_worker`, apiUrl local), tray + window load of web dist, external
  link guard (`on_navigation` + new-window), fried-job tooltip poll,
  `update-status` channel + `update-status:get` Tauri command (WebviewWindow
  event publish; updater polling stubbed to null status — electron-updater
  has no Tauri equivalent yet; document gap), `--headless-smoke` path (boot,
  `/accounts`+`/worker/status` fetch, shutdown, exit code), shutdown sequence
  (pause → worker stop → api close → chrome close → flush), `--hidden` tray
  startup.

## IPC surface (web renderer-facing)

`window.zyquor = { apiBaseUrl, appVersion, updates: { getStatus, onStatus } }`
exposed in the webview `initialization_script` (Tauri `window.eval` injection
on `WindowBuilder::initialization_script`), same field names.

## Deviations to document (not invent)

- `electron-updater` auto-update: Tauri updater plugin needs signing keys +
  publish config; keep the update-status **channel** (poll interval, states)
  but wire it to an `autoUpdateEnabled: false` stub. If `tauri-plugin-updater`
  is infeasible here, log a gap entry and leave the channel returning
  `null` (same as TS when `app-update.yml` is absent).
- `startWithWindows`/`app.setLoginItemSettings`: implement via the
  autostart plugin if it downloads; else if it doesn't compile offline,
  document "applied on Windows via autostart plugin when built with network"
  and skip run-time wiring on this box (report clearly).
- `safeStorage`: no secret store in M6 — `geminiApiKey` stored plaintext in
  `settings.json` (mode is dataRoot-default) + decrypt compat. Gap note in
  `docs/rust-migration.md`.
- Single-instance: Tauri `single-instance` plugin; if it doesn't compile,
  emulate via a lock file + IPC wake (document).
- Tray/context menu: replicate the 5 items (Open / Restart to update [hidden
  until update ready] / Launch posting Chrome / Stop everything / Quit) with
  the same tooltip rules (default "Zyquor", "— {msg}" suffixes).
- Updating (6 h interval) applies only when a release artifact is published;
  keep the poll loop but gate on `app-update.yml` (packaged only).
- `ZYQUOR_DATA_ROOT` default: Tauri `app-data` dir.

## Verification

- `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --
  -D warnings`, `cargo test --workspace` (all green; add unit tests for
  settings/log/chrome helpers where pure).
- Headless smoke: `zyquor-desktop -- --headless-smoke` with a scratch
  `ZYQUOR_DATA_ROOT` boots API on port 0 + worker + exits 0 without Chrome,
  log line "HEADLESS SMOKE OK" equivalent.
- Do NOT delete any TS file in this milestone (the electron `apps/desktop/src`
  stays until M8). Do NOT touch `apps/api/**`, `apps/worker/**`, `crates/**`,
  docs (the coordinator updates docs at the end).
