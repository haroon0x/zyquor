// Clean-reset promo poster: fully clears dialog state, then one fresh compose.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(new URL("../../packages/browser/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const JOB = process.argv[2] ?? "job_f9782505-1340-4386-982a-012927748586";
const db = new DatabaseSync("/mnt/c/Users/asus/AppData/Roaming/Zyquor/data/app.sqlite");
const job = db.prepare("SELECT j.id, d.id AS draftId, d.generated_text AS text FROM post_jobs j JOIN drafts d ON d.id=j.draft_id WHERE j.id=?").get(JOB);
if (!job || job.text.length > 280) { console.log("bad job"); process.exit(1); }

const b = await chromium.connectOverCDP(process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://172.31.96.1:9223");
const ctx = b.contexts()[0];
const xPages = ctx.pages().filter(p => p.url().includes("x.com"));
for (let i = 1; i < xPages.length; i++) await xPages[i].close().catch(() => {});
const page = xPages[0] ?? await ctx.newPage();

// hard reset: back to home, discard everything
await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
for (let i = 0; i < 8; i++) {
  const s = await page.evaluate(() => ({
    masks: document.querySelectorAll('[data-testid="mask"]').length,
    boxes: document.querySelectorAll('[data-testid="tweetTextarea_0"]').length
  }));
  if (s.masks === 0 && s.boxes === 0) break;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const c = document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (c) { c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); c.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); c.click(); }
  });
  await page.waitForTimeout(600);
}
console.log("reset done:", JSON.stringify(await page.evaluate(() => ({
  masks: document.querySelectorAll('[data-testid="mask"]').length,
  boxes: document.querySelectorAll('[data-testid="tweetTextarea_0"]').length
}))));

// fresh compose
await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 30000 });
await page.waitForTimeout(1200);
const editor = page.locator('[data-testid="tweetTextarea_0"]').first();
await editor.click({ force: true });
await editor.fill(job.text, { timeout: 15000 }).catch(async () => {
  await page.keyboard.insertText(job.text);
});
await page.waitForTimeout(1500);
await page.keyboard.press("Space");
await page.keyboard.press("Backspace");
await page.waitForTimeout(1500);

let st = await page.evaluate(() => {
  const btn = document.querySelector('[data-testid="tweetButtonInline"]');
  const box = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].find(b2 => b2.textContent?.length);
  return {
    enabled: btn ? !btn.disabled && btn.getAttribute("aria-disabled") !== "true" : false,
    len: box?.textContent.length ?? 0,
    masks: document.querySelectorAll('[data-testid="mask"]').length
  };
});
console.log("state:", JSON.stringify(st));
if (!st.enabled && st.masks > 0) {
  // dismiss overlay but keep dialog: press Escape once (closes dropdown-layer)
  await page.keyboard.press("Escape");
  await page.waitForTimeout(800);
  st = await page.evaluate(() => {
    const btn = document.querySelector('[data-testid="tweetButtonInline"]');
    return { enabled: btn ? !btn.disabled && btn.getAttribute("aria-disabled") !== "true" : false };
  });
  console.log("after escape:", JSON.stringify(st));
}
if (!st.enabled) { console.log("NOT posting"); await b.close(); process.exit(1); }

await page.keyboard.press("Control+Enter");
await page.waitForTimeout(6000);
const done = await page.evaluate(() => ({
  url: location.pathname,
  toast: [...document.querySelectorAll("span")].map(e => e.textContent).find(t => /posted|sent/i.test(t ?? "")) ?? null
}));
console.log("result:", JSON.stringify(done));
if (done.toast || done.url === "/home") {
  const now = new Date().toISOString();
  db.prepare("UPDATE drafts SET status='posted', updated_at=? WHERE id=?").run(now, job.draftId);
  db.prepare("UPDATE post_jobs SET status='posted', updated_at=? WHERE id=?").run(now, job.id);
  console.log("marked posted ✓");
}
await b.close();
