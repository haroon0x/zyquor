# Contributing to Zyquor

Zyquor is a local-first X posting assistant: drafts are generated, reviewed, and
posted through a dedicated Chrome profile. The project is mid-migration from
TypeScript to Rust, so two toolchains are live and both must stay green. See
[docs/rust-migration.md](docs/rust-migration.md) for the crate map, milestones
M0-M8, and the parity rules.

Read [AGENTS.md](AGENTS.md) and [docs/development.md](docs/development.md) before
changing behaviour. They record the layering rules and the current runtime
layout.

## Toolchain

- Node 24 (what CI runs) and pnpm 10 (`packageManager` in `package.json`).
- Stable Rust via `rustup`; `rust-toolchain.toml` pins the channel and the
  `rustfmt` + `clippy` components.

## TypeScript stack

The TypeScript tree still runs the product. From the repo root:

```bash
pnpm install
pnpm bootstrap
pnpm build
pnpm test
pnpm dev:api
pnpm dev:web
```

- `pnpm check` builds and type-checks every package; CI runs `pnpm install
  --frozen-lockfile`, `pnpm check`, and `pnpm test`.
- `pnpm dev:worker` starts the background worker; `pnpm dev:desktop` builds and
  launches the Electron app. Run the desktop app from native Windows, never from
  WSL.
- Create a local `.env` from `.env.example` before using a real generator or a
  real browser action.

### Ports

The API listens on port 3000 by default. When `ZYQUOR_API_PORT` is unset and
port 3000 is already taken, it falls back to 3001; that fallback does not apply
when `ZYQUOR_API_PORT` is set explicitly. On a machine where 3000 is occupied
(as on the maintainer's), run:

```bash
ZYQUOR_API_PORT=3001 pnpm dev:api
ZYQUOR_API_URL=http://127.0.0.1:3001 pnpm dev:web
```

The web UI reads `ZYQUOR_API_URL` for its `/api` proxy, so both variables must
agree.

## Rust workspace

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

The workspace currently has `crates/zyquor-core`, `crates/zyquor-accounts`,
`crates/zyquor-storage`, and `crates/zyquor-generation`. Write new work in the
Rust crate once it exists for that concern; do not add new TypeScript packages.

## Migration ground rule

Both stacks stay green until a package is retired.

- A TypeScript package or script is not deleted until its Rust replacement
  passes the parity harness described in
  [docs/rust-migration.md](docs/rust-migration.md).
- A port commit that also changes behaviour is rejected: same HTTP routes and
  response shapes, same SQLite rows, same generated text for the same input,
  same safety rails.
- Every milestone ends with green `cargo test` plus a parity check against the
  TypeScript implementation.

## Safety rails

These are product behaviour, not preferences. A patch that weakens any of them
will not be merged, and a PR that touches them should say why in its
description.

- Dedicated Chrome profiles only, under `profiles/`. Never the everyday browser
  profile. Profile paths are validated by `assertDedicatedProfileDir` in
  `packages/accounts`.
- No stealth, anti-detection patching, proxy rotation, or CAPTCHA bypass.
- No automated follows, likes, reposts, DMs, or engagement loops. The product
  drafts and posts its own content; it does not farm interactions.
- Browser automation stays isolated in `packages/browser` and, after the port,
  `crates/zyquor-browser`. Generation and UI code never drive a browser.
- The LLM only writes candidate text. It never browses, scrapes, schedules,
  ranks, or decides whether to post.
- A failed external post job is never auto-retried: the browser action may have
  reached X even though it reported failure. `POST /jobs/:id/retry` is a
  verify-then-retry path that only runs on an explicit human ask.
- Posting is off by default. `ZYQUOR_ENABLE_BROWSER_PREPARE=1` and
  `ZYQUOR_ENABLE_BROWSER_POST=1` are the only way to enable the prepare and post
  actions, and real posting also respects the account's daily limit, quiet
  hours, and post gap.

## Tests

Add focused tests for the thing you changed:

- state transitions in `packages/core` (`state.ts` and its tests),
- repositories in `packages/storage`,
- API workflows through `app.inject` in `apps/api/src/*.test.ts`,
- Rust parity fixtures under `crates/<crate>/tests/`.

`pnpm test` builds and then runs vitest per package. Do not add a test that
requires a live X session, a live generator, or a real Chrome profile; use the
existing injection points (`buildApp` options, fixture providers) instead.

## Commits and pull requests

- Use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`,
  `chore:`), with a scope where it helps: `feat(browser): ...`,
  `fix(rust): ...`.
- Keep PRs small and tied to one change. Do not refactor unrelated code in the
  same PR.
- Fill in the PR template: what changed, which type of change, the verification
  commands you actually ran, and the linked issue.
- Agent-driven approvals must send `screened: true` on
  `POST /drafts/:id/approve`. The server then rejects text that fails
  `isCleanTweetText`, the deterministic quality floor, or the raw length check
  with `409 Approval screen failed: ...`. Humans omit the flag to override by
  judgement; agents do not.
- Migration PRs state the milestone (M0-M8) and the parity check they ran.

## Licensing

Contributions are accepted under AGPL-3.0; see [LICENSE](LICENSE).
