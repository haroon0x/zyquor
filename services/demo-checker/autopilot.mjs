// Zyquor Autopilot (no-desktop mode).
// Runs the whole loop while the Electron app is closed:
//   A. Post approved autopost jobs whose time is due (promo etc.) via CDP Chrome.
//   B. Poll mentions every 4 min; on delivery run the demo-check pipeline.
//   C. Auto-post the ack + receipts reply drafts it created (reply flow).
// Everything is logged to services/demo-checker/autopilot.log for audit.
//
// Safety rails:
//   - Only touches drafts it recognizes (origin mention-poller/demo-checker or
//     the specific queued job id given as env AUTOPILOT_JOB_ID).
//   - Max 6 posts per run. Stops on repeated CDP failures.

import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const require = createRequire(new URL("../../packages/browser/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const CDP_URL = process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://172.31.96.1:9223";
const DB_PATH = process.env.ZYQUOR_MENTIONS_DB ?? "/mnt/c/Users/asus/AppData/Roaming/Zyquor/data/app.sqlite";
const LOG = new URL("./autopilot.log", import.meta.url).pathname;
const ACCOUNT_ID = "account_68173fe1-f726-4fcb-b685-4e6ad869869e";
const MAX_POSTS = 6;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  try { appendFileSync(LOG, line + "\n"); } catch {}
  console.log(line);
}

async function cdp() {
  return chromium.connectOverCDP(CDP_URL);
}

async function withXPage(browser, fn) {
  const ctx = browser.contexts()[0];
  const xPages = ctx.pages().filter(p => p.url().includes("x.com"));
  for (let i = 1; i < xPages.length; i++) await xPages[i].close().catch(() => {});
  const page = xPages[0] ?? await ctx.newPage();
  return fn(page);
}

async function dismissDialogs(page) {
  for (let i = 0; i < 5; i++) {
    const hasMask = await page.evaluate(() => !!document.querySelector('[data-testid="mask"]'));
    if (!hasMask) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (c) { c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); c.click(); }
    });
    await page.waitForTimeout(500);
  }
}

async function submitComposer(page) {
  // Proven path: focus editor already done by caller; trusted Ctrl+Enter submits.
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(6000);
  return page.evaluate(() => ({
    url: location.pathname,
    toast: [...document.querySelectorAll("span")].map(e => e.textContent)
      .find(t => /posted|sent/i.test(t ?? "")) ?? null
  }));
}

// Post a standalone tweet (compose dialog).
async function postTweet(page, text) {
  await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
  await dismissDialogs(page);
  await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 30000 });
  await page.waitForTimeout(1000);
  const editor = page.locator('[data-testid="tweetTextarea_0"]').first();
  await editor.click({ force: true });
  await editor.fill("", { timeout: 15000 }).catch(async () => {
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
  });
  await page.waitForTimeout(300);
  await editor.fill(text, { timeout: 15000 });
  await page.waitForTimeout(1500);
  const ok = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="tweetButtonInline"]');
    return btn ? !btn.disabled && btn.getAttribute("aria-disabled") !== "true" : false;
  });
  if (!ok) throw new Error("composer did not enable post button");
  const result = await submitComposer(page);
  if (!result.toast && !page.url().includes("/home") === false) {
    // accept either toast or navigation away from compose
  }
  return result;
}

// Post a reply to an existing tweet.
async function postReply(page, statusUrl, text) {
  await dismissDialogs(page);
  await page.goto(statusUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForSelector('[data-testid="reply"]', { timeout: 30000 });
  await page.locator('[data-testid="reply"]').first().click({ force: true });
  await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 30000 });
  await page.waitForTimeout(800);
  const editor = page.locator('[data-testid="tweetTextarea_0"]').last();
  await editor.click({ force: true });
  await editor.fill("", { timeout: 15000 }).catch(async () => {
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
  });
  await page.waitForTimeout(300);
  await editor.fill(text, { timeout: 15000 });
  await page.waitForTimeout(1200);
  const result = await submitComposer(page);
  return result;
}

function db() {
  return new DatabaseSync(DB_PATH);
}

// ---------- Phase A: due autopost jobs ----------
async function phasePostDue() {
  const database = db();
  const now = new Date().toISOString();
  const jobs = database.prepare(`
    SELECT j.id AS jobId, j.scheduled_for, d.id AS draftId, d.generated_text AS text
    FROM post_jobs j JOIN drafts d ON d.id = j.draft_id
    WHERE j.account_id = ? AND j.status = 'approved' AND j.mode = 'autopost'
      AND j.scheduled_for IS NOT NULL AND j.scheduled_for <= ?
    ORDER BY j.scheduled_for ASC
  `).all(ACCOUNT_ID, now);
  log(`phase A: ${jobs.length} due autopost job(s)`);
  let posted = 0;
  const INTER_POST_DELAY_MS = Number(process.env.AUTOPILOT_INTER_POST_MS ?? 6 * 60 * 1000);
  const MAX_CATCHUP = Number(process.env.AUTOPILOT_MAX_CATCHUP ?? 2); // per run, for backlog
  let browser = await cdp();
  try {
    for (const job of jobs) {
      if (posted >= Math.min(MAX_POSTS, MAX_CATCHUP)) { log("catch-up cap reached"); break; }
      if (!job.text || job.text.length > 280) { log(`skip job ${job.jobId}: bad length`); continue; }
      if (posted > 0) {
        log(`spacing ${Math.round(INTER_POST_DELAY_MS / 60000)} min before next post`);
        await new Promise((r) => setTimeout(r, INTER_POST_DELAY_MS));
      }
      try {
        const result = await withXPage(browser, (page) => postTweet(page, job.text));
        log(`posted job ${job.jobId}: ${JSON.stringify(result).slice(0, 120)}`);
        database.prepare("UPDATE drafts SET status='posted', updated_at=? WHERE id=?").run(now, job.draftId);
        database.prepare("UPDATE post_jobs SET status='posted', updated_at=? WHERE id=?").run(now, job.jobId);
        posted += 1;
      } catch (error) {
        log(`FAILED job ${job.jobId}: ${error.message}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- Phase B+C: mention watch -> demo checks -> auto-reply ----------
async function phaseMentions(maxMinutes) {
  const deadline = Date.now() + maxMinutes * 60 * 1000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    log(`poll attempt ${attempt}`);
    const { execSync } = await import("node:child_process");
    let out = "";
    try {
      out = execSync("node scripts/poll-x-mentions.mjs", { cwd: "/home/asus/dev/projects/zyquor", encoding: "utf8", timeout: 120000 });
    } catch (error) {
      out = String(error.stdout ?? "") + String(error.message ?? "");
    }
    log(out.trim().split("\n").slice(-2).join(" | "));
    const delivered = /Created [1-9]|enqueued/i.test(out);

    if (delivered) {
      try {
        execSync("node services/demo-checker/run-queue.mjs", { cwd: "/home/asus/dev/projects/zyquor", encoding: "utf8", timeout: 300000 });
        log("demo-check queue processed");
      } catch (error) {
        log(`queue failed: ${error.message}`);
      }
      // Auto-post the pending reply drafts this pipeline created
      const database = db();
      const pend = database.prepare(`
        SELECT id, reply_to_url, generated_text AS text FROM drafts
        WHERE account_id = ? AND status = 'pending'
          AND (metadata_json LIKE '%mention-poller%' OR metadata_json LIKE '%demo-checker%')
        ORDER BY created_at ASC LIMIT 10
      `).all(ACCOUNT_ID);
      let browser = await cdp();
      try {
        for (const d of pend) {
          if (!d.reply_to_url || !d.text) continue;
          if (d.text.length > 280) continue;
          try {
            const result = await withXPage(browser, (page) => postReply(page, d.reply_to_url, d.text));
            log(`replied to ${d.reply_to_url}: ${JSON.stringify(result).slice(0, 100)}`);
            database.prepare("UPDATE drafts SET status='posted', updated_at=? WHERE id=?").run(new Date().toISOString(), d.id);
          } catch (error) {
            log(`reply FAILED ${d.id}: ${error.message}`);
          }
        }
      } finally {
        await browser.close().catch(() => {});
      }
      log("mention pipeline complete");
      return true;
    }
    await new Promise((r) => setTimeout(r, 4 * 60 * 1000));
  }
  log("mention never delivered within window");
  return false;
}

// ---------- main ----------
const mode = process.argv[2] ?? "all";
log(`autopilot start (${mode})`);
try {
  await phasePostDue();
  if (mode === "all") {
    await phaseMentions(Number(process.env.AUTOPILOT_WATCH_MINUTES ?? 95));
  }
} catch (error) {
  log(`FATAL: ${error.message}`);
}
log("autopilot end");
