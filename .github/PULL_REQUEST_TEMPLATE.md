## Summary

<!-- What changes, and why. One or two sentences. -->

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Migration port (state the milestone: M0-M8)
- [ ] Refactor (no behaviour change)
- [ ] Docs or tooling
- [ ] Test only

## Verification

Check what you actually ran, and paste the failure output if something is
skipped.

TypeScript:

- [ ] `pnpm check`
- [ ] `pnpm test`
- [ ] Other (state it: `pnpm smoke`, `pnpm smoke:adapters`, `pnpm dev:desktop`)

Rust:

- [ ] `cargo fmt --all --check`
- [ ] `cargo clippy --workspace --all-targets -- -D warnings`
- [ ] `cargo test --workspace`

Parity, for a migration PR:

- [ ] The ported crate's parity harness passes against the TypeScript output
      (see `docs/rust-migration.md`)

## Safety rails

- [ ] Dedicated Chrome profiles only (under `profiles/`); no everyday profile.
- [ ] No stealth, anti-detection, proxy rotation, or CAPTCHA bypass added.
- [ ] No automated follows, likes, reposts, DMs, or engagement loops.
- [ ] Browser automation stays in `packages/browser` / `crates/zyquor-browser`;
      generation and UI code do not drive a browser.
- [ ] The LLM still only writes candidate text; it does not browse, schedule,
      rank, or decide to post.
- [ ] Failed post jobs are still never auto-retried.
- [ ] Posting is still disabled by default behind
      `ZYQUOR_ENABLE_BROWSER_PREPARE` / `ZYQUOR_ENABLE_BROWSER_POST`.
- [ ] Agent-driven approvals still send `screened: true`.
- [ ] No cookies, tokens, `.env` values, or `profiles/` contents are committed
      or pasted in this PR.

If any box cannot be checked, explain why above.

## Linked issue

<!-- Fixes #... / Closes #... / Refs #... -->
