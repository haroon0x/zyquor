# Plan 008 — Production readiness (ship to users)

Executor: `codex exec -m gpt-5.6-sol -c model_reasoning_effort="high"`.
Same protocol as 006/007: dispatch → diff review → gates → commit (direct to master).

Goal: close the gap between "founder-ready" and "users can install and succeed".

| # | Task | Scope | Status |
|---|------|-------|--------|
| 8.1 | Account creation flow (POST /accounts + UI, delete/disable, per-account profile dir) | api, storage, core, web | DONE (d2b9c64) |
| 8.2 | App icon: generated .ico + electron-builder wiring + tray/window icons | desktop, build | TODO |
| 8.3 | First-run onboarding wizard (Chrome check → X login → provider check → test draft) | web, api (status endpoints exist) | DONE |
| 8.4 | Auto-update via electron-updater (GitHub releases provider), update-available UI | desktop | TODO |
| 8.5 | OS keychain for API keys (Electron safeStorage — encrypt at rest in settings.json) | desktop, api settings routes | TODO |
| 8.6 | Code signing: electron-builder Azure Trusted Signing config + CI secrets wiring + docs (cert itself is user's purchase) | build, CI, docs | TODO |

Constraints carried over: safety defaults stay OFF; no stealth; explicit post; LLM writes text only.
Known parallel work: Ollama fallback + allowlist refresh (007 tail) and docs cleanup may land between tasks.
