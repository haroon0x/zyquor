# Handoff: continuing the Rust migration

Read this first, then the brief for the milestone you are picking up.

- `docs/rust-migration.md` — the plan of record (crate layout, M0–M8, parity harness, deliberate removals).
- `docs/handoff/bloat-audit.md` — parts of the codebase that are probably **not worth porting**. Check with the owner before deleting; do not port them by default.
- `docs/handoff/m3-generation.md`, `m4-browser.md`, `m5-api-worker.md` — task briefs.

## Where things stand

| Milestone | State |
| --- | --- |
| M0 scaffold | done |
| M1 `zyquor-core` | done |
| M2 `zyquor-accounts` + `zyquor-storage` (SQLite) | SQLite surface complete; JSON fallback not ported |
| M3 `zyquor-generation` | config + quality scoring ported; providers, `prompts.ts`, `refine.ts` not ported |
| M4 browser, M5 api/worker, M6 desktop, M7 web, M8 scripts | not started |

80 Rust tests pass. The TypeScript tree still runs the product; nothing has been deleted.

## Ground rules

1. **Do not delete TypeScript until its Rust replacement passes the parity harness.** Both stacks stay green.
2. **No behaviour changes ride along with a port commit.** If you find a bug in the TypeScript, report it separately.
3. **Prove parity, do not assert it.** Every ported module needs one of:
   - a golden fixture captured from the TypeScript output, or
   - a cross-implementation diff (run both, compare), or
   - a cross-database check for storage work.
4. **Record gaps.** When you stop mid-crate, add the gap to the "Known gaps" section of `docs/rust-migration.md`.
5. **Toolchain**: stable Rust via rustup (`~/.cargo/env` sourced from `~/.bashrc`/`~/.profile`). No unsafe code — the workspace denies it (`unsafe_code = "forbid"`), and `clippy::unwrap_used`/`expect_used`/`panic` are denied in library code (tests are exempt via a file-level `#![allow(...)]`).

## Verification

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

pnpm check   # TypeScript must stay green too
pnpm test
```

Parity harnesses already in the repo:

```bash
# per-profile CDP URLs: Rust vs TypeScript
cargo run -q -p zyquor-core --example cdp_parity

# lifecycle transitions + post gate: Rust vs TypeScript
cargo run -q -p zyquor-core --example parity

# quality scoring / formatting: Rust vs TypeScript
cargo run -q -p zyquor-generation --example quality_parity < cases.txt
```

Each prints one line per case. Compare against the TypeScript side with a
key-sorted JSON diff — **not** a raw `diff`, because field order differs
between `serde_json` and `JSON.stringify`.

## Rules of thumb learned here

- TypeScript regexes are not Rust regexes. Rust's `regex` has no lookaround;
  the quality port uses `fancy-regex` for `(?! …)`. Always run a parity diff —
  two bugs were caught this way (default-port elision, check ordering).
- `Number.isFinite` / `Math.round` semantics differ from Rust's `f64::round`
  only for NaN; model NaN as `Option<f64>` and handle it explicitly.
- Never mutate process env in Rust tests (`set_var` is `unsafe` in edition
  2024). Env-reading functions take an `EnvLookup` (`&dyn Fn(&str) -> Option<String>`)
  and expose a `*_with` variant for tests.
- rusqlite is synchronous. When the axum API lands, wrap DB calls in
  `tokio::task::spawn_blocking`; never block the executor.
