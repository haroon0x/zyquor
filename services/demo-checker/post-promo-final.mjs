// Definitive promo poster — clears duplicated draft text, inserts once, submits.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(new URL("../../packages/browser/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const JOB_ID = process.argv[2] ?? "job_f9782505-1340-4386-982a-012927748586";
const db = new DatabaseSync("/mnt/c/Users/asus/AppData/Roaming/Zyquor/data/app.sqlite");
const job = db.prepare("SELECT j.id, d.id AS draftId, d.generated_text AS text FROM post_jobs j JOIN drafts d ON d.id=j.draft_id WHERE j.id=?").get(JOB_ID);
if (!job || job.text.length > 280) { console.log("bad job"); process.exit(1); }
const TEXT = job.text;

const b = await chromium.connectOverCDP(process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://172.31.96.1:9223");
const ctx = b.contexts()[0];
const page = ctx.pages().find(p => p.url().includes("x.com"));

// 1. focus the non-empty editor
await page.evaluate(() => {
  const boxes = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')];
  const el = boxes.find(b2 => b2.textContent?.length) ?? boxes[0];
  el.focus();
});
await page.waitForTimeout(300);

// 2. clear via execCommand (works on focused contenteditable)
await page.evaluate(() => {
  document.execCommand("selectAll", false, null);
  document.execCommand("delete", false, null);
});
await page.waitForTimeout(600);
let len = await page.evaluate(() =>
  [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].reduce((a, b2) => Math.max(a, b2.textContent.length), 0));
console.log("after clear len:", len);

// 3. insert exactly once
await page.evaluate((t) => {
  const el = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')][0];
  el.focus();
  document.execCommand("insertText", false, t);
}, TEXT);
await page.waitForTimeout(1800);

// 4. verify
let st = await page.evaluate((t) => {
  const btn = document.querySelector('[data-testid="tweetButtonInline"]');
  const box = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].find(b2 => b2.textContent?.length);
  return {
    enabled: btn ? !btn.disabled && btn.getAttribute("aria-disabled") !== "true" : false,
    len: box?.textContent.length ?? 0,
    exact: box?.textContent === t
  };
}, TEXT);
console.log("state:", JSON.stringify(st));

// 5. nudge if needed
if (!st.enabled && st.exact) {
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(1500);
  st = await page.evaluate((t) => {
    const btn = document.querySelector('[data-testid="tweetButtonInline"]');
    const box = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].find(b2 => b2.textContent?.length);
    return {
      enabled: btn ? !btn.disabled && btn.getAttribute("aria-disabled") !== "true" : false,
      exact: box?.textContent === t
    };
  }, TEXT);
  console.log("nudged:", JSON.stringify(st));
}

if (!st.enabled || !st.exact) {
  console.log("ABORT: compose state invalid");
  await b.close();
  process.exit(1);
}

// 6. submit
await page.keyboard.press("Control+Enter");
await page.waitForTimeout(7000);
const done = await page.evaluate(() => ({
  url: location.pathname,
  toast: [...document.querySelectorAll("span")].map(e => e.textContent).find(t => /posted|sent/i.test(t ?? "")) ?? null
}));
console.log("RESULT:", JSON.stringify(done));
if (done.toast || done.url === "/home") {
  const now = new Date().toISOString();
  db.prepare("UPDATE drafts SET status='posted', updated_at=? WHERE id=?").run(now, job.draftId);
  db.prepare("UPDATE post_jobs SET status='posted', updated_at=? WHERE id=?").run(now, job.id);
  console.log("marked posted ✓");
}
await b.close();
