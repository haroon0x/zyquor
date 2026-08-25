// Poll X mentions for the product account via CDP and create pending reply
// drafts. Semi-automatic: drafts land as status='pending' for human approval;
// nothing is auto-posted.
//
// Requirements:
//   - The posting Chrome serving the PRODUCT profile (willainotice) must be
//     running with CDP (it owns the logged-in session mentions are read from).
//   - ZYQUOR_BROWSER_CDP_URL or default http://172.31.96.1:9223 (WSL -> Windows
//     portproxy) must reach it.
//
// Usage:
//   node scripts/poll-x-mentions.mjs            # real run
//   DRY_RUN=1 node scripts/poll-x-mentions.mjs  # show what would be created

import { createRequire } from "node:module";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const require = createRequire(new URL("../packages/browser/package.json", import.meta.url));
const { chromium } = require("playwright-core");
const { DatabaseSync } = await import("node:sqlite");
const crypto = await import("node:crypto");

const cdpUrl = process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://172.31.96.1:9223";
const dryRun = process.env.DRY_RUN === "1";
const dbPath = process.env.ZYQUOR_MENTIONS_DB ?? "/mnt/c/Users/asus/AppData/Roaming/Zyquor/data/app.sqlite";
const statePath = process.env.ZYQUOR_MENTIONS_STATE ?? new URL("../data/mentions-state.json", import.meta.url).pathname;
const demoQueuePath = process.env.ZYQUOR_DEMO_QUEUE ?? new URL("../data/demo-checks.jsonl", import.meta.url).pathname;

if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

function loadState() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { processedTweetIds: [] };
  }
}

function saveState(state) {
  state.processedTweetIds = state.processedTweetIds.slice(-2000);
  mkdirSync(resolve(statePath, ".."), { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// Reply templates per mention kind. Indirect-conversion doctrine: acknowledge,
// promise one concrete measurement, never pitch.
function suggestReply(mentionText) {
  const hasUrl = /https?:\/\/|x\.com\/\S+\/status|\bwww\./i.test(mentionText);
  if (hasUrl) {
    return [
      "Got it — we'll pull that page and report what only exists after JavaScript runs.",
      "On it. We'll measure its raw-to-rendered delta and reply with the number.",
      "Adding it to the audit queue — you'll get the evidence-based reading here."
    ][Math.floor(Math.random() * 3)];
  }
  return [
    "Happy to look at a specific page if you have one in mind.",
    "If you share a public URL, we'll give you the measured answer rather than an opinion."
  ][Math.floor(Math.random() * 2)];
}

function enqueueDemoCheck(url, replyToUrl, handle, accountId) {
  mkdirSync(resolve(demoQueuePath, ".."), { recursive: true });
  appendFileSync(demoQueuePath, JSON.stringify({ url, replyToUrl, handle, accountId }) + "\n");
}

async function scrapeTab(page) {
  await page.goto("https://x.com/notifications/mentions", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(5000);
  return page.evaluate(() => {
    const out = [];
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const textEl = article.querySelector('[data-testid="tweetText"]');
      const linkEl = article.querySelector('a[href*="/status/"]');
      const timeEl = article.querySelector("time");
      if (!textEl || !linkEl) continue;
      const href = linkEl.getAttribute("href") ?? "";
      // collect external t.co links inside the tweet text (expanded later)
      const tcoLinks = [...article.querySelectorAll('a[href*="t.co"]')]
        .map(a => a.href)
        .filter(h => h.includes("t.co"));
      out.push({
        url: href.startsWith("http") ? href : `https://x.com${href}`,
        handle: (href.split("/")[1] ?? "").toLowerCase(),
        text: textEl.textContent?.slice(0, 500) ?? "",
        postedAt: timeEl?.getAttribute("datetime") ?? null,
        tcoLinks
      });
    }
    return out;
  });
}

async function main() {
  console.log(`CDP: ${cdpUrl}${dryRun ? "  [DRY RUN]" : ""}`);
  const browser = await chromium.connectOverCDP(cdpUrl);
  const ctx = browser.contexts()[0];
  if (!ctx) {
    console.error("No browser context over CDP.");
    process.exit(1);
  }

  let page = ctx.pages().find((p) => p.url().includes("x.com")) ?? (await ctx.newPage());
  // Replies also appear in the Mentions tab, so a single scrape is enough.
const mentions = await scrapeTab(page);
console.log(`Scraped ${mentions.length} mention articles.`);

  // Only act on fresh mentions (last 48h) not already processed.
  const cutoff = Date.now() - 48 * 3600 * 1000;
  const state = loadState();
  const processed = new Set(state.processedTweetIds);
  const fresh = mentions.filter((m) => {
    const t = m.postedAt ? Date.parse(m.postedAt) : Date.now();
    return Number.isFinite(t) && t >= cutoff && !processed.has(m.url);
  });

  if (fresh.length === 0) {
    console.log("Nothing new to process.");
    await browser.close();
    return;
  }

  const db = new DatabaseSync(dbPath);
  const accountId = db.prepare("SELECT id FROM accounts WHERE handle='willainotice'").get()?.id;
  if (!accountId) {
    console.error("Account 'willainotice' not found.");
    process.exit(1);
  }

  let created = 0;
  for (const m of fresh) {
    const suggested = suggestReply(m.text);
    // direct URL in text, else expand t.co links attached to the tweet
    let targetUrl = null;
    const urlMatch = m.text.match(/https?:\/\/[^\s)]+/i);
    if (urlMatch) {
      targetUrl = urlMatch[0];
    } else if ((m.tcoLinks ?? []).length > 0) {
      for (const short of m.tcoLinks.slice(0, 2)) {
        try {
          const res = await fetch(short, { redirect: "follow", signal: AbortSignal.timeout(8000) });
          if (res.url && !res.url.includes("t.co") && /^https?:\/\//.test(res.url)) {
            targetUrl = res.url;
            break;
          }
        } catch {}
      }
    }
    const hasUrl = Boolean(targetUrl);
    console.log(`\n@${m.handle}: ${m.url}\n  "${m.text.slice(0, 120)}"\n  -> draft reply: "${suggested}"`);
    if (dryRun) continue;

    if (hasUrl) {
      enqueueDemoCheck(targetUrl, m.url, m.handle, accountId);
      console.log(`   enqueued ${targetUrl} for demo-check.`);
    }

    const dup = db
      ? db.prepare("SELECT id FROM drafts WHERE account_id=? AND reply_to_url=?").get(accountId, m.url)
      : null;
    if (dup) {
      console.log(`   skip ${m.url}: draft already exists`);
      processed.add(m.url);
      continue;
    }
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO drafts (id,account_id,source_type,source_input,generated_text,edited_text,reply_to_url,metadata_json,status,created_at,updated_at,reply_to_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)"
    ).run(
      `draft_${crypto.randomUUID()}`,
      accountId,
      "mention",
      JSON.stringify({ from: m.handle, text: m.text }),
      suggested,
      null,
      m.url,
      JSON.stringify({
        yolo: false,
        autopost: false,
        count: 1,
        tweetType: "reply",
        origin: "mention-poller",
        authorHandle: m.handle
      }),
      "pending",
      now,
      now,
      null
    );
    created += 1;
    processed.add(m.url);
  }

  if (!dryRun) {
    saveState(state);
    console.log(`\nCreated ${created} pending reply draft(s). Review them in the app before approving.`);
  }
  await browser.close();
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
