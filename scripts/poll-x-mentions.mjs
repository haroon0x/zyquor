#!/usr/bin/env node
// Thin cron shim for the mention flow. All scraping, dedupe, drafting, and
// memory grounding happen inside the Zyquor API (POST /replies/mentions/
// scan-and-draft); this script only calls the local API. It never writes to
// the database itself, and nothing it does auto-posts: drafts land in the
// review queue.
//
// Requirements:
//   - The Zyquor API running locally (default 127.0.0.1:3000, then 3001).
//     Set ZYQUOR_API_URL to override.
//
// Usage:
//   node scripts/poll-x-mentions.mjs            # real run (scan + draft)
//   DRY_RUN=1 node scripts/poll-x-mentions.mjs  # read-only scan summary
//
// Optional env:
//   ZYQUOR_MENTIONS_ACCOUNT_ID   account id to draft for (default: first
//                                enabled account returned by /accounts)
//   ZYQUOR_DEMO_QUEUE            path for the demo-check queue file
//                                (default data/demo-checks.jsonl)

import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

const dryRun = process.env.DRY_RUN === "1";
const explicitApiUrl = process.env.ZYQUOR_API_URL;
const demoQueuePath = process.env.ZYQUOR_DEMO_QUEUE
  ?? new URL("../data/demo-checks.jsonl", import.meta.url).pathname;

const DEFAULT_PORTS = ["3000", "3001"];

function log(message) {
  console.log(message);
}

function logError(message) {
  console.error(message);
}

async function fetchJson(url, init, timeoutMs = 120_000) {
  const response = await fetch(url, {
    ...init,
    ...(init?.body ? { headers: { "content-type": "application/json", ...init.headers } } : {}),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body?.error ?? `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body;
}

async function resolveApiUrl() {
  if (explicitApiUrl) return explicitApiUrl.replace(/\/$/, "");
  for (const port of DEFAULT_PORTS) {
    const candidate = `http://127.0.0.1:${port}`;
    try {
      const health = await fetchJson(`${candidate}/health`, undefined, 3_000);
      if (health?.ok) {
        return candidate;
      }
    } catch {
      // Try the next port.
    }
  }
  throw new Error("Zyquor API not reachable on 127.0.0.1:3000 or 3001. Set ZYQUOR_API_URL.");
}

async function resolveAccountId(apiUrl) {
  if (process.env.ZYQUOR_MENTIONS_ACCOUNT_ID) {
    return process.env.ZYQUOR_MENTIONS_ACCOUNT_ID;
  }
  const { accounts } = await fetchJson(`${apiUrl}/accounts`, undefined, 10_000);
  const enabled = (accounts ?? []).filter((account) => account.enabled);
  const account = enabled[0] ?? (accounts ?? [])[0];
  if (!account) {
    throw new Error("No Zyquor account exists. Set ZYQUOR_MENTIONS_ACCOUNT_ID or create an account.");
  }
  log(`Drafting for account ${account.id} (@${account.handle}); set ZYQUOR_MENTIONS_ACCOUNT_ID to override.`);
  return account.id;
}

// External page URLs (and only those, never x.com status links) found inside a
// mention go to the demo-check queue, mirroring the behavior of the old direct
// database poller. Scheme-less t.co/www links are treated as https links.
function externalUrlFromText(text) {
  const normalized = text.replace(/https?:\/\/(x|twitter)\.com\/[^\s)]+/gi, "");
  const withScheme = normalized.match(/https?:\/\/[^\s)]+/i);
  if (withScheme) {
    return withScheme[0].replace(/[.,;:!?]$/, "");
  }
  const shortLink = normalized.match(/\bt\.co\/[A-Za-z0-9]+\b/i) ?? normalized.match(/\bwww\.[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[^\s)"]*)?\b/i);
  return shortLink ? `https://${shortLink[0]}` : null;
}

function enqueueDemoCheck(url, replyToUrl, handle, accountId) {
  mkdirSync(dirname(demoQueuePath), { recursive: true });
  appendFileSync(demoQueuePath, JSON.stringify({ url, replyToUrl, handle, accountId }) + "\n");
}

async function main() {
  if (!existsSync(new URL("../package.json", import.meta.url).pathname)) {
    logError("Run this script from within the zyquor repo.");
    process.exit(1);
  }
  const apiUrl = await resolveApiUrl();
  const accountId = await resolveAccountId(apiUrl);
  log(`${apiUrl}  account=${accountId}${dryRun ? "  [DRY RUN]" : ""}`);

  if (dryRun) {
    const { mentions, scanned, adsSkipped } = await fetchJson(
      `${apiUrl}/replies/mentions?accountId=${encodeURIComponent(accountId)}`,
      undefined,
      90_000
    );
    log(`Scanned ${scanned} mention article(s) (${adsSkipped} promoted skipped). ${mentions.length} fresh within 48h.`);
    for (const mention of mentions) {
      const flags = [mention.drafted ? "drafted" : null, mention.posted ? "posted" : null].filter(Boolean).join(", ");
      log(`  @${mention.authorHandle}: ${mention.url}${flags ? `  [${flags}]` : ""}`);
      log(`    ${mention.text.slice(0, 140)}`);
    }
    log("DRY_RUN only lists what would be drafted. Run without DRY_RUN to create drafts.");
    return;
  }

  const result = await fetchJson(`${apiUrl}/replies/mentions/scan-and-draft`, {
    method: "POST",
    body: JSON.stringify({ accountId })
  });

  log(`Scanned ${result.scanned} mention article(s) (${result.adsSkipped ?? 0} promoted skipped).`);
  const created = result.created ?? [];
  const skipped = result.skipped ?? [];
  let demoChecks = 0;
  for (const entry of created) {
    const replyTo = entry.draft?.replyTo ?? null;
    const text = replyTo?.text ?? entry.draft?.sourceInput ?? "";
    const external = externalUrlFromText(text);
    if (external) {
      enqueueDemoCheck(external, replyTo?.url ?? "", replyTo?.authorHandle ?? "", accountId);
      demoChecks += 1;
    }
    log(`  drafted @${replyTo?.authorHandle ?? "?"}: ${replyTo?.url ?? "?"}`);
  }
  for (const item of skipped) {
    log(`  skipped ${item.url}: ${item.reason}`);
  }
  if (demoChecks > 0) {
    log(`Enqueued ${demoChecks} external page URL(s) for demo-check.`);
  }
  log(`Created ${created.length} reply draft(s). Review them in the app before approving; nothing auto-posts.`);
}

main().catch((error) => {
  logError(error?.message ?? String(error));
  process.exit(1);
});
