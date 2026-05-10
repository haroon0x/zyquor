import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Locator, type Page } from "playwright";

export interface PreparePostInput {
  profileDir: string;
  text: string;
  actionDelayMs?: number;
  artifactsDir?: string;
  browserChannel?: string | null;
  cdpUrl?: string;
  closeAfterPrepare?: boolean;
  headless?: boolean;
  mediaPaths?: string[];
  replyToUrl?: string | null;
  submit?: boolean;
  typingDelayMs?: number;
  xUrl?: string;
}

export interface PreparePostResult {
  status: "prepared" | "posted";
  insertedText: string;
  postUrl: string | null;
}

export interface CheckXLoginInput {
  profileDir: string;
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  xHomeUrl?: string;
}

export interface CheckXLoginResult {
  loggedIn: boolean;
  url: string;
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
  const editors = page.locator('[data-testid="tweetTextarea_0"], [aria-label*="Post text"], [aria-label*="Tweet text"]');
  if (!(await editors.first().isVisible({ timeout: 5_000 }).catch(() => false))) {
    return page.getByRole("textbox").first();
  }
  const count = await editors.count();
  let best = editors.first();
  let bestArea = -1;

  for (let index = 0; index < count; index += 1) {
    const candidate = editors.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) {
      continue;
    }
    const box = await candidate.boundingBox().catch(() => null);
    const area = box ? box.width * box.height : 0;
    if (area > bestArea) {
      best = candidate;
      bestArea = area;
    }
  }

  return best;
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

async function gotoXCompose(page: Page, xUrl: string, replyToUrl?: string | null) {
  const targetUrl = replyToUrl || xUrl;
  if (page.url().startsWith(targetUrl)) {
    return;
  }

  try {
    await page.goto(targetUrl, { waitUntil: "commit", timeout: 45_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown navigation error";
    const currentUrl = page.url();
    if (!message.includes("Timeout") || !currentUrl.startsWith(targetUrl)) {
      throw error;
    }
  }

  if (replyToUrl) {
    // If it's a reply, we need to click the reply button to open the editor
    const replyButton = page.locator('[data-testid="reply"]').first();
    await replyButton.click({ timeout: 15_000 }).catch(() => undefined);
  }
}

async function visibleEditorTexts(page: Page) {
  return page
    .locator('[data-testid="tweetTextarea_0"], [aria-label*="Post text"], [aria-label*="Tweet text"]')
    .evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ""));
}

async function typeIntoEditor(page: Page, editor: Locator, text: string, typingDelayMs: number) {
  await editor.click({ timeout: 15_000 });
  await editor.fill("", { timeout: 15_000 }).catch(async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
  });
  await page.waitForTimeout(250);
  await editor.fill(text, { timeout: 15_000 }).catch(async () => {
    await editor.click({ timeout: 15_000 });
    await page.keyboard.insertText(text);
  });
  if (typingDelayMs > 0) {
    await page.waitForTimeout(Math.min(typingDelayMs * 4, 500));
  }
}

async function readInsertedText(page: Page, editor: Locator) {
  const textContent = ((await editor.textContent().catch(() => null)) ?? "").trim();
  const inputValue = ((await editor.inputValue().catch(() => null)) ?? "").trim();
  const allEditorText = (await visibleEditorTexts(page)).find((value) => value.length > 0) ?? "";
  return textContent || inputValue || allEditorText;
}

async function uploadMedia(page: Page, mediaPaths: string[]) {
  if (mediaPaths.length === 0) {
    return;
  }

  const fileInput = page.locator('input[type="file"][data-testid="fileInput"], input[type="file"]').first();
  await fileInput.setInputFiles(mediaPaths, { timeout: 15_000 });
  await page.waitForTimeout(2_500);
}

async function enabledPostButton(page: Page) {
  const buttons = [
    page.locator('[data-testid="tweetButton"]').first(),
    page.locator('[data-testid="tweetButtonInline"]').first(),
    page.getByRole("button", { name: /^post$/i }).last()
  ];

  for (const button of buttons) {
    if (!(await button.isVisible({ timeout: 2_000 }).catch(() => false))) {
      continue;
    }
    const disabled = await button
      .evaluate((element) => element.getAttribute("aria-disabled") === "true" || (element as HTMLButtonElement).disabled)
      .catch(() => true);
    if (!disabled) {
      return button;
    }
  }

  throw new Error("Enabled X Post button could not be found");
}

function extractStatusPermalink(url: string) {
  const match = /https?:\/\/(?:x|twitter)\.com\/[A-Za-z0-9_]+\/status\/\d+/.exec(url);
  if (match?.[0]) {
    return match[0];
  }
  const pathMatch = /\/[A-Za-z0-9_]+\/status\/\d+/.exec(url);
  if (pathMatch?.[0]) {
    return `https://x.com${pathMatch[0]}`;
  }
  return null;
}

async function resolvePostedPermalink(page: Page) {
  const fromLocation = extractStatusPermalink(page.url());
  if (fromLocation) {
    return fromLocation;
  }
  const links = await page.locator('a[href*="/status/"]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("href") ?? "").filter(Boolean)
  );
  for (const link of links) {
    const permalink = extractStatusPermalink(link);
    if (permalink) {
      return permalink;
    }
  }
  const startMs = Date.now();
  while (Date.now() - startMs < 5_000) {
    await page.waitForTimeout(500);
    const url = page.url();
    const extracted = extractStatusPermalink(url);
    if (extracted) {
      return extracted;
    }
    const newLinks = await page.locator('a[href*="/status/"]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("href") ?? "").filter(Boolean)
    );
    for (const link of newLinks) {
      const permalink = extractStatusPermalink(link);
      if (permalink) {
        return permalink;
      }
    }
  }
  return null;
}

async function openPersistentContext(input: {
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  profileDir: string;
}) {
  const browser = input.cdpUrl ? await chromium.connectOverCDP(input.cdpUrl).catch(() => null) : null;
  if (input.cdpUrl && !browser) {
    throw new Error(
      `Chrome CDP is unavailable at ${input.cdpUrl}. Start ./zyquor or pnpm profile:x:cdp and keep that Chrome window open. Refusing to launch a fallback browser against the persistent X profile.`
    );
  }
  const browserChannel = input.browserChannel === "chromium" ? null : input.browserChannel;
  const chromeConfigDir = resolve(process.env.ZYQUOR_CHROME_CONFIG_DIR ?? "profiles/chrome-config");
  mkdirSync(chromeConfigDir, { recursive: true });
  const context =
    browser?.contexts()[0] ??
    (await chromium.launchPersistentContext(input.profileDir, {
      ...(browserChannel ? { channel: browserChannel } : {}),
      headless: input.headless ?? false,
      args: ["--no-sandbox", "--disable-crash-reporter", "--disable-dev-shm-usage", "--ozone-platform=x11"],
      env: { ...process.env, XDG_CONFIG_HOME: chromeConfigDir },
      viewport: { width: 1280, height: 900 }
    }));

  return {
    browser,
    context,
    ownsContext: !browser
  };
}

export async function checkXLogin(input: CheckXLoginInput): Promise<CheckXLoginResult> {
  const { context, ownsContext } = await openPersistentContext(input);

  try {
    const page =
      context.pages().find((item) => item.url().startsWith("https://x.com/") || item.url().startsWith("https://twitter.com/")) ??
      context.pages()[0] ??
      (await context.newPage());
    const currentUrl = page.url();
    if (!currentUrl.startsWith("https://x.com/") && !currentUrl.startsWith("https://twitter.com/")) {
      await page.goto(input.xHomeUrl ?? "https://x.com/home", { waitUntil: "domcontentloaded", timeout: 15_000 });
    }
    await page.waitForTimeout(2_500);
    await assertNotLoginPage(page);
    const result = { loggedIn: true, url: page.url() };
    if (ownsContext) {
      await context.close();
    }
    return result;
  } catch (error) {
    if (ownsContext) {
      await context.close().catch(() => undefined);
    }

    const message = error instanceof Error ? error.message : "Unknown X login check error";
    if (message.startsWith("X profile is not logged in.")) {
      return { loggedIn: false, url: input.xHomeUrl ?? "https://x.com/home" };
    }
    throw error;
  }
}

export async function preparePost(input: PreparePostInput): Promise<PreparePostResult> {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Post text is empty");
  }

  const artifactsDir = input.artifactsDir ?? "data/artifacts";
  const actionDelayMs = input.actionDelayMs ?? 1_800;
  const typingDelayMs = input.typingDelayMs ?? 20;
  mkdirSync(artifactsDir, { recursive: true });
  const artifactId = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = join(artifactsDir, `prepare-${artifactId}.png`);
  const tracePath = join(artifactsDir, `prepare-${artifactId}.zip`);

  const { context, ownsContext } = await openPersistentContext(input);

  try {
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(45_000);
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page =
      context.pages().find((item) => item.url().startsWith("https://x.com/compose")) ??
      context.pages().find((item) => item.url().startsWith("https://twitter.com/compose")) ??
      context.pages().find((item) => item.url().startsWith("https://x.com/")) ??
      context.pages()[0] ??
      (await context.newPage());
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => undefined);
    });
    await gotoXCompose(page, input.xUrl ?? "https://x.com/compose/post", input.replyToUrl);
    await page.waitForTimeout(actionDelayMs);
    await assertNotLoginPage(page);

    const editor = await firstVisibleEditor(page);
    await editor.waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(actionDelayMs);
    await typeIntoEditor(page, editor, text, typingDelayMs);
    await page.waitForTimeout(actionDelayMs);
    await uploadMedia(page, input.mediaPaths ?? []);
    await page.waitForTimeout(actionDelayMs);

    const insertedText = await readInsertedText(page, editor);
    if (!insertedText.includes(text)) {
      throw new Error("Inserted text could not be verified");
    }

    if (input.submit) {
      const postButton = await enabledPostButton(page);
      await page.waitForTimeout(actionDelayMs);
      await postButton.click();
      await page.waitForTimeout(Math.max(actionDelayMs, 4_000));
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      const stillPresent = (await visibleEditorTexts(page)).some((value) => value.includes(text));
      if (stillPresent) {
        throw new Error("X Post click did not clear the compose text");
      }
      const postUrl = await resolvePostedPermalink(page);
      if (!postUrl) {
        throw new Error("Posted tweet permalink could not be verified after X Post click");
      }
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
