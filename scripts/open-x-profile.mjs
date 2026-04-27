import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const require = createRequire(import.meta.url);
const { chromium } = require("../packages/browser/node_modules/playwright");

const profileDir = resolve(process.env.ZYQUOR_X_PROFILE_DIR ?? "profiles/personal-main");
const chromeConfigDir = resolve(process.env.ZYQUOR_CHROME_CONFIG_DIR ?? "profiles/chrome-config");
const browserChannel = process.env.ZYQUOR_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined;

mkdirSync(profileDir, { recursive: true });
mkdirSync(chromeConfigDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  ...(browserChannel ? { channel: browserChannel } : {}),
  headless: false,
  args: [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox",
    "--disable-crash-reporter",
    "--disable-dev-shm-usage",
    "--ozone-platform=x11"
  ],
  env: { ...process.env, XDG_CONFIG_HOME: chromeConfigDir },
  viewport: { width: 1280, height: 900 }
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto("https://x.com/login", { waitUntil: "domcontentloaded" });

console.log(`Opened X login with profile: ${profileDir}`);
console.log("Log in to X in the opened browser. Leave it open until login completes, then press Ctrl+C here.");

await new Promise(() => undefined);
