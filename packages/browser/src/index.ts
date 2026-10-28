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

let activeCdpPids: Map<string, number | null> = new Map();
let activeCdpProfileDirs: Map<string, string> = new Map();

interface CdpLaunchState {
  profileDir: string;
  pid: number | null;
  cdpUrl?: string;
  cdpPort?: number;
}

function normalizeStoredProfileDir(stored: string): string {
  const resolved = resolveProfileDir(stored);
  if (!/[A-Za-z]:[\\/]/.test(resolved)) return resolved;
  const normalized = stored.replaceAll("\\", "/");
  const marker = "/profiles/";
  const index = normalized.lastIndexOf(marker);
  if (index === -1) return resolved;
  return dataPath("profiles", normalized.slice(index + marker.length));
}

function profileKey(profileDir: string): string {
  const normalized = normalizeStoredProfileDir(profileDir).replaceAll("\\", "/");
  const marker = "/profiles/";
  const index = normalized.lastIndexOf(marker);
  return index === -1 ? normalized : normalized.slice(index + marker.length);
}

export function cdpLaunchStateFile(): string {
  return dataPath("posting-chrome.json");
}

export function readAllCdpLaunchStates(): CdpLaunchState[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(cdpLaunchStateFile(), "utf8"));
    if (!parsed || typeof parsed !== "object") return [];
    const record = parsed as Record<string, unknown>;
    if (typeof record.profileDir === "string") {
      const legacy = record as { profileDir: string; pid?: unknown; cdpUrl?: unknown; cdpPort?: unknown };
      return [{
        profileDir: normalizeStoredProfileDir(legacy.profileDir),
        pid: typeof legacy.pid === "number" ? legacy.pid : null,
        cdpUrl: typeof legacy.cdpUrl === "string" ? legacy.cdpUrl : undefined,
        cdpPort: typeof legacy.cdpPort === "number" ? legacy.cdpPort : undefined,
      }];
    }
    const states: CdpLaunchState[] = [];
    for (const [key, value] of Object.entries(record)) {
      if (!value || typeof value !== "object") continue;
      const v = value as { profileDir?: unknown; pid?: unknown; cdpUrl?: unknown; cdpPort?: unknown };
      if (typeof v.profileDir !== "string") continue;
      states.push({
        profileDir: normalizeStoredProfileDir(v.profileDir),
        pid: typeof v.pid === "number" ? v.pid : null,
        cdpUrl: typeof v.cdpUrl === "string" ? v.cdpUrl : undefined,
        cdpPort: typeof v.cdpPort === "number" ? v.cdpPort : undefined,
      });
    }
    return states;
  } catch {
    return [];
  }
}

export function readCdpLaunchState(): CdpLaunchState | null {
  const all = readAllCdpLaunchStates();
  return all[0] ?? null;
}

export function readCdpLaunchStateFor(profileDir: string): CdpLaunchState | null {
  const key = profileKey(profileDir);
  return readAllCdpLaunchStates().find((s) => profileKey(s.profileDir) === key) ?? null;
}

export function writeCdpLaunchState(state: CdpLaunchState): void {
  writeCdpLaunchStateFor(state);
}

export function writeCdpLaunchStateFor(state: CdpLaunchState): void {
  try {
    mkdirSync(join(cdpLaunchStateFile(), ".."), { recursive: true });
    const all = readAllCdpLaunchStates();
    const map: Record<string, CdpLaunchState> = {};
    for (const s of all) map[profileKey(s.profileDir)] = s;
    const key = profileKey(state.profileDir);
    map[key] = {
      profileDir: normalizeStoredProfileDir(state.profileDir),
      pid: state.pid,
      cdpUrl: state.cdpUrl,
      cdpPort: state.cdpPort,
    };
    writeFileSync(cdpLaunchStateFile(), JSON.stringify(map));
  } catch {
  }
}

export function clearCdpLaunchState(): void {
  try {
    writeFileSync(cdpLaunchStateFile(), "{}");
  } catch {
  }
}

export function clearCdpLaunchStateFor(profileDir: string): void {
  try {
    const all = readAllCdpLaunchStates();
    const key = profileKey(profileDir);
    const map: Record<string, CdpLaunchState> = {};
    for (const s of all) {
      const k = profileKey(s.profileDir);
      if (k !== key) map[k] = s;
    }
    if (Object.keys(map).length === 0) writeFileSync(cdpLaunchStateFile(), "{}");
    else writeFileSync(cdpLaunchStateFile(), JSON.stringify(map));
  } catch {
    try { writeFileSync(cdpLaunchStateFile(), "{}"); } catch {}
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
  // Headless keeps the posting Chrome off the owner's screen. The profile and
  // CDP port are unchanged; only the window is gone.
  const headless = process.env.ZYQUOR_BROWSER_HEADLESS === "1";
  const wantedProfileDir = resolveProfileDir(profileDir);
  const port = Number(new URL(cdpUrl).port);
  const browser = await chromium.connectOverCDP(cdpUrl).catch(() => null);
  if (browser) {
    activeCdpProfileDirs.set(cdpUrl, wantedProfileDir);
    writeCdpLaunchStateFor({ profileDir: wantedProfileDir, pid: activeCdpPids.get(cdpUrl) ?? readCdpLaunchStateFor(wantedProfileDir)?.pid ?? null, cdpUrl, cdpPort: port });
    return true;
  }

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
      ...(headless ? ["  '--headless=new',"] : []),
      "  '--no-first-run',",
      "  '--no-default-browser-check',",
      "  '--no-sandbox',",
      "  '--disable-dev-shm-usage',",
      "  'https://x.com/home'",
      ")",
      "Start-Process -FilePath $chrome -ArgumentList $chromeArgs"
    ].join("\n");

    const psPath = `/tmp/launch-chrome-cdp-${port}.ps1`;
    writeFileSync(psPath, psScript);

    const child = spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", psPath.replace("/mnt/c/", "C:\\").replace(/\//g, "\\")], {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", () => undefined);
    child.unref();
    activeCdpPids.set(cdpUrl, child.pid ?? null);
    activeCdpProfileDirs.set(cdpUrl, wantedProfileDir);
    writeCdpLaunchStateFor({ profileDir: wantedProfileDir, pid: child.pid ?? null, cdpUrl, cdpPort: port });
  } else {
    const chromeBin = findChromeExecutable();
    const chromeConfigDir = process.env.ZYQUOR_CHROME_CONFIG_DIR ? resolve(process.env.ZYQUOR_CHROME_CONFIG_DIR) : profilesPath("chrome-config");
    mkdirSync(chromeConfigDir, { recursive: true });
    const child = spawn(chromeBin, [
      `--user-data-dir=${resolveProfileDir(profileDir)}`,
      "--profile-directory=Default",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      ...(headless ? ["--headless=new"] : []),
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
    activeCdpPids.set(cdpUrl, child.pid ?? null);
    activeCdpProfileDirs.set(cdpUrl, wantedProfileDir);
    writeCdpLaunchStateFor({ profileDir: wantedProfileDir, pid: child.pid ?? null, cdpUrl, cdpPort: port });

    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (spawnFailed) {
        console.error(`[browser] failed to launch Chrome via ${chromeBin}; cannot post`);
        return false;
      }
      await new Promise((r) => setTimeout(r, 1_000));
      const connected = await chromium.connectOverCDP(cdpUrl).catch(() => null);
      if (connected) {
        return true;
      }
    }
    return false;
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
  }

  const pid = activeCdpPids.get(cdpUrl);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
    }
    activeCdpPids.delete(cdpUrl);
  }
  const profileDir = activeCdpProfileDirs.get(cdpUrl);
  if (profileDir) {
    activeCdpProfileDirs.delete(cdpUrl);
    clearCdpLaunchStateFor(profileDir);
  } else {
    try {
      const port = Number(new URL(cdpUrl).port);
      const all = readAllCdpLaunchStates();
      const match = all.find((s) => s.cdpPort === port || s.cdpUrl === cdpUrl);
      if (match) clearCdpLaunchStateFor(match.profileDir);
    } catch {}
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

export interface FetchXMentionsInput {
  profileDir: string;
  maxTweets?: number;
  scrolls?: number;
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  actionDelayMs?: number;
  artifactsDir?: string;
  /** Test hook: override the mentions tab URL. Defaults to https://x.com/notifications/mentions. */
  mentionsUrl?: string;
}

export interface FetchXMentionsResult {
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
  // When > 0, also collect up to that many replies already posted under the
  // target (same page load, no extra scrolls unless the page is short).
  maxReplies?: number;
}

export interface FetchTweetResult {
  tweet: XFeedTweet;
  url: string;
  // Top replies under the target tweet (bounded by maxReplies, default none).
  replies?: XFeedTweet[];
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
  const sessionHandle = await readLoggedInHandle(page).catch(() => null);
  if (sessionHandle) {
    throw new Error(
      `X did not render the authenticated shell at ${page.url()} even though the session is valid (@${sessionHandle}). ` +
        "This is a rendered-page failure, not a logout: relaunch the browser profile and retry, do not clear cookies."
    );
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
    // X occasionally serves a half-rendered status page where the reply button
    // never mounts. Reload once and wait again before giving up: the click has
    // not happened yet, so re-waiting cannot duplicate a post; it only avoids
    // recording slow renders as failed jobs.
    try {
      await replyButton.click({ timeout: 15_000 });
    } catch (error) {
      await page.reload({ waitUntil: "commit", timeout: 45_000 }).catch(() => undefined);
      await page.waitForTimeout(2_000);
      await replyButton.click({ timeout: 20_000 });
    }
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

// Chrome raises beforeunload dialogs when a page navigates or closes with
// unsent composer text. Playwright's own auto-dismiss races with Chrome and
// throws `No dialog is showing` from an internal promise, which used to kill
// the API process. Registering a listener on every page first keeps that path
// from running and makes the dismissal best-effort.
function dismissDialogsOn(page: Page) {
  page.on("dialog", (dialog) => {
    void dialog.dismiss().catch(() => undefined);
  });
}

function installDialogDismissers(context: BrowserContext) {
  for (const page of context.pages()) {
    dismissDialogsOn(page);
  }
  context.on("page", dismissDialogsOn);
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

async function pageForMentions(context: BrowserContext, input: FetchXMentionsInput) {
  const page = await pageForSessionCheck(context, input);
  const targetUrl = input.mentionsUrl ?? "https://x.com/notifications/mentions";
  const isMentionsPage = (candidate: string) => {
    try {
      return input.mentionsUrl ? candidate === targetUrl : new URL(candidate).pathname === "/notifications/mentions";
    } catch {
      return false;
    }
  };
  if (isMentionsPage(page.url())) {
    return page;
  }
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch((error) => {
    const message = error instanceof Error ? error.message : "Unknown X mentions navigation error";
    if (!message.includes("Timeout") || !isMentionsPage(page.url())) {
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

async function activateBrowserWindow(page: Page) {
  // Chrome stops producing animation frames for a minimized or fully occluded
  // window. Playwright's pointer actionability (stability, scroll into view,
  // hit target) is measured across frames, so every click would wait out its
  // timeout with no progress while the element still resolved as visible.
  // Activating the page also restores a minimized window, which restores
  // frames for the rest of the run.
  await page.bringToFront().catch(() => undefined);
}

async function focusEditor(page: Page, editor: Locator) {
  // Focusing the contenteditable does not need a pointer event, and it is the
  // only reliable way to start typing when the window cannot produce frames.
  await activateBrowserWindow(page);
  return editor
    .evaluate((element) => {
      const target = element as HTMLElement;
      target.focus();
      const active = document.activeElement;
      return active === target || (active !== null && target.contains(active));
    })
    .catch(() => false);
}

async function typeIntoEditor(page: Page, editor: Locator, text: string, typingDelayMs: number) {
  const focused = await focusEditor(page, editor);
  if (!focused) {
    // Shells that ignore programmatic focus until the first pointer event:
    // force skips the actionability waits that stall on a throttled window.
    await editor.click({ timeout: 15_000, force: true });
  }
  await editor.fill("", { timeout: 15_000 }).catch(async () => {
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
  });
  await page.waitForTimeout(250);
  await editor.fill(text, { timeout: 15_000 }).catch(async () => {
    await focusEditor(page, editor);
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

async function resolvePostedPermalink(
  page: Page,
  options: { handle?: string | null; text?: string | null } = {}
) {
  const wantedHandle = options.handle?.replace(/^@/, "").replace(/^\/+/, "").toLowerCase() ?? null;
  const wantedText = options.text?.replace(/\s+/g, " ").trim().slice(0, 60) || null;

  const permalinkForOwner = (href: string | null | undefined) => {
    const permalink = extractStatusPermalink(href ?? "");
    if (!permalink) return null;
    if (!wantedHandle) return permalink;
    return permalink.toLowerCase().includes(`/${wantedHandle}/status/`) ? permalink : null;
  };

  const fromArticles = async () => {
    const rows = await page.locator("article[data-testid='tweet']").evaluateAll((articles) =>
      articles.map((article) => ({
        link: article.querySelector("a[href*='/status/']")?.getAttribute("href") ?? "",
        author: article.querySelector("[data-testid='User-Name'] a[href^='/']")?.getAttribute("href") ?? "",
        text: (article.querySelector("[data-testid='tweetText']")?.textContent ?? "").replace(/\s+/g, " ").trim()
      }))
    );
    for (const row of rows) {
      const author = row.author.replace(/^\/+/, "").replace(/^@/, "").toLowerCase();
      if (wantedHandle && author !== wantedHandle) continue;
      if (wantedText && !row.text.includes(wantedText.slice(0, 40))) continue;
      const permalink = extractStatusPermalink(row.link);
      if (permalink) return permalink;
    }
    return null;
  };

  // A reply usually posts back onto the parent thread, so the page URL is the
  // parent, not the new status. Prefer a status link owned by this account (and
  // matching the submitted text when known) over whatever link is first in the
  // DOM, which used to record the parent tweet as the posted permalink.
  const fromLocation = permalinkForOwner(page.url());
  if (fromLocation) return fromLocation;

  const fromDom = await fromArticles();
  if (fromDom) return fromDom;

  const startMs = Date.now();
  while (Date.now() - startMs < 5_000) {
    await page.waitForTimeout(500);
    const extracted = permalinkForOwner(page.url());
    if (extracted) return extracted;
    const fromRetry = await fromArticles();
    if (fromRetry) return fromRetry;
  }
  if (wantedHandle) return null;
  const links = await page.locator('a[href*="/status/"]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("href") ?? "").filter(Boolean)
  );
  for (const link of links) {
    const permalink = extractStatusPermalink(link);
    if (permalink) return permalink;
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
    const wantedProfileDir = resolveProfileDir(input.profileDir);
    if (input.cdpUrl) activeCdpProfileDirs.set(input.cdpUrl, wantedProfileDir);
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
      `Chrome CDP is unavailable at ${input.cdpUrl}. Start ./zyquor or pnpm profile:x:cdp and keep that Chrome running. Refusing to launch a fallback browser against the persistent X profile.`
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

  installDialogDismissers(context);

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

// Collects replies already posted under a status page's target tweet. The
// target article is first in the DOM; every later run-of-text article with a
// distinct status id below it is a reply. Bounded and best-effort: misses are
// fine, junk is filtered.
async function extractStatusReplies(
  page: Page,
  targetTweetId: string,
  maxReplies: number,
  scrolls: number,
  actionDelayMs: number
): Promise<XFeedTweet[]> {
  const collectReplies = () =>
    page
      .locator('article[data-testid="tweet"]')
      .evaluateAll((articles, tid) => {
        const collected: Array<{ statusLink: string; text: string; userName: string; socialContext: string; headerText: string; publishedAt: string | null }> = [];
        for (const article of articles) {
          const statusLinks = Array.from(article.querySelectorAll('a[href*="/status/"]'))
            .map((anchor) => anchor.getAttribute("href") ?? "")
            .filter(Boolean);
          const ownLink = statusLinks.find((href) => {
            const m = /\/[A-Za-z0-9_]+\/status\/(\d+)\/?$/.exec(href);
            return m?.[1] !== undefined && m[1] !== tid;
          }) ?? null;
          const text = article.querySelector('[data-testid="tweetText"]')?.textContent?.trim() ?? "";
          const userName = article.querySelector('[data-testid="User-Name"]')?.textContent ?? "";
          const socialContext = article.querySelector('[data-testid="socialContext"]')?.textContent ?? "";
          const headerText = article.querySelector("header")?.textContent ?? "";
          const publishedAt = article.querySelector("time[datetime]")?.getAttribute("datetime") ?? null;
          if (ownLink && text) {
            collected.push({ statusLink: ownLink, text, userName, socialContext, headerText, publishedAt });
          }
        }
        return collected;
      }, targetTweetId)
      .catch(() => [] as Array<{ statusLink: string; text: string; userName: string; socialContext: string; headerText: string; publishedAt: string | null }>);

  for (let index = 0; index <= scrolls; index += 1) {
    const replies = await collectReplies();
    if (replies.length >= maxReplies) break;
    if (index === scrolls) break;
    await page.mouse.wheel(0, 2_400).catch(() => undefined);
    await page.evaluate(() => window.scrollBy(0, 2_400)).catch(() => undefined);
    await page.waitForTimeout(actionDelayMs);
  }

  const seen = new Set<string>();
  const replies: XFeedTweet[] = [];
  for (const item of await collectReplies()) {
    const permalink = extractStatusPermalink(item.statusLink);
    const handleMatch = permalink ? /^\/([A-Za-z0-9_]{1,15})\/status\//.exec(new URL(permalink).pathname) : null;
    const replyId = /\/(\d+)\/?$/.exec(item.statusLink)?.[1];
    if (!permalink || !handleMatch || !replyId || replyId === targetTweetId) continue;
    if (seen.has(replyId)) continue;
    seen.add(replyId);
    const handle = handleMatch[1]!;
    replies.push({
      id: replyId,
      authorHandle: handle,
      authorName: cleanAuthorName(item.userName, handle),
      text: item.text,
      url: permalink,
      publishedAt: item.publishedAt,
      isPromoted: /\b(promoted|sponsored|advertisement|advertiser)\b/i.test(`${item.socialContext} ${item.headerText}`),
      isRetweet: /reposted/i.test(`${item.socialContext} ${item.headerText}`),
      hasLink: false
    });
    if (replies.length >= maxReplies) break;
  }
  return replies;
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

export async function fetchXMentions(input: FetchXMentionsInput): Promise<FetchXMentionsResult> {
  const maxTweets = input.maxTweets ?? 30;
  const scrolls = input.scrolls ?? 4;
  const actionDelayMs = input.actionDelayMs ?? 1_500;
  const artifactsDir = input.artifactsDir ?? dataPath("data", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifactId = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = join(artifactsDir, `mentions-${artifactId}.png`);

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
    const page = await pageForMentions(context, input);
    await assertNotLoginPage(page);

    // Mentions are legitimately allowed to be empty (nobody mentioned the
    // account), so unlike the home feed there is no minimum count. Scroll a
    // bounded number of times to pull in older items, dedupe by status URL.
    const collected = new Map<string, XFeedTweet>();
    const collectVisible = async () => {
      for (const tweet of await extractFeedTweets(page, maxTweets)) {
        if (!collected.has(tweet.url)) {
          collected.set(tweet.url, tweet);
        }
      }
    };
    await page.waitForTimeout(actionDelayMs);
    await collectVisible();
    for (let index = 0; index < scrolls && collected.size < maxTweets; index += 1) {
      await page.mouse.wheel(0, 2_400);
      await page.evaluate(() => window.scrollBy(0, 2_400)).catch(() => undefined);
      await page.waitForTimeout(actionDelayMs);
      await collectVisible();
    }
    const tweets = Array.from(collected.values()).slice(0, maxTweets);
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
    const message = error instanceof Error ? error.message : "Unknown X mentions fetch error";
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
    const maxReplies = input.maxReplies ?? 0;
    let replies: XFeedTweet[] | undefined;
    if (maxReplies > 0) {
      replies = await extractStatusReplies(page, tweet.id, maxReplies, 2, actionDelayMs);
    }
    await page.close().catch(() => undefined);
    page = null;
    if (ownsContext) {
      await context.close();
    }
    return { tweet, url: input.url, ...(replies ? { replies } : {}) };
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

export interface DeletePostInput {
  profileDir: string;
  postUrl: string;
  browserChannel?: string | null;
  cdpUrl?: string;
  headless?: boolean;
  actionDelayMs?: number;
  artifactsDir?: string;
}

export interface DeletePostResult {
  status: "deleted";
  postUrl: string;
  /** True when the tweet was already gone before any click (idempotent). */
  alreadyDeleted: boolean;
}

export class BrowserDeleteError extends BrowserPrepareError {
  constructor(message: string, screenshotPath: string | null = null) {
    super(message, screenshotPath);
    this.name = "BrowserDeleteError";
  }
}

function tweetIdFromStatusUrl(statusUrl: string): string | null {
  try {
    const match = /\/status\/(\d+)\/?$/.exec(new URL(statusUrl).pathname);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function pageShowsNonexistentTweet(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const body = document.body?.innerText ?? "";
      return /this page doesn.t exist/i.test(body) && /try searching for something else/i.test(body);
    })
    .catch(() => false);
}

export async function deletePost(input: DeletePostInput): Promise<DeletePostResult> {
  const permalink = extractStatusPermalink(input.postUrl);
  if (!permalink) {
    throw new BrowserDeleteError(`Not a valid X status URL: ${input.postUrl}`);
  }
  const tweetId = tweetIdFromStatusUrl(permalink);
  if (!tweetId) {
    throw new BrowserDeleteError(`Could not read the tweet id from ${permalink}`);
  }

  const actionDelayMs = input.actionDelayMs ?? 1_800;
  const artifactsDir = input.artifactsDir ?? dataPath("data", "artifacts");
  mkdirSync(artifactsDir, { recursive: true });
  const artifactId = new Date().toISOString().replace(/[:.]/g, "-");
  const screenshotPath = join(artifactsDir, `delete-${artifactId}.png`);

  const { context, ownsContext } = await openPersistentContext({
    ...input,
    autoLaunchCdp: true
  });

  let page: Page | null = null;
  try {
    context.setDefaultTimeout(30_000);
    page = await context.newPage();
    await page.goto(permalink, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);

    const articleForTweet = () =>
      page!.locator('article[data-testid="tweet"]', {
        has: page!.locator(`a[href*="/status/${tweetId}"]`)
      }).first();

    let resolved = await articleForTweet().isVisible({ timeout: 10_000 }).catch(() => false);
    if (!resolved && (await pageShowsNonexistentTweet(page))) {
      await page.close().catch(() => undefined);
      page = null;
      if (ownsContext) await context.close().catch(() => undefined);
      return { status: "deleted", postUrl: permalink, alreadyDeleted: true };
    }
    if (!resolved) {
      for (let attempt = 0; attempt < 2 && !resolved; attempt += 1) {
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
        resolved = await articleForTweet().isVisible({ timeout: 10_000 }).catch(() => false);
        if (!resolved && (await pageShowsNonexistentTweet(page))) {
          await page.close().catch(() => undefined);
          page = null;
          if (ownsContext) await context.close().catch(() => undefined);
          return { status: "deleted", postUrl: permalink, alreadyDeleted: true };
        }
      }
    }
    if (!resolved) {
      throw new Error(`Own tweet article ${tweetId} did not render at ${permalink}`);
    }

    await assertNotLoginPage(page);
    await page.waitForTimeout(actionDelayMs);

    const caret = articleForTweet().locator('[data-testid="caret"]').first();
    await caret.click({ timeout: 15_000 });
    const deleteItem = page.getByRole("menuitem", { name: /^delete$/i }).first();
    const menuVisible = await deleteItem.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!menuVisible) {
      const fallbackItem = page
        .locator('[data-testid="Dropdown"] [role="menuitem"]', { hasText: /^Delete$/ })
        .first();
      if (!(await fallbackItem.isVisible({ timeout: 5_000 }).catch(() => false))) {
        throw new Error("Delete menu item did not appear for the tweet");
      }
      await fallbackItem.click({ timeout: 10_000 });
    } else {
      await deleteItem.click({ timeout: 10_000 });
    }

    const confirmButton = page.locator('[data-testid="confirmationSheetConfirm"]').first();
    const confirmVisible = await confirmButton.isVisible({ timeout: 10_000 }).catch(() => false);
    if (!confirmVisible) {
      const fallbackConfirm = page.getByRole("button", { name: /^delete$/i }).last();
      if (!(await fallbackConfirm.isVisible({ timeout: 5_000 }).catch(() => false))) {
        throw new Error("Delete confirmation dialog did not appear");
      }
      await fallbackConfirm.click({ timeout: 10_000 });
    } else {
      await confirmButton.click({ timeout: 10_000 });
    }

    const startMs = Date.now();
    let verified = false;
    while (Date.now() - startMs < 15_000) {
      const toastVisible = await page
        .getByText("Your post was deleted")
        .first()
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      const articleGone = !(await articleForTweet().isVisible({ timeout: 1_000 }).catch(() => false));
      if (toastVisible || articleGone || (await pageShowsNonexistentTweet(page))) {
        verified = true;
        break;
      }
      await page.waitForTimeout(1_000);
    }
    if (!verified) {
      throw new Error("Delete click did not visibly remove the tweet");
    }

    await page.close().catch(() => undefined);
    page = null;
    if (ownsContext) {
      await context.close().catch(() => undefined);
    }
    return { status: "deleted", postUrl: permalink, alreadyDeleted: false };
  } catch (error) {
    if (page) {
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      await page.close().catch(() => undefined);
    }
    if (ownsContext) {
      await context.close().catch(() => undefined);
    }
    if (error instanceof BrowserDeleteError) throw error;
    const message = error instanceof Error ? error.message : "Unknown browser delete error";
    throw new BrowserDeleteError(message, screenshotPath);
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
    await activateBrowserWindow(page);
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
      const postedBy = await readLoggedInHandle(page).catch(() => null);
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
        postUrl = await resolvePostedPermalink(page, { handle: postedBy, text });
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
        postUrl = await resolvePostedPermalink(page, { handle: postedBy, text });
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
