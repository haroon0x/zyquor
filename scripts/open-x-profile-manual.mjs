import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const profileDir = resolve(process.env.ZYQUOR_X_PROFILE_DIR ?? "profiles/personal-main");
mkdirSync(profileDir, { recursive: true });

const candidates = [
  process.env.CHROME_BIN,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser"
].filter(Boolean);

let launched = false;
for (const command of candidates) {
  const child = spawn(
    command,
    [
      `--user-data-dir=${profileDir}`,
      "--profile-directory=Default",
      "--no-first-run",
      "--no-default-browser-check",
      "https://x.com/login"
    ],
    {
      detached: true,
      stdio: "ignore"
    }
  );

  child.on("error", () => undefined);
  try {
    child.unref();
    launched = true;
    console.log(`Opened X login in normal browser with dedicated profile: ${profileDir}`);
    console.log("Log in there, then fully close that browser window before running Zyquor prepare/post.");
    break;
  } catch {
    // Try next candidate.
  }
}

if (!launched) {
  console.error("Could not find Chrome/Chromium. Set CHROME_BIN=/path/to/chrome and retry.");
  process.exitCode = 1;
}
