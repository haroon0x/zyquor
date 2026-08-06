# Zyquor on Ubuntu

Setup notes from running this on native Ubuntu 24.04 (not WSL). The `AGENTS.md`
WSL-only Electron warning does not apply here — the desktop app runs on Linux.

## Setup order

```bash
pnpm install
pnpm build        # build before bootstrap (root scripts import built dist)
pnpm bootstrap    # creates data/artifacts + profiles/personal-main
pnpm smoke && pnpm smoke:http
./zyquor          # Chrome CDP + API + web + worker
```

## Required changes vs. Windows checkout

- **Root `package.json`**: add `"@zyquor/core": "workspace:*"` and
  `"@zyquor/storage": "workspace:*"` deps — `scripts/bootstrap.mjs` imports them,
  and without the links pnpm installs nothing (bootstrap fails with
  `ERR_MODULE_NOT_FOUND`). Re-run `pnpm install` after.
- **pnpm 10 ignores build scripts** for `electron`/`esbuild`. Add
  `"pnpm": {"onlyBuiltDependencies": ["electron", "esbuild"]}` to root
  `package.json`, then `pnpm rebuild electron esbuild`. Without this,
  `node_modules/electron/dist` never exists.
- **`.env`**: `ZYQUOR_BROWSER_CDP_URL=` (empty from `.env.example`) breaks the
  `./zyquor` launcher — the `??` default doesn't fire on an empty string, so it
  probes the invalid `/json/version` and reports "Chrome CDP did not become ready".
  Set `ZYQUOR_BROWSER_CDP_URL=http://127.0.0.1:9222` (`.env.example` fixed too).
- **Chrome channel**: bundled Playwright Chromium is unsupported on newer Ubuntu;
  use system Chrome via `ZYQUOR_BROWSER_CHANNEL=chrome`. The Linux CDP launcher
  finds `google-chrome` automatically; browser automation connects over CDP, so
  no Playwright browser download is needed.
- Chrome's first launch on a cold profile is slower than the launcher's 20 s CDP
  wait — it exits; re-run `./zyquor` once Chrome is warm.

## Electron desktop app

- Runs on Linux. Verified: boots, loads `node:sqlite`, in-process API on an
  ephemeral port, worker, connects to running Chrome CDP, drafts packets.
- Needs `--no-sandbox`, or one-time SUID fix:
  `sudo chown root:root node_modules/.pnpm/electron@37.10.3/node_modules/electron/dist/chrome-sandbox && sudo chmod 4755 ...`.
- `dist:desktop*` scripts are Windows packaging only; use `pnpm dev:desktop` /
  `pnpm smoke:desktop` on Linux.
- Don't run the Electron app and `./zyquor` at the same time — both claim the
  posting Chrome profile / X session.

## Enabling posting

Set in `.env` (read at API/worker startup, so restart after):
`ZYQUOR_ENABLE_BROWSER_POST=1`. Verify with `GET /system/status` →
`posting.enablePost: true`. No desktop settings file exists in the CLI stack, so
source-packet auto-approve is allowed once `enablePost` is true.

## Restart gotchas

- `SIGTERM` to the `./zyquor` launcher doesn't always kill grandchildren
  (`pnpm --filter ... dev` → `node dist/server.js` / `node dist/index.js`).
  Stale API/worker processes hold ports and make the new worker exit with
  "Another Zyquor worker is already running". Kill them explicitly before
  relaunching: `pkill -f "dist/server.js"; pkill -f "dist/index.js"; pkill -f "zyquor.mjs"`.
- The posting Chrome (port 9222) is detached and survives restarts — expected;
  it keeps the X login.

## Healthy start looks like

- Web UI http://127.0.0.1:5173/ · API http://127.0.0.1:3001 · Chrome CDP http://127.0.0.1:9222
- Generation: `codex` / `gpt-5.6-luna` (CLIs installed natively)
- Worker auto-seeds a default news ingest config and drafts source packets.
