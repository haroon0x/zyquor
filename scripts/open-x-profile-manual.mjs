import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const profileDir = resolve(process.env.ZYQUOR_X_PROFILE_DIR ?? "profiles/personal-main");
const chromeConfigDir = resolve(process.env.ZYQUOR_CHROME_CONFIG_DIR ?? "profiles/chrome-config");
mkdirSync(profileDir, { recursive: true });
mkdirSync(chromeConfigDir, { recursive: true });

const candidates = [
  process.env.CHROME_BIN,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser"
].filter(Boolean);

function canLaunch(command) {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });
  return !result.error;
}

let launched = false;
for (const command of candidates) {
  if (!canLaunch(command)) {
    continue;
  }

  const child = spawn(
    command,
    [
      `--user-data-dir=${profileDir}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-crash-reporter",
      "--disable-dev-shm-usage",
      "--ozone-platform=x11",
      "https://x.com/login"
    ],
    {
      detached: true,
      env: { ...process.env, XDG_CONFIG_HOME: chromeConfigDir },
      stdio: "ignore"
    }
  );

  child.unref();
  launched = true;
  console.log(`Opened X login in normal browser with dedicated profile: ${profileDir}`);
  console.log("Log in there, then fully close that browser window before running Zyquor prepare/post.");
  break;
}

if (!launched) {
  console.error("Could not find Chrome/Chromium. Set CHROME_BIN=/path/to/chrome and retry.");
  process.exitCode = 1;
}
