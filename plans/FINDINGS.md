# Remaining Audit Findings

These are unresolved risks from the 2026-06-12 audit. Completed findings and
their implementation plans were removed during plan cleanup. The active work
queue lives in `CLAUDE.md` under `Next Steps`.

## Dual storage implementations

`packages/storage/src/sqlite.ts` and `packages/storage/src/memory.ts` still
implement the same repository surface independently. Storage features must be
kept in lockstep across both backends, which remains a source of duplication
and drift. Consolidation needs a focused storage audit before implementation.

## Untrusted source content in the autopost lane

Scraped source content still reaches generation before deterministic quality
checks decide whether a draft can enter the autopost lane. The shipped quality
gate rejects formatting, quality, slop, URL, and cooldown failures, but it is
not a complete prompt-injection defense. Browser posting remains disabled by
default; newly added or untrusted sources should stay in the review lane until
a dedicated hardening design lands.
