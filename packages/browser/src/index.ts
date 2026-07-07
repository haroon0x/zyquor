import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { dataPath, profilesPath } from "@zyquor/core";

const isWsl = existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") || Boolean(process.env.WSL_DISTRO_NAME);

let activeCdpPid: number | null = null;

export async function ensureBrowserCdp(cdpUrl: string, profileDir: string): Promise<boolean> {
  const browser = await chromium.connectOverCDP(cdpUrl).catch(() => null);
  if (browser) {
    return true;
  }

  const port = process.env.ZYQUOR_BROWSER_CDP_PORT ?? new URL(cdpUrl).port;
  const workspaceRoot = process.env.ZYQUOR_DATA_ROOT ?? process.env.ZYQUOR_WORKSPACE_ROOT ?? resolve(process.cwd(), "../..");

  if (isWsl && process.env.ZYQUOR_WSL_PROFILE_BASE) {
    const wslBase = process.env.ZYQUOR_WSL_PROFILE_BASE;
    const profileName = profileDir.split(/[\\/]/).filter(Boolean).pop() ?? profileDir;
    const windowsUserDir = `${wslBase.replace("/mnt/c/", "C:\\").replace(/\//g, "\\")}\\${profileName}`;
    const wslUserDir = `${wslBase}/${profileName}`;
    mkdirSync(wslUserDir, { recursive: true });

    const psScript = [
      '$chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"',
      "$chromeArgs = @(",
      `  '--user-data-dir=${windowsUserDir}',`,
      "  '--profile-directory=Default',",
      `  '--remote-debugging-port=${port}',`,
      "  '--remote-debugging-address=0.0.0.0',",
      "  '--no-first-run',",
      "  '--no-default-browser-check',",
      "  '--disable-blink-features=AutomationControlled',",
      "  '--no-sandbox',",
      "  '--disable-dev-shm-usage',",
      "  'https://x.com/home'",
      ")",
      "Start-Process -FilePath $chrome -ArgumentList $chromeArgs"
    ].join("\n");

    const psPath = "/tmp/launch-chrome-cdp.ps1";
    writeFileSync(psPath, psScript);

    const child = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", psPath.replace("/mnt/c/", "C:\\").replace(/\//g, "\\")], {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", () => undefined);
    child.unref();
    activeCdpPid = child.pid ?? null;
  } else {
    const chromeBin = process.env.CHROME_BIN ?? "google-chrome-stable";
    const chromeConfigDir = process.env.ZYQUOR_CHROME_CONFIG_DIR ? resolve(process.env.ZYQUOR_CHROME_CONFIG_DIR) : profilesPath("chrome-config");
    mkdirSync(chromeConfigDir, { recursive: true });
    const child = spawn(chromeBin, [
      `--user-data-dir=${resolve(profileDir)}`,
      "--profile-directory=Default",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-crash-reporter",
      "--disable-dev-shm-usage",
      "--ozone-platform=x11",
      "https://x.com/home"
    ], {
      detached: true,
      env: { ...process.env, XDG_CONFIG_HOME: chromeConfigDir },
      stdio: "ignore"
    });
    child.on("error", () => undefined);
    child.unref();
    activeCdpPid = child.pid ?? null;
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1_000));
    const connected = await chromium.connectOverCDP(cdpUrl).catch(() => null);
    if (connected) {
      return true;
    }
  }

  return false;
}

export async function closeBrowserCdp(cdpUrl: string): Promise<void> {
  try {
    const browser = await chromium.connectOverCDP(cdpUrl).catch(() => null);
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  } catch {
    /* ignore */
  }

  if (activeCdpPid) {
    try {
      process.kill(activeCdpPid, "SIGTERM");
    } catch {
      /* already gone */
    }
    activeCdpPid = null;
  }
}

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

function isXPage(page: Page) {
  const url = page.url();
  return url.startsWith("https://x.com/") || url.startsWith("https://twitter.com/");
}

function existingXPage(context: BrowserContext) {
  const pages = context.pages().filter(isXPage);
  return pages.find((item) => item.url().startsWith("https://x.com/compose")) ?? pages[0] ?? null;
}

async function closeDuplicateXPages(context: BrowserContext) {
  const pages = context.pages().filter(isXPage);
  if (pages.length <= 1) {
    return;
  }
  const keep = pages.find((item) => item.url().startsWith("https://x.com/compose")) ?? pages[0];
  await Promise.all(pages.filter((page) => page !== keep).map((page) => page.close().catch(() => undefined)));
}

async function pageForSessionCheck(context: BrowserContext, input: CheckXLoginInput) {
  await closeDuplicateXPages(context);
  const xPage = existingXPage(context);
  if (xPage) return xPage;
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(input.xHomeUrl ?? "https://x.com/home", { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => undefined);
  return page;
}

async function pageForPost(context: BrowserContext, input: PreparePostInput) {
  await closeDuplicateXPages(context);
  const xPage = existingXPage(context);
  if (xPage) return xPage;
  if (input.cdpUrl) {
    throw new Error("No existing X tab is open in Chrome CDP. Open one X tab and retry.");
  }
  return context.pages()[0] ?? (await context.newPage());
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
  autoLaunchCdp?: boolean;
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  profileDir: string;
}) {
  let browser = input.cdpUrl ? await chromium.connectOverCDP(input.cdpUrl).catch(() => null) : null;
  if (input.cdpUrl && !browser && input.autoLaunchCdp !== false) {
    const autoLaunched = await ensureBrowserCdp(input.cdpUrl, input.profileDir);
    if (autoLaunched) {
      browser = await chromium.connectOverCDP(input.cdpUrl).catch(() => null);
    }
    if (!browser) {
      throw new Error(
        `Chrome CDP is unavailable at ${input.cdpUrl}. Launch failed or CDP did not become available within 30 seconds.`
      );
    }
  } else if (input.cdpUrl && !browser) {
    throw new Error(
      `Chrome CDP is unavailable at ${input.cdpUrl}. Start ./zyquor or pnpm profile:x:cdp and keep that Chrome window open. Refusing to launch a fallback browser against the persistent X profile.`
    );
  }
  const browserChannel = input.browserChannel === "chromium" ? null : input.browserChannel;
  const chromeConfigDir = process.env.ZYQUOR_CHROME_CONFIG_DIR ? resolve(process.env.ZYQUOR_CHROME_CONFIG_DIR) : profilesPath("chrome-config");
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
  const { context, ownsContext } = await openPersistentContext({
    ...input,
    autoLaunchCdp: false
  });

  try {
    const page = await pageForSessionCheck(context, input);
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

  const { context, ownsContext } = await openPersistentContext({
    ...input,
    autoLaunchCdp: true
  });

  try {
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(45_000);
    await context.tracing.start({ screenshots: true, snapshots: true });
    const page = await pageForPost(context, input);
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
