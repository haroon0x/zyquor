# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

Older builds are not patched; update to the latest 0.1.x release before
reporting a problem.

## Reporting a vulnerability

Report privately through GitHub Security Advisories on this repository:
**Security** tab, then **Report a vulnerability**. If you cannot use that form,
contact the maintainer (`haroon0x`) through the GitHub profile at
https://github.com/haroon0x and ask for a private channel.

Do not open a public issue, discussion, or pull request for a suspected
vulnerability, and do not include exploit details in a public comment. The
maintainer will acknowledge the report, reproduce it, and coordinate a fix and
disclosure date with you. This is a single-maintainer project, so expect an
initial response within a few days rather than within hours.

## In scope

- The local API in `apps/api`: authentication-free local routes, request
  validation, job and draft state transitions, path handling.
- Browser automation in `packages/browser` and, once ported,
  `crates/zyquor-browser`: profile selection, CDP connection handling, composer
  filling, and the final post action.
- Generation in `packages/generation` and `crates/zyquor-generation`: provider
  invocation, prompt assembly, output parsing, and the deterministic quality
  floor.
- Storage in `packages/storage` and `crates/zyquor-storage`: the SQLite schema,
  migrations, and any place where untrusted source text becomes data or SQL.
- Credential and session handling: API keys in `.env` or the desktop
  `settings.json`, X cookies and site data in `profiles/<handle>`, and anything
  that could leak them through logs, artifacts, HTTP responses, or crash dumps.
- Prompt injection and posting-safety bypass: source content, fetched pages, or
  reply targets that cause the generator to emit text outside the intended
  brief, or that cause a draft to skip the deterministic screen, the approval
  gate, the posting flags, or the account's daily limit, quiet hours, and gap.

## Out of scope

- X platform rate limits, throttling, or API changes.
- Account bans, locks, or suspensions resulting from running automation against
  your own account, including bans caused by posting volume or content.
- Outages, quota exhaustion, or pricing changes in third-party providers
  (generator CLIs and APIs, source adapters, Ghost/Goldfish memory, Crawl4AI).
- Problems that require the attacker to already control the machine, the user
  account, or the `.env` file.
- Vulnerabilities in Chrome, Playwright, Electron, or a generator CLI that are
  not reachable through Zyquor's own code; report those upstream.

## Posting safety

Zyquor posts only to the X account you sign in with, using the dedicated Chrome
profile you point it at (`profiles/<handle>` by default). It never authenticates
on your behalf, never harvests credentials, and does not ship stealth,
anti-detection, proxy rotation, or CAPTCHA bypass. Posting is off until
`ZYQUOR_ENABLE_BROWSER_PREPARE=1` and `ZYQUOR_ENABLE_BROWSER_POST=1` are set.

Because those flags, cookies, and `.env` files are the sensitive parts of a
working install:

- Never file a public issue containing cookies, tokens, API keys, `.env`
  contents, `settings.json`, `data/app.sqlite`, `posting-chrome.json`, or
  artifacts from `data/artifacts`.
- Redact handles, profile paths, and full log lines before pasting them.
- If a credential may have leaked, rotate it first (new generator key, sign out
  the X session in that profile) and then report the bug with the redacted
  evidence.
