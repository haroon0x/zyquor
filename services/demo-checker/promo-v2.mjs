// Final promo poster v2: full dialog purge + LAST-dialog targeting.
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
const xPages = ctx.pages().filter(p => p.url().includes("x.com"));
for (let i = 1; i < xPages.length; i++) await xPages[i].close().catch(() => {});
const page = xPages[0] ?? await ctx.newPage();

await page.goto("https://x.com/home", { waitUntil: "domcontentloaded", timeout: 45000 });
for (let i = 0; i < 10; i++) {
  const s = await page.evaluate(() => ({
    masks: document.querySelectorAll('[data-testid="mask"]').length,
    boxes: document.querySelectorAll('[data-testid="tweetTextarea_0"]').length,
    dialogs: document.querySelectorAll('[role="dialog"]').length
  }));
  if (s.dialogs === 0) break;
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const discard = [...document.querySelectorAll('button, [role="button"]')]
      .find(b2 => /^(discard|discard changes)$/i.test(b2.textContent.trim()))
      ?? document.querySelector('[data-testid="confirmationSheetConfirm"]');
    if (discard) { discard.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); discard.click(); }
  });
  await page.waitForTimeout(700);
}
console.log("purge:", JSON.stringify(await page.evaluate(() => ({
  dialogs: document.querySelectorAll('[role="dialog"]').length,
  boxes: document.querySelectorAll('[data-testid="tweetTextarea_0"]').length
}))));
if ((await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length)) > 0) {
  console.log("ABORT: cannot clear dialogs");
  await b.close(); process.exit(1);
}

// single fresh compose
await page.goto("https://x.com/compose/post", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector('[data-testid="tweetTextarea_0"]', { timeout: 30000 });
await page.waitForTimeout(1200);
const editor = page.locator('[data-testid="tweetTextarea_0"]').last();
await editor.click({ force: true });
await editor.fill(TEXT, { timeout: 15000 });
await page.waitForTimeout(2000);

// read the LAST dialog's button (the live one)
let st = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('[data-testid="tweetButtonInline"]')];
  const btn = btns[btns.length - 1];
  const boxes = [...document.querySelectorAll('[data-testid="tweetTextarea_0"]')];
  const box = boxes[boxes.length - 1];
  return {
    btnCount: btns.length,
    enabled: btn ? !btn.disabled && btn.getAttribute("aria-disabled") !== "true" : false,
    len: box?.textContent.length ?? 0
  };
});
console.log("state:", JSON.stringify(st));
if (!st.enabled) {
  const box = page.locator('[data-testid="tweetTextarea_0"]').last();
  await box.click({ force: true });
  await page.keyboard.press("Space");
  await page.waitForTimeout(200);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(1500);
  st = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('[data-testid="tweetButtonInline"]')];
    const btn = btns[btns.length - 1];
    return { enabled: btn ? !btn.disabled && btn.getAttribute("aria-disabled") !== "true" : false };
  });
  console.log("nudged:", JSON.stringify(st));
}
if (!st.enabled) { console.log("ABORT: still disabled"); await b.close(); process.exit(1); }

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
