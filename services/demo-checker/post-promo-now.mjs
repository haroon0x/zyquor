// One-shot: immediately post the free-credits promo draft via willainotice Chrome.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(new URL("../../packages/browser/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const JOB = "job_f9782505-1340-4386-982a-012927748586";
const db = new DatabaseSync("/mnt/c/Users/asus/AppData/Roaming/Zyquor/data/app.sqlite");
const job = db.prepare("SELECT j.id, d.id AS draftId, d.generated_text AS text FROM post_jobs j JOIN drafts d ON d.id=j.draft_id WHERE j.id=?").get(JOB);
if (!job) { console.log("job not found"); process.exit(1); }
if (job.text.length > 280) { console.log("bad length"); process.exit(1); }

const b = await chromium.connectOverCDP(process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://172.31.96.1:9223");
const ctx = b.contexts()[0];
const xPages = ctx.pages().filter(p => p.url().includes("x.com"));
for (let i = 1; i < xPages.length; i++) await xPages[i].close().catch(() => {});
const page = xPages[0] ?? await ctx.newPage();

for (let i = 0; i < 5; i++) {
  const hasMask = await page.evaluate(() => !!document.querySelector('[data-testid="mask"]'));
  if (!hasMask) break;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('[data-testid="confirmationSheetConfirm"]')?.click());
  await page.waitForTimeout(500);
}

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
await editor.fill(job.text, { timeout: 15000 });
// nudge DraftJS state until the button enables (up to 4 tries)
let ok = { enabled: false, match: false };
for (let i = 0; i < 4; i++) {
  await page.waitForTimeout(1200);
  await page.keyboard.press("Space");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(1000);
  ok = await page.evaluate((t) => {
    const btn = document.querySelector('[data-testid="tweetButtonInline"]');
    const box = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')].find(b2 => b2.textContent?.length);
    return {
      enabled: btn ? !btn.disabled && btn.getAttribute("aria-disabled") !== "true" : false,
      match: box?.textContent.replace(/\s+/g, " ").trim() === t
    };
  }, job.text);
  console.log(`try ${i + 1}:`, JSON.stringify(ok));
  if (ok.enabled && ok.match) break;
}
console.log("compose ok:", JSON.stringify(ok));
if (!ok.enabled || !ok.match) { console.log("NOT posting"); await b.close(); process.exit(1); }

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
  console.log("marked posted in DB");
}
await b.close();
