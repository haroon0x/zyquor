# CLAUDE.md

Guidance for agents working in this repository. Favor caution, small changes, and verifiable progress.

## Project Context

Zyquor is a local-first X posting assistant. V1 proves one account and one review-first workflow:

```text
idea -> mock draft candidates -> review/edit -> approve job -> dedicated Chrome profile -> X compose insertion
```

Controlled posting exists only behind explicit environment flags. Multi-account, scheduling, voice, and Tauri are future work unless requested directly.

## Current Implementation Status

- Workspace: pnpm monorepo.
- Apps: `apps/web`, `apps/api`, `apps/worker`.
- Packages: `core`, `accounts`, `generation`, `storage`, `browser`, `voice`.
- Persistence: SQLite via Node's experimental `node:sqlite`, with JSON fallback at `data/app.json`.
- Browser: Playwright prepare flow inserts approved text into X compose using `profiles/personal-main`; prepare-only keeps the browser window open for manual completion.
- Safety: real browser prepare requires `ZYQUOR_ENABLE_BROWSER_PREPARE=1`; real post click also requires `ZYQUOR_ENABLE_BROWSER_POST=1`.
- Duplicate guard: approving a draft stores a normalized text fingerprint and rejects repeat text for the same account.
- Daily limit guard: controlled post click checks account history before opening the browser.
- Verification gap: dependency install/check/test may fail when npm registry DNS is unavailable.

## Hard Constraints

- Use TypeScript as primary language.
- Use Playwright for browser automation.
- Use dedicated persistent Chrome profiles per X account.
- Never automate the user's everyday Chrome profile.
- Do not use browser-use as the production posting engine.
- Do not automate follows, likes, reposts, DMs, or engagement loops.
- Do not add stealth, anti-detection, proxy rotation, CAPTCHA bypassing, or evasion features.
- Keep Rust out of browser automation core.
- Keep final post action explicit and logged.

## Working Rules

1. State assumptions before coding if request is ambiguous.
2. Keep changes small and tied to the requested goal.
3. Prefer explicit state machines and typed schemas over loose statuses.
4. Keep browser automation isolated in `packages/browser`.
5. Keep generation outside UI and browser packages.
6. Keep account profile mapping explicit and inspectable.
7. Store failure artifacts and attempt state; do not hide browser failures in console logs only.
8. Do not refactor unrelated code while implementing a feature.
9. Add or update focused tests for validation, state transitions, repositories, and API workflows.
10. Run verification when dependencies/tooling are available; report exact blockers when they are not.

## Common Commands

```bash
pnpm bootstrap
pnpm smoke
pnpm dev:api
pnpm dev:web
pnpm dev:worker
pnpm check
pnpm test
```

Real browser prepare:

```bash
ZYQUOR_ENABLE_BROWSER_PREPARE=1 pnpm dev:api
```

Controlled post click:

```bash
ZYQUOR_ENABLE_BROWSER_PREPARE=1 ZYQUOR_ENABLE_BROWSER_POST=1 pnpm dev:api
```
