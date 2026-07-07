# Plan 004: Re-align OpenRouter model documentation with the code allowlist

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 91f3988..HEAD -- packages/generation/src/index.ts CLAUDE.md docs/`
> The allowlist in code is the source of truth — re-read it fresh in Step 1
> regardless of drift.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (documentation only)
- **Category**: docs
- **Planned at**: commit `91f3988` (with uncommitted generation changes in the working tree), 2026-06-12

## Why this matters

The OpenRouter free-model allowlist in
`packages/generation/src/index.ts` was changed (default now
`openrouter/owl-alpha`; `minimax/minimax-m2.5:free`, `tencent/hy3-preview:free`,
and `inclusionai/*` models were removed) but `CLAUDE.md` still tells every
agent: "Preferred provider is OpenRouter with free models
(nvidia/nemotron-3-super-120b-a12b:free, minimax/minimax-m2.5:free,
tencent/hy3-preview:free)". Setting `ZYQUOR_OPENROUTER_MODEL` to a documented
but delisted model silently coerces to the default via `safeOpenRouterModel()`,
which is confusing to debug. Stale docs that agents actively read are worse
than no docs. This drift already broke five tests once.

## Current state

- `packages/generation/src/index.ts` — `OPENROUTER_MODELS` array (near the top
  of the file, around lines 54–68 in the 2026-06-12 working tree) lists the
  allowed free models; `DEFAULT_OPENROUTER_MODEL = "openrouter/owl-alpha"`.
  `safeOpenRouterModel()` (further down) coerces any model not in the list to
  the default.
- `CLAUDE.md` — section "### Generation Provider Resolution", last bullet
  names the old preferred models (minimax, tencent — no longer in the list).
- `docs/development.md` — check whether it repeats model names (it has
  uncommitted edits in the working tree; read it fresh).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Read live allowlist | `grep -n -A14 "OPENROUTER_MODELS = \[" packages/generation/src/index.ts` | prints the current array |
| Find stale mentions | `grep -rn "minimax\|tencent\|inclusionai\|nemotron\|owl-alpha" CLAUDE.md docs/ README.md TODO.md` | lists every doc mention |
| Generation tests still green | `cd packages/generation && pnpm exec vitest run --pool=threads` | all pass |

Note: if `pnpm` is not on PATH, use `node "$(npm root -g)/pnpm/bin/pnpm.cjs"` (per CLAUDE.md).

## Scope

**In scope** (docs only):
- `CLAUDE.md` — the "Generation Provider Resolution" bullet listing preferred models.
- `docs/development.md` and `README.md` — only lines that name OpenRouter models.

**Out of scope** (do NOT touch):
- `packages/generation/src/index.ts` and its tests — code is the source of
  truth; this plan moves docs toward code, never the reverse.
- Any other CLAUDE.md content.

## Steps

### Step 1: Extract the live list

Run the "read live allowlist" command and copy the exact current model ids and
the current default.

**Verify**: you have the literal array contents from the working tree, not
from this plan.

### Step 2: Update every stale doc mention

In each file found by the "find stale mentions" command, replace outdated
model names so the docs state: the default model, that the full allowlist
lives in `OPENROUTER_MODELS` in `packages/generation/src/index.ts`, and that
out-of-list values are silently coerced to the default. Prefer pointing at the
code over duplicating the whole list (one name + pointer beats a copy that
will rot again).

**Verify**: `grep -rn "minimax/minimax-m2.5:free\|tencent/hy3-preview:free" CLAUDE.md docs/ README.md` → no matches (unless the live code still contains them, per Step 1).

### Step 3: Confirm nothing else changed

**Verify**: `git status` shows only the in-scope doc files modified;
generation tests still pass.

## Test plan

None — documentation change. The grep in Step 2 is the machine check.

## Done criteria

- [ ] Stale-model grep returns no doc matches
- [ ] Docs name the actual current default and point at `OPENROUTER_MODELS` as source of truth
- [ ] Only doc files in `git status`
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- The live `OPENROUTER_MODELS` array again disagrees with
  `packages/generation/src/index.test.ts` expectations (code/test drift
  recurred) — that's a code fix, out of scope here.
- You find env files or `data/generation.json` pinning a delisted model — note
  it in the report; changing runtime data is out of scope.

## Maintenance notes

- The durable fix for this class of drift is keeping docs pointing at the code
  constant instead of listing models. If a reviewer sees a future PR add model
  ids to CLAUDE.md, push back.
- Free-tier model lists on OpenRouter change frequently; the
  `assertOpenRouterPricingIsFree` runtime check already guards against a listed
  model becoming paid.
