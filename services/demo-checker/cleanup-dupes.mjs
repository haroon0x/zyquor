// Delete duplicate ack replies from @willainotice (keep the oldest).
import { createRequire } from "node:module";
const require = createRequire(new URL("../../packages/browser/package.json", import.meta.url));
const { chromium } = require("playwright-core");

const PARENT = process.argv[2] ?? "https://x.com/skywalkerr0x/status/2091889998694170752";
const DUP_TEXT = "Happy to look at a specific page";

const b = await chromium.connectOverCDP(process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://172.31.96.1:9223");
const ctx = b.contexts()[0];
const xPages = ctx.pages().filter(p => p.url().includes("x.com"));
for (let i = 1; i < xPages.length; i++) await xPages[i].close().catch(() => {});
const page = xPages[0] ?? await ctx.newPage();

// collect duplicate reply status URLs from the thread
await page.goto(PARENT, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(5000);
// scroll a bit to load replies
for (let i = 0; i < 3; i++) {
  await page.keyboard.press("PageDown");
  await page.waitForTimeout(1200);
}
const dupUrls = await page.evaluate((needle) => {
  const out = [];
  for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
    const txt = a.textContent ?? "";
    if (!txt.includes(needle)) continue;
    // only our account's replies
    const handleLink = [...a.querySelectorAll("a[href='/willainotice']")].length > 0
      || !!a.querySelector('a[href="/willainotice/status"]');
    if (!handleLink) continue;
    const time = a.querySelector("time");
    const href = time?.parentElement?.getAttribute("href")
      ?? a.querySelector("a[href*='/willainotice/status']")?.getAttribute("href");
    if (href) out.push(href.startsWith("http") ? href : `https://x.com${href}`);
  }
  return [...new Set(out)];
}, DUP_TEXT);
console.log(`duplicate replies found: ${dupUrls.length}`);
dupUrls.forEach(u => console.log("  ", u));

// keep the first, delete the rest
for (const url of dupUrls.slice(1)) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector('[data-testid="caret"]', { timeout: 20000 });
    await page.locator('[data-testid="caret"]').first().click({ force: true });
    await page.waitForTimeout(1000);
    // click "Delete" in the dropdown menu
    await page.evaluate(() => {
      const item = [...document.querySelectorAll('[role="menuitem"]')]
        .find(m => /^delete$/i.test(m.textContent.trim()));
      if (item) { item.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); item.click(); }
    });
    await page.waitForTimeout(1000);
    // confirm deletion sheet
    await page.evaluate(() => {
      const c = document.querySelector('[data-testid="confirmationSheetConfirm"]');
      if (c) { c.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); c.click(); }
    });
    await page.waitForTimeout(2500);
    console.log("deleted:", url);
  } catch (error) {
    console.log(`delete FAILED ${url}: ${error.message.slice(0, 100)}`);
  }
}
console.log("cleanup done");
await b.close();
