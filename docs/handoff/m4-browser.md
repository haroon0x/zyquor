# M4 task brief: `zyquor-browser` (CDP)

This is the highest-risk milestone. Read all of it before writing code.

## What exists today

`packages/browser/src` (~2,248 lines, Playwright via `playwright-core`)
implements compose-open, text insertion, prepare, the explicit post click, and
verification. It talks to a dedicated Chrome profile over CDP, one profile per
X account, each on its own remote-debugging port (see
`zyquor_core::paths::per_profile_cdp_url`).

## Target

A `crates/zyquor-browser` crate using `chromiumoxide` (CDP directly).

## Non-negotiable requirements

These came from `CLAUDE.md` and must survive the port unchanged:

- Dedicated profiles only, under `profiles/`. Never the everyday Chrome profile.
  Reuse `zyquor_accounts::assert_dedicated_profile_dir`.
- No stealth, anti-detection, proxy rotation, or CAPTCHA bypass.
- No automated follows, likes, reposts, DMs, or engagement loops.
- The final post action stays explicit, gated by `ZYQUOR_ENABLE_BROWSER_POST`,
  and logged.
- Failed external post jobs are **never** auto-retried: a failed click may have
  reached X. Keep the verify-then-retry path that proves the reply never
  landed before re-arming a job.

## The actual risk

Playwright gives you three things for free that raw CDP does not:

1. **Selector resolution across frames and shadow DOM.**
2. **Actionability checks** — element visible, stable, receives pointer events,
   enabled — plus automatic waiting with timeout.
3. **Retries on transient detachment** when React re-renders the composer
   between locate and click.

chromiumoxide gives you `Runtime.evaluate` and `Input.*`. You must reimplement
(1)–(3) explicitly, or the port will produce flaky posts and duplicate clicks.
Budget most of the milestone here.

Recommendation: port the *state machine* first (which steps ran, what was
persisted, what counts as verified), test it exhaustively against recorded
fixtures, and only then wire the DOM layer.

## Suggested sequence

1. Port `PostAttempt` state transitions and the attempt/artifact persistence
   (already available in `zyquor-storage`).
2. Build a thin `CdpPage` adapter with: `wait_for(selector, timeout)`,
   `is_actionable(selector)`, `type_text`, `click`, `read_text`, and a
   screenshot/trace capture hook.
3. Port the compose → insert → verify flow against the adapter.
4. Test against a real logged-in dedicated profile (headless on CI is not
   enough; X's composer is the acceptance test).
5. Keep `ZYQUOR_BROWSER_CHANNEL=chrome` behaviour: system Chrome is the
   supported channel on Ubuntu 26.04+.

## Exit criteria

- Prepare succeeds on a real profile for two different accounts concurrently
  (each on its own port — this is a product guarantee, not an optimisation).
- With `ZYQUOR_ENABLE_BROWSER_POST=0`, no click is ever issued.
- A simulated mid-compose DOM swap does not produce a double post.
- Failure artifacts (screenshot, trace, attempt rows) are persisted, not logged.
