import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const profileDir = resolve(process.env.ZYQUOR_X_PROFILE_DIR ?? "profiles/personal-main");
const port = process.env.ZYQUOR_BROWSER_CDP_PORT ?? "9222";
mkdirSync(profileDir, { recursive: true });

const candidates = [
  process.env.CHROME_BIN,
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser"
].filter(Boolean);

for (const command of candidates) {
  const child = spawn(
    command,
    [
      `--user-data-dir=${profileDir}`,
      "--profile-directory=Default",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "https://x.com/home"
    ],
    {
      detached: true,
      stdio: "ignore"
    }
  );

  child.on("error", () => undefined);
  child.unref();
  console.log(`Opened Chrome with CDP on http://127.0.0.1:${port}`);
  console.log(`Profile: ${profileDir}`);
  console.log("Keep this Chrome window open while Zyquor prepares/posts.");
  process.exit(0);
}

console.error("Could not find Chrome/Chromium. Set CHROME_BIN=/path/to/chrome and retry.");
process.exit(1);
