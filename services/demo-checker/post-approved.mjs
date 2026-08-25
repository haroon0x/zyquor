// Auto-post approved pending mention/receipts drafts as replies.
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
const require = createRequire(new URL("../../packages/browser/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const ACCOUNT_ID = "account_68173fe1-f726-4fcb-b685-4e6ad869869e";
const db = new DatabaseSync("/mnt/c/Users/asus/AppData/Roaming/Zyquor/data/app.sqlite");
const drafts = db.prepare(`
  SELECT id, reply_to_url, generated_text AS text FROM drafts
  WHERE account_id = ? AND status = 'pending'
    AND (metadata_json LIKE '%mention-poller%' OR metadata_json LIKE '%demo-checker%')
    AND reply_to_url IS NOT NULL
  ORDER BY created_at ASC
`).all(ACCOUNT_ID);
console.log(`pending drafts to post: ${drafts.length}`);

const b = await chromium.connectOverCDP(process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://172.31.96.1:9223");
const ctx = b.contexts()[0];
const xPages = ctx.pages().filter(p => p.url().includes("x.com"));
for (let i = 1; i < xPages.length; i++) await xPages[i].close().catch(() => {});
const page = xPages[0] ?? await ctx.newPage();

let postedCount = 0;
for (const d of drafts) {
  try {
    await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
    for (let i = 0; i < 5; i++) {
      const hasMask = await page.evaluate(() => !!document.querySelector('[data-testid="mask"]'));
      if (!hasMask) break;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      await page.evaluate(() => document.querySelector('[data-testid="confirmationSheetConfirm"]')?.click());
      await page.waitForTimeout(500);
    }

    await page.goto(d.reply_to_url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector('[data-testid="reply"]', { timeout: 30000 });
    await page.waitForTimeout(800);
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
    await editor.fill(d.text, { timeout: 15000 });
    await page.waitForTimeout(1500);

    const ok = await page.evaluate((t) => {
      const boxes = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')];
      const box = boxes.find(b2 => b2.textContent?.length);
      return box?.textContent.replace(/\s+/g, " ").trim().startsWith(t.slice(0, 40)) ?? false;
    }, d.text);
    console.log(`reply draft ok: ${ok}`);
    if (!ok) { console.log("SKIP — compose invalid"); continue; }

    await page.keyboard.press("Control+Enter");
    await page.waitForTimeout(6000);
    const done = await page.evaluate(() => ({
      url: location.pathname,
      toast: [...document.querySelectorAll("span")].map(e => e.textContent).find(t => /posted|sent/i.test(t ?? "")) ?? null
    }));
    console.log(`posted: ${JSON.stringify(done)}`);
    if (done.toast || done.url === "/home" || done.url.includes("/status/")) {
      const now = new Date().toISOString();
      db.prepare("UPDATE drafts SET status='posted', updated_at=? WHERE id=?").run(now, d.id);
      postedCount += 1;
    }
  } catch (error) {
    console.log(`FAILED ${d.id}: ${error.message.slice(0, 120)}`);
  }
}
console.log(`done — posted ${postedCount}/${drafts.length}`);
await b.close();
