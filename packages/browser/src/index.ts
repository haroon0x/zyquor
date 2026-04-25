import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";

export interface PreparePostInput {
  profileDir: string;
  text: string;
  actionDelayMs?: number;
  artifactsDir?: string;
  browserChannel?: string | null;
  cdpUrl?: string;
  closeAfterPrepare?: boolean;
  headless?: boolean;
  submit?: boolean;
  typingDelayMs?: number;
  xUrl?: string;
}

export interface PreparePostResult {
  status: "prepared" | "posted";
  insertedText: string;
  postUrl: string | null;
}

export class BrowserPrepareError extends Error {
  constructor(
    message: string,
    readonly screenshotPath: string | null = null,
    readonly tracePath: string | null = null
  ) {
    super(message);
    this.name = "BrowserPrepareError";
  }
}

async function firstVisibleEditor(page: Page) {
  const selectors = [
    page.locator('[data-testid="tweetTextarea_0"]').first(),
    page.locator('[aria-label*="Post text"]').first(),
    page.locator('[aria-label*="Tweet text"]').first(),
    page.getByRole("textbox", { name: /post|tweet|what/i }).first(),
    page.getByRole("textbox").first()
  ];

  for (const selector of selectors) {
    if (await selector.isVisible({ timeout: 2_000 }).catch(() => false)) {
      return selector;
    }
  }

  return page.getByRole("textbox").first();
}

async function assertNotLoginPage(page: Page) {
  const url = page.url();
  const loginVisible = await page
    .locator('input[name="text"], input[name="password"], [data-testid="loginButton"], a[href="/login"]')
    .first()
    .isVisible({ timeout: 1_000 })
    .catch(() => false);

  if (url.includes("/login") || url.includes("/i/flow/login") || loginVisible) {
    throw new Error("X profile is not logged in. Run `pnpm profile:x:manual`, log into X, close that browser, then retry.");
  }
}

export async function preparePost(input: PreparePostInput): Promise<PreparePostResult> {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Post text is empty");
  }

  const artifactsDir = input.artifactsDir ?? "data/artifacts";
  const actionDelayMs = input.actionDelayMs ?? 2_500;
  const typingDelayMs = input.typingDelayMs ?? 45;
  mkdirSync(artifactsDir, { recursive: true });
  const artifactId = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = join(artifactsDir, `prepare-${artifactId}.png`);
  const tracePath = join(artifactsDir, `prepare-${artifactId}.zip`);

  const browser = input.cdpUrl ? await chromium.connectOverCDP(input.cdpUrl) : null;
  const browserChannel = input.browserChannel === "chromium" ? null : input.browserChannel;
  const context =
    browser?.contexts()[0] ??
    (await chromium.launchPersistentContext(input.profileDir, {
      ...(browserChannel ? { channel: browserChannel } : {}),
      headless: input.headless ?? false,
      viewport: { width: 1280, height: 900 }
    }));
  const ownsContext = !browser;

  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(input.xUrl ?? "https://x.com/compose/post", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(actionDelayMs);
    await assertNotLoginPage(page);

    const editor = await firstVisibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(actionDelayMs);
    await editor.click();
    await page.waitForTimeout(actionDelayMs);
    await editor.fill("");
    await page.waitForTimeout(actionDelayMs);
    await editor.pressSequentially(text, { delay: typingDelayMs });
    await page.waitForTimeout(actionDelayMs);

    const textContent = ((await editor.textContent().catch(() => null)) ?? "").trim();
    const inputValue = ((await editor.inputValue().catch(() => null)) ?? "").trim();
    const insertedText = textContent || inputValue;
    if (!insertedText.includes(text)) {
      throw new Error("Inserted text could not be verified");
    }

    if (input.submit) {
      const postButton = page.getByRole("button", { name: /^post$/i }).last();
      await postButton.waitFor({ state: "visible", timeout: 15_000 });
      await page.waitForTimeout(actionDelayMs);
      await postButton.click();
      await page.waitForTimeout(actionDelayMs);
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      await page.waitForTimeout(1500);
      const postUrl = page.url();
      await context.tracing.stop().catch(() => undefined);
      if (ownsContext) {
        await context.close();
      }
      return { status: "posted", insertedText, postUrl };
    }

    await context.tracing.stop().catch(() => undefined);
    if (ownsContext && (input.closeAfterPrepare ?? true)) {
      await context.close();
    }
    return { status: "prepared", insertedText, postUrl: null };
  } catch (error) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    }
    await context.tracing.stop({ path: tracePath }).catch(() => undefined);

    const message = error instanceof Error ? error.message : "Unknown browser prepare error";
    if (ownsContext) {
      await context.close();
    }
    throw new BrowserPrepareError(message, screenshotPath, tracePath);
  }
}
