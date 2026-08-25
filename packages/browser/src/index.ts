import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { platform } from "node:os";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { dataPath, profilesPath, resolveDataRoot, type ReplyTarget } from "@zyquor/core";

export function resolveProfileDir(profileDir: string): string {
  return isAbsolute(profileDir) ? profileDir : resolve(resolveDataRoot(), profileDir);
}

// Must check the actual platform: WSL_DISTRO_NAME leaks into Windows
// processes launched from WSL terminals, which would wrongly select the WSL
// Chrome branch inside a native Windows app.
const isWsl = platform() === "linux" && (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") || Boolean(process.env.WSL_DISTRO_NAME));

let activeCdpPid: number | null = null;
let activeCdpProfileDir: string | null = null;

interface CdpLaunchState {
  profileDir: string;
  pid: number | null;
}

// posting-chrome.json is written by whichever OS runs the posting Chrome, so a
// record may hold a Windows absolute path ("C:\Users\...\profiles\name") even
// while this code resolves against a POSIX data root. resolveProfileDir turns
// such a record into root + "C:\..." garbage; detect that and rebuild the
// canonical <dataRoot>/profiles/<name> path from the stored tail instead.
function normalizeStoredProfileDir(stored: string): string {
  const resolved = resolveProfileDir(stored);
  if (!/[A-Za-z]:[\\/]/.test(resolved)) return resolved;
  const normalized = stored.replaceAll("\\", "/");
  const marker = "/profiles/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return resolved;
  return dataPath("profiles", normalized.slice(index + marker.length));
}

// Shared with apps/desktop/src/chrome.ts so both launchers agree on which
// X account the running posting Chrome carries.
export function cdpLaunchStateFile(): string {
  return dataPath("posting-chrome.json");
}

export function readCdpLaunchState(): CdpLaunchState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cdpLaunchStateFile(), "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { profileDir?: unknown }).profileDir === "string"
    ) {
      const record = parsed as { profileDir: string; pid?: unknown };
      return {
        profileDir: normalizeStoredProfileDir(record.profileDir),
        pid: typeof record.pid === "number" ? record.pid : null
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function writeCdpLaunchState(state: CdpLaunchState): void {
  try {
    mkdirSync(join(cdpLaunchStateFile(), ".."), { recursive: true });
    writeFileSync(cdpLaunchStateFile(), JSON.stringify(state));
  } catch {
    /* best effort */
  }
}

export function clearCdpLaunchState(): void {
  try {
    // "{}" (not "") so readers get null deterministically without relying on
    // JSON.parse throwing.
    writeFileSync(cdpLaunchStateFile(), "{}");
  } catch {
    /* best effort */
  }
}

function findChromeExecutable(): string {
  const envPath = process.env.ZYQUOR_CHROME_PATH ?? process.env.CHROME_BIN;
  if (envPath && existsSync(envPath)) return envPath;

  if (platform() === "win32") {
    const localAppData = process.env.LocalAppData ?? "C:\\Users\\user\\AppData\\Local";
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      resolve(localAppData, "Google\\Chrome\\Application\\chrome.exe")
    ];
    return candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  }
  if (platform() === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  return "google-chrome-stable";
}


export async function ensureBrowserCdp(cdpUrl: string, profileDir: string): Promise<boolean> {
  const wantedProfileDir = resolveProfileDir(profileDir);
  const browser = await chromium.connectOverCDP(cdpUrl).catch(() => null);
  if (browser) {
    // Single-account rule: this module never launches, kills, or switches the
    // posting Chrome. The owning launcher (desktop chrome.ts, or the WSL
    // branch below when nothing is running) decides which profile runs. If a
    // browser is already attached for a different profile, refuse: the caller
    // must activate the right account first.
    const knownProfileDir = activeCdpProfileDir ?? readCdpLaunchState()?.profileDir ?? null;
    if (knownProfileDir === null || knownProfileDir === wantedProfileDir) {
      activeCdpProfileDir = wantedProfileDir;
      return true;
    }
    console.error(
      `[browser] posting Chrome is attached for a different account profile; refusing to post. ` +
        `Activate the requested account first (wanted: ${wantedProfileDir}, attached: ${knownProfileDir})`
    );
    return false;
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
    activeCdpProfileDir = resolveProfileDir(profileDir);
    writeCdpLaunchState({ profileDir: activeCdpProfileDir, pid: activeCdpPid });
  } else {
    const chromeBin = findChromeExecutable();
    const chromeConfigDir = process.env.ZYQUOR_CHROME_CONFIG_DIR ? resolve(process.env.ZYQUOR_CHROME_CONFIG_DIR) : profilesPath("chrome-config");
    mkdirSync(chromeConfigDir, { recursive: true });
    const child = spawn(chromeBin, [
      `--user-data-dir=${resolveProfileDir(profileDir)}`,
      "--profile-directory=Default",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-crash-reporter",
      "--disable-dev-shm-usage",
      ...(platform() === "win32" ? [] : ["--ozone-platform=x11"]),
      "https://x.com/home"
    ], {
      detached: true,
      env: { ...process.env, XDG_CONFIG_HOME: chromeConfigDir },
      stdio: "ignore"
    });
    let spawnFailed = false;
    child.on("error", () => {
      spawnFailed = true;
    });
    child.unref();
    activeCdpPid = child.pid ?? null;
    activeCdpProfileDir = resolveProfileDir(profileDir);
    writeCdpLaunchState({ profileDir: activeCdpProfileDir, pid: activeCdpPid });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (spawnFailed) {
        console.error(`[browser] failed to launch Chrome via ${chromeBin}; cannot post`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 1_000));
      const connected = await chromium.connectOverCDP(cdpUrl).catch(() => null);
      if (connected) {
        activeCdpProfileDir = wantedProfileDir;
        return true;
      }
    }
    return false;
  }

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1_000));
    const connected = await chromium.connectOverCDP(cdpUrl).catch(() => null);
    if (connected) {
      activeCdpProfileDir = wantedProfileDir;
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
  activeCdpProfileDir = null;
  clearCdpLaunchState();
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
  replyTo?: ReplyTarget;
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
  /** Screen name actually logged in inside this browser, lowercase, no @.
   * null when logged in but the handle could not be read. */
  handle: string | null;
}

export interface XFeedTweet {
  id: string;
  authorHandle: string;
  authorName: string;
  text: string;
  url: string;
  publishedAt: string | null;
  isRetweet: boolean;
  isPromoted?: boolean;
  hasLink?: boolean;
}

export interface FetchXHomeFeedInput {
  profileDir: string;
  maxTweets?: number;
  minTweets?: number;
  scrolls?: number;
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  xHomeUrl?: string;
  actionDelayMs?: number;
  artifactsDir?: string;
}

export interface FetchXHomeFeedResult {
  tweets: XFeedTweet[];
  url: string;
}

export interface FetchAccountTimelineInput {
  profileDir: string;
  handle: string;
  maxTweets?: number;
  scrolls?: number;
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  actionDelayMs?: number;
  artifactsDir?: string;
}

export interface FetchAccountTimelineResult {
  tweets: XFeedTweet[];
  url: string;
}

export interface FetchTweetInput {
  profileDir: string;
  url: string;
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  actionDelayMs?: number;
  artifactsDir?: string;
}

export interface FetchTweetResult {
  tweet: XFeedTweet;
  url: string;
}

export interface TweetPerformanceMetrics {
  id: string;
  url: string;
  views: number | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  bookmarks: number | null;
  measuredAt: string;
}

export interface FetchTweetPerformanceInput {
  profileDir: string;
  url: string;
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  actionDelayMs?: number;
  artifactsDir?: string;
}

export interface FetchTweetPerformanceResult {
  metrics: TweetPerformanceMetrics;
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

export class BrowserFeedError extends BrowserPrepareError {
  constructor(message: string, screenshotPath: string | null = null) {
    super(message, screenshotPath);
    this.name = "BrowserFeedError";
  }
}

async function stopTracing(context: BrowserContext, path?: string) {
  const stop = path ? context.tracing.stop({ path }) : context.tracing.stop();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([stop, new Promise<void>((resolve) => {
    timeout = setTimeout(resolve, 5_000);
  })]).catch(() => undefined);
  if (timeout) clearTimeout(timeout);
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
  const parsedUrl = new URL(url);
  const loginOnboarding =
    parsedUrl.pathname.startsWith("/i/jf/onboarding/") &&
    (parsedUrl.searchParams.get("mode") === "login" || parsedUrl.searchParams.has("redirect_after_login"));

  if (url.includes("/login") || url.includes("/i/flow/login") || loginOnboarding) {
    throw new Error("X profile is not logged in. Run `pnpm profile:x:manual`, log into X, close that browser, then retry.");
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const loginVisible = await page
      .locator('input[name="text"], input[name="password"], [data-testid="loginButton"], a[href="/login"]')
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    if (loginVisible) {
      throw new Error("X profile is not logged in. Run `pnpm profile:x:manual`, log into X, close that browser, then retry.");
    }
    const authenticatedUiVisible = await page
      .locator('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Home_Link"], a[data-testid="AppTabBar_Profile_Link"]')
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (authenticatedUiVisible) {
      return;
    }
    if (attempt < 2) {
      await page.waitForTimeout(2_000);
    }
  }
  throw new Error("X profile is not logged in. Run `pnpm profile:x:manual`, log into X, close that browser, then retry.");
}

export async function openPostComposer(page: Page, xUrl: string, replyTo?: ReplyTarget, replyToUrl?: string | null) {
  const targetUrl = replyTo?.url ?? replyToUrl ?? xUrl;
  if (!page.url().startsWith(targetUrl)) {
    try {
      await page.goto(targetUrl, { waitUntil: "commit", timeout: 45_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown navigation error";
      const currentUrl = page.url();
      if (!message.includes("Timeout") || !currentUrl.startsWith(targetUrl)) {
        throw error;
      }
    }
  }

  if (replyTo || replyToUrl) {
    const replyButton = page.locator('article[data-testid="tweet"] [data-testid="reply"], [data-testid="reply"]').first();
    await replyButton.click({ timeout: 15_000 });
  }
}

function isXPage(page: Page) {
  const url = page.url();
  return url.startsWith("https://x.com/") || url.startsWith("https://twitter.com/");
}

function isHomeFeedPage(page: Page) {
  if (!isXPage(page)) {
    return false;
  }
  try {
    return new URL(page.url()).pathname === "/home";
  } catch {
    return false;
  }
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

async function pageForHomeFeed(context: BrowserContext, input: FetchXHomeFeedInput) {
  const page = await pageForSessionCheck(context, input);
  const targetUrl = input.xHomeUrl ?? "https://x.com/home";
  const alreadyAtHome = input.xHomeUrl ? page.url() === targetUrl : isHomeFeedPage(page);
  if (alreadyAtHome) {
    return page;
  }
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown X home feed navigation error";
    if (!message.includes("Timeout") || (input.xHomeUrl ? page.url() !== targetUrl : !isHomeFeedPage(page))) {
      throw error;
    }
  });
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
  if (browser) {
    // Single-account rule: refuse to attach when the running posting Chrome
    // verifiably carries a different account profile (mirrors the
    // ensureBrowserCdp known-profile logic). Unknown provenance (no state)
    // is allowed; the launcher decides which profile runs.
    const wantedProfileDir = resolveProfileDir(input.profileDir);
    const knownProfileDir = activeCdpProfileDir ?? readCdpLaunchState()?.profileDir ?? null;
    if (knownProfileDir !== null && knownProfileDir !== wantedProfileDir) {
      console.error(
        `[browser] posting Chrome is attached for a different account profile; refusing. ` +
          `Activate the requested account first (wanted: ${wantedProfileDir}, attached: ${knownProfileDir})`
      );
      throw new Error(
        `The running posting Chrome belongs to a different account profile; activate the requested account before posting.`
      );
    }
    activeCdpProfileDir = wantedProfileDir;
  }
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
    const handle = await readLoggedInHandle(page).catch(() => null);
    const result = { loggedIn: true, url: page.url(), handle };
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
      return { loggedIn: false, url: input.xHomeUrl ?? "https://x.com/home", handle: null };
    }
    throw error;
  }
}

// Identity check: which account is REALLY logged in? Reads the side-nav
// profile link first (cheap, stable), then falls back to the credentials
// endpoint with the ct0 CSRF cookie, exactly like the X web client does.
// Guards every downstream action against posting from the wrong account.
async function readLoggedInHandle(page: Page): Promise<string | null> {
  const raw = await page.evaluate(async () => {
    const profileLink = document
      .querySelector<HTMLAnchorElement>('a[data-testid="AppTabBar_Profile_Link"]')
      ?.getAttribute("href");
    if (profileLink && /^\/[A-Za-z0-9_]{1,15}\/?$/.test(profileLink)) {
      return profileLink.replace(/^\//, "").replace(/\/$/, "");
    }
    try {
      const csrf = document.cookie
        .split("; ")
        .find((cookie) => cookie.startsWith("ct0="))
        ?.split("=")[1];
      const response = await fetch(
        "/i/api/1.1/account/verify_credentials.json?skip_status=1",
        {
          credentials: "include",
          headers: csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {}
        }
      );
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data?.screen_name === "string" ? data.screen_name : null;
    } catch {
      return null;
    }
  });
  const normalized = typeof raw === "string" ? raw.trim().replace(/^@/, "").toLowerCase() : "";
  return /^[a-z0-9_]{1,15}$/.test(normalized) ? normalized : null;
}

async function extractFeedTweets(page: Page, maxTweets: number) {
  const raw = await page.locator('article[data-testid="tweet"]').evaluateAll((articles) =>
    articles.map((article) => {
      const statusLink = article.querySelector('a[href*="/status/"]')?.getAttribute("href") ?? null;
      const text = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? "";
      const userName = article.querySelector('[data-testid="User-Name"]')?.textContent ?? "";
      const socialContext = article.querySelector('[data-testid="socialContext"]')?.textContent ?? "";
      const headerText = article.querySelector("header")?.textContent ?? "";
      const publishedAt = article.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
      const placementText = article.closest('[data-testid="placementTracking"]')?.textContent ?? "";
      const ariaLabels = Array.from(article.querySelectorAll("[aria-label]"))
        .map((element) => element.getAttribute("aria-label") ?? "")
        .join(" ");
      const promotionText = `${socialContext} ${headerText} ${placementText} ${ariaLabels}`;
      const isPromoted = /\b(promoted|sponsored|advertisement|advertiser)\b/i.test(promotionText);
      const hasLink = Array.from(article.querySelectorAll("a[href]"))
        .map((anchor) => anchor.getAttribute("href") ?? "")
        .filter((href) => href.length > 0)
        .some(
          (href) =>
            !/\/status\/(\d+)(\/|$)/.test(href) &&
            !/^\/[A-Za-z0-9_]{1,15}\/?$/.test(href) &&
            (/^(https?:)?\/\//.test(href) || href.includes("t.co/"))
        );
      return { statusLink, text, userName, socialContext, headerText, publishedAt, isPromoted, hasLink };
    })
  );

  const seen = new Set<string>();
  const tweets: XFeedTweet[] = [];
  for (const entry of raw) {
    if (entry.isPromoted || !entry.statusLink || !entry.text) continue;
    const url = extractStatusPermalink(entry.statusLink);
    if (!url || seen.has(url)) continue;
    const idMatch = /\/(\d+)$/.exec(url);
    const handleMatch = /^\/([A-Za-z0-9_]{1,15})\/status\//.exec(new URL(url).pathname);
    if (!idMatch || !handleMatch) continue;
    seen.add(url);
    const handle = handleMatch[1]!;
    const authorName = cleanAuthorName(entry.userName, handle);
    tweets.push({
      id: idMatch[1]!,
      authorHandle: handle,
      authorName,
      text: entry.text,
      url,
      publishedAt: entry.publishedAt,
      isRetweet: /reposted/i.test(`${entry.socialContext} ${entry.headerText}`),
      isPromoted: entry.isPromoted,
      hasLink: entry.hasLink
    });
    if (tweets.length >= maxTweets) break;
  }
  return tweets;
}

async function extractTweetFromStatusPage(page: Page, statusUrl: string): Promise<XFeedTweet | null> {
  const idMatch = /\/(\d+)\/?$/.exec(new URL(statusUrl).pathname);
  if (!idMatch) {
    return null;
  }
  const tweetId = idMatch[1]!;
  const raw = await page.locator('article[data-testid="tweet"]').evaluateAll(
    (articles, tid) =>
      articles.map((article) => {
        const statusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]'))
          .map((anchor) => anchor.getAttribute("href") ?? "")
          .filter(Boolean);
        const canonicalLink =
          statusLinks.find((href) => {
            const m = /\/[A-Za-z0-9_]+\/status\/(\d+)\/?$/.exec(href);
            return m?.[1] === tid;
          }) ?? null;
        const normalText = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? "";
        const longformText = article
          .querySelector('[data-testid="longformRichTextComponent"], [data-testid="twitterArticleRichTextView"]')
          ?.textContent?.trim() ?? "";
        const fallbackText = article.querySelector('[data-testid="tweet"] [dir="auto"]')?.textContent?.trim() ?? "";
        const text = (normalText || longformText || fallbackText).trim();
        const userName = article.querySelector('[data-testid="User-Name"]')?.textContent ?? "";
        const socialContext = article.querySelector('[data-testid="socialContext"]')?.textContent ?? "";
        const headerText = article.querySelector("header")?.textContent ?? "";
        const publishedAt = article.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
        const isPromoted = /\b(promoted|sponsored|advertisement|advertiser)\b/i.test(
          `${socialContext} ${headerText}`
        );
        const hasLink = Array.from(article.querySelectorAll("a[href]"))
          .map((anchor) => anchor.getAttribute("href") ?? "")
          .filter((href) => href.length > 0)
          .some(
            (href) =>
              !/\/status\/(\d+)(\/|$)/.test(href) &&
              !/^\/[A-Za-z0-9_]{1,15}\/?$/.test(href) &&
              (/^(https?:)?\/\//.test(href) || href.includes("t.co/"))
          );
        return {
          statusLink: canonicalLink,
          text,
          userName,
          socialContext,
          headerText,
          publishedAt,
          isPromoted,
          hasLink
        };
      }),
    tweetId
  );

  const entry = raw.find((item) => item.statusLink && /\/status\/\d+\/?$/.test(item.statusLink));
  if (!entry) {
    return null;
  }
  const url = extractStatusPermalink(entry.statusLink!);
  if (!url) {
    return null;
  }
  const handleMatch = /^\/([A-Za-z0-9_]{1,15})\/status\//.exec(new URL(url).pathname);
  if (!handleMatch) {
    return null;
  }
  const handle = handleMatch[1]!;
  const authorName = cleanAuthorName(entry.userName, handle);
  return {
    id: tweetId,
    authorHandle: handle,
    authorName,
    text: entry.text,
    url,
    publishedAt: entry.publishedAt,
    isRetweet: /reposted/i.test(`${entry.socialContext} ${entry.headerText}`),
    isPromoted: entry.isPromoted,
    hasLink: entry.hasLink
  };
}

function cleanAuthorName(nameLine: string, handle: string): string {
  const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const name = (nameLine.split("\n")[0] ?? "")
    .trim()
    .replace(new RegExp(`@${escaped}.*$`, "i"), "")
    .replace(/\s+·\s*.*$/u, "")
    .replace(/@$/, "")
    .trim();
  return name || handle;
}

async function collectFeedTweets(page: Page, maxTweets: number, minTweets: number, scrolls: number, actionDelayMs: number) {
  const collected = new Map<string, XFeedTweet>();
  const collectVisibleTweets = async () => {
    const visibleTweets = await extractFeedTweets(page, maxTweets);
    for (const tweet of visibleTweets) {
      if (!collected.has(tweet.url)) {
        collected.set(tweet.url, tweet);
      }
    }
  };

  await page.waitForTimeout(actionDelayMs);
  await collectVisibleTweets();
  for (let index = 0; index < scrolls && collected.size < minTweets; index += 1) {
    await page.mouse.wheel(0, 2_400);
    await page.evaluate(() => window.scrollBy(0, 2_400)).catch(() => undefined);
    await page.waitForTimeout(actionDelayMs);
    await collectVisibleTweets();
  }

  return Array.from(collected.values()).slice(0, maxTweets);
}

export async function fetchXHomeFeed(input: FetchXHomeFeedInput): Promise<FetchXHomeFeedResult> {
  const maxTweets = input.maxTweets ?? 20;
  const minTweets = input.minTweets ?? 15;
  const scrolls = input.scrolls ?? 8;
  const actionDelayMs = input.actionDelayMs ?? 1_500;
  const artifactsDir = input.artifactsDir ?? dataPath("data", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifactId = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = join(artifactsDir, `feed-${artifactId}.png`);

  let context: BrowserContext | null = null;
  let ownsContext = false;

  try {
    const opened = await openPersistentContext({
      ...input,
      autoLaunchCdp: false
    });
    context = opened.context;
    ownsContext = opened.ownsContext;
    context.setDefaultTimeout(30_000);
    const page = await pageForHomeFeed(context, input);
    await assertNotLoginPage(page);
    let tweets = await collectFeedTweets(page, maxTweets, minTweets, scrolls, actionDelayMs);
    if (tweets.length < minTweets) {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      await assertNotLoginPage(page);
      tweets = await collectFeedTweets(page, maxTweets, minTweets, scrolls, actionDelayMs);
    }
    if (tweets.length < minTweets) {
      throw new Error(`Only ${tweets.length} tweets extracted from the X home feed (minimum ${minTweets})`);
    }
    const url = page.url();
    if (ownsContext) {
      await context.close();
    }
    return { tweets, url };
  } catch (error) {
    const page = context?.pages()[0];
    if (page) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : "Unknown X home feed fetch error";
    if (context && ownsContext) {
      await context.close();
    }
    throw new BrowserFeedError(message, context ? screenshotPath : null);
  }
}

export async function fetchAccountTimeline(input: FetchAccountTimelineInput): Promise<FetchAccountTimelineResult> {
  const maxTweets = input.maxTweets ?? 30;
  const scrolls = input.scrolls ?? 10;
  const actionDelayMs = input.actionDelayMs ?? 1_500;
  const targetUrl = `https://x.com/${input.handle}`;

  let context: BrowserContext | null = null;
  let ownsContext = false;

  try {
    const opened = await openPersistentContext({
      ...input,
      autoLaunchCdp: false
    });
    context = opened.context;
    ownsContext = opened.ownsContext;
    context.setDefaultTimeout(30_000);
    const page = await pageForSessionCheck(context, input);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
    await assertNotLoginPage(page);
    const tweets = await collectFeedTweets(page, maxTweets, Math.min(maxTweets, 5), scrolls, actionDelayMs);
    const url = page.url();
    if (ownsContext) {
      await context.close();
    }
    return { tweets, url };
  } catch (error) {
    const page = context?.pages()[0];
    if (page) {
      await page.screenshot({ path: join(input.artifactsDir ?? dataPath("data", "artifacts"), `profile-${new Date().toISOString().replace(/[:.]/g, "-")}.png`), fullPage: true }).catch(() => undefined);
    }
    if (context && ownsContext) {
      await context.close();
    }
    throw error;
  }
}

export async function fetchTweet(input: FetchTweetInput): Promise<FetchTweetResult> {
  const actionDelayMs = input.actionDelayMs ?? 1_500;
  const artifactsDir = input.artifactsDir ?? dataPath("data", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifactId = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = join(artifactsDir, `tweet-${artifactId}.png`);

  let context: BrowserContext | null = null;
  let ownsContext = false;
  let page: Page | null = null;

  try {
    const opened = await openPersistentContext({
      ...input,
      autoLaunchCdp: false
    });
    context = opened.context;
    ownsContext = opened.ownsContext;
    context.setDefaultTimeout(30_000);
    page = await context.newPage();
    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);

    const loginVisible = await page
      .locator('input[name="text"], input[name="password"], a[href="/login"], [data-testid="loginButton"]')
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (loginVisible) {
      throw new Error("X profile is not logged in. Run `pnpm profile:x:manual`, log into X, close that browser, then retry.");
    }

    const tab = page;
    const tweetIsReady = () =>
      tab
        .evaluate(() => {
          const hasArticle = !!document.querySelector('article[data-testid="tweet"]');
          const hasText = !!document.querySelector(
            '[data-testid="tweetText"], [data-testid="longformRichTextComponent"]'
          );
          const hasPermalink = Array.from(document.querySelectorAll('a[href*="/status/"]')).some(
            (anchor) => /\/status\/\d+\/?$/.test(anchor.getAttribute("href") ?? "")
          );
          return hasArticle && (hasText || hasPermalink);
        })
        .catch(() => false);

    let loaded = false;
    for (let attempt = 0; attempt < 3 && !loaded; attempt++) {
      const pollDeadline = Date.now() + 20_000;
      while (Date.now() < pollDeadline) {
if (await tweetIsReady()) {
        loaded = true;
        break;
      }
        await page.waitForTimeout(1_500);
      }
      if (!loaded && attempt < 2) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      }
    }
    if (!loaded) {
      const diag = await page
        .evaluate(() => ({
          url: location.href.slice(0, 120),
          title: document.title.slice(0, 60),
          visibility: document.visibilityState,
          bodyPreview: document.body?.innerText?.slice(0, 160)
        }))
        .catch(() => null);
      throw new Error(`Timed out waiting for the target tweet to render at ${input.url}. ${JSON.stringify(diag)}`);
    }
    await page.waitForTimeout(actionDelayMs);
    const tweet = await extractTweetFromStatusPage(page, input.url);
    if (!tweet || !tweet.text.trim()) {
      throw new Error(`Could not extract the target tweet from ${input.url}`);
    }
    await page.close().catch(() => undefined);
    page = null;
    if (ownsContext) {
      await context.close();
    }
    return { tweet, url: input.url };
  } catch (error) {
    if (page) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      await page.close().catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : "Unknown tweet fetch error";
    if (context && ownsContext) {
      await context.close();
    }
    throw new BrowserFeedError(message, context ? screenshotPath : null);
  }
}

function parseCount(value: string | null | undefined): number | null {
  if (!value) return null;
  const cleaned = value.replace(/,/g, "").replace(/\s+/g, "").toLowerCase();
  const match = /^([\d.]+)([kmb])?$/.exec(cleaned);
  if (!match) return null;
  const num = Number(match[1]);
  if (!Number.isFinite(num)) return null;
  const multiplier = match[2] === "k" ? 1_000 : match[2] === "m" ? 1_000_000 : match[2] === "b" ? 1_000_000_000 : 1;
  return Math.round(num * multiplier);
}

function extractUnitCount(sources: string[], pattern: RegExp): number | null {
  for (const source of sources) {
    const match = pattern.exec(source);
    if (match?.[1]) {
      const parsed = parseCount(match[1]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

async function extractTweetPerformance(page: Page, statusUrl: string): Promise<TweetPerformanceMetrics> {
  const permalink = extractStatusPermalink(statusUrl) ?? statusUrl;
  const idMatch = /\/(\d+)\/?$/.exec(new URL(permalink).pathname);
  const tweetId = idMatch?.[1] ?? "";

  const raw = await page.locator('article[data-testid="tweet"]').first().evaluate((article) => {
    const labels: string[] = [];
    const containers: string[] = [];
    for (const element of Array.from(article.querySelectorAll("[aria-label]"))) {
      const label = element.getAttribute("aria-label");
      if (label) labels.push(label);
    }
    for (const element of Array.from(article.querySelectorAll('[data-testid="app-text-transition-container"]'))) {
      const text = element.textContent ?? "";
      if (text.trim()) containers.push(text.trim());
    }
    const body = (article as HTMLElement).innerText ?? "";
    return { labels, containers, body };
  });

  const sources = [...raw.labels, ...raw.containers, raw.body];
  return {
    id: tweetId,
    url: permalink,
    views: extractUnitCount(sources, /([\d.,]+\s*[kmb]?)\s*views?\b/i),
    replies: extractUnitCount(sources, /([\d.,]+\s*[kmb]?)\s*repl\w*\b/i),
    reposts: extractUnitCount(sources, /([\d.,]+\s*[kmb]?)\s*repost\w*\b/i),
    likes: extractUnitCount(sources, /([\d.,]+\s*[kmb]?)\s*l\w*es?\b/i),
    bookmarks: extractUnitCount(sources, /([\d.,]+\s*[kmb]?)\s*bookmark\w*\b/i),
    measuredAt: new Date().toISOString()
  };
}

export async function fetchTweetPerformance(input: FetchTweetPerformanceInput): Promise<FetchTweetPerformanceResult> {
  const actionDelayMs = input.actionDelayMs ?? 1_500;
  const artifactsDir = input.artifactsDir ?? dataPath("data", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifactId = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = join(artifactsDir, `performance-${artifactId}.png`);

  let context: BrowserContext | null = null;
  let ownsContext = false;
  let page: Page | null = null;

  try {
    const opened = await openPersistentContext({
      ...input,
      autoLaunchCdp: false
    });
    context = opened.context;
    ownsContext = opened.ownsContext;
    context.setDefaultTimeout(30_000);
    page = await context.newPage();
    await page.goto(input.url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);

    const loginVisible = await page
      .locator('input[name="text"], input[name="password"], a[href="/login"], [data-testid="loginButton"]')
      .first()
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    if (loginVisible) {
      throw new Error("X profile is not logged in. Run `pnpm profile:x:manual`, log into X, close that browser, then retry.");
    }

    const tab = page;
    const metricsReady = () =>
      tab
        .evaluate(() => {
          const hasArticle = !!document.querySelector('article[data-testid="tweet"]');
          const hasText = !!document.querySelector('[data-testid="tweetText"], [data-testid="longformRichTextComponent"]');
          const hasActionBar = !!document.querySelector(
            '[data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [data-testid="bookmark"]'
          );
          return hasArticle && (hasText || hasActionBar);
        })
        .catch(() => false);

    let loaded = false;
    for (let attempt = 0; attempt < 3 && !loaded; attempt += 1) {
      const pollDeadline = Date.now() + 20_000;
      while (Date.now() < pollDeadline) {
        if (await metricsReady()) {
          loaded = true;
          break;
        }
        await page.waitForTimeout(1_500);
      }
      if (!loaded && attempt < 2) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
      }
    }
    if (!loaded) {
      throw new Error(`Timed out waiting for tweet metrics to render at ${input.url}`);
    }
    await page.waitForTimeout(actionDelayMs);
    const metrics = await extractTweetPerformance(page, input.url);
    await page.close().catch(() => undefined);
    page = null;
    if (ownsContext) {
      await context.close();
    }
    return { metrics };
  } catch (error) {
    if (page) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      await page.close().catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : "Unknown tweet performance fetch error";
    if (context && ownsContext) {
      await context.close();
    }
    throw new BrowserFeedError(message, context ? screenshotPath : null);
  }
}

export async function preparePost(input: PreparePostInput): Promise<PreparePostResult> {
  const text = input.text.trim();
  if (!text) {
    throw new Error("Post text is empty");
  }

  const artifactsDir = input.artifactsDir ?? dataPath("data", "artifacts");
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
    await openPostComposer(page, input.xUrl ?? "https://x.com/compose/post", input.replyTo, input.replyToUrl);
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

      const startMs = Date.now();
      let cleared = false;
      let postUrl: string | null = null;
      while (Date.now() - startMs < 15_000) {
        if (!(await visibleEditorTexts(page)).some((value) => value.includes(text))) {
          cleared = true;
          break;
        }
        postUrl = await resolvePostedPermalink(page);
        if (postUrl) {
          cleared = true;
          break;
        }
        await page.waitForTimeout(1_000);
      }
      if (!cleared) {
        throw new Error("X Post click did not clear the compose text");
      }
      if (!postUrl) {
        postUrl = await resolvePostedPermalink(page);
      }
      if (!postUrl) {
        throw new Error("Posted tweet permalink could not be verified after X Post click");
      }
      await stopTracing(context);
      if (ownsContext) {
        await context.close();
      }
      return { status: "posted", insertedText, postUrl };
    }

    await stopTracing(context);
    if (ownsContext && (input.closeAfterPrepare ?? true)) {
      await context.close();
    }
    return { status: "prepared", insertedText, postUrl: null };
  } catch (error) {
    const page = context.pages()[0];
    if (page) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    }
    await stopTracing(context, tracePath);

    const message = error instanceof Error ? error.message : "Unknown browser prepare error";
    if (ownsContext) {
      await context.close();
    }
    throw new BrowserPrepareError(message, screenshotPath, tracePath);
  }
}
