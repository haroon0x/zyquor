# Zyquor TODO

## E2E Core

- [x] Keep V1 scope: idea -> drafts -> review/edit -> approve -> prepare/post job.
- [x] Preserve dry-run prepare for sandbox/dev.
- [x] Wire generation through provider interface.
- [x] Support `mock`, `ollama`, and `gemini` providers.
- [x] Expose selected provider through API health/config endpoint.
- [x] Add provider tests with fake fetch.
- [x] Add API workflow test using real provider interface.
- [x] Update `.env.example`, README, and dev docs.
- [x] Run `pnpm build`, `pnpm check`, `pnpm test`, `pnpm smoke`, `pnpm smoke:http`, `pnpm smoke:generation`.

## Manual Runtime

- [x] Run `pnpm dev:api`; sandbox localhost listen now works.
- [x] Run `pnpm dev:web`; sandbox localhost listen now works.
- [ ] Test Ollama with local model via `ZYQUOR_LLM_PROVIDER=ollama`.
- [ ] Test Gemini with API key via `ZYQUOR_LLM_PROVIDER=gemini`.
- [ ] Test real browser prepare only after X profile login exists.
