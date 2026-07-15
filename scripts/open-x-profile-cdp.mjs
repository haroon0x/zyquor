import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const port = process.env.ZYQUOR_BROWSER_CDP_PORT ?? "9222";
const profileName = process.env.ZYQUOR_X_PROFILE_DIR
  ? process.env.ZYQUOR_X_PROFILE_DIR.replace(/^profiles\//, "")
  : "personal-main";

const isWsl = existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") || process.env.WSL_DISTRO_NAME;

function wslToWinPath(wslPath) {
  return wslPath.replace("/mnt/c/", "C:\\").replace(/\//g, "\\");
}

function launchWindowsChrome() {
  const windowsUserDir = "C:\\Users\\asus\\zyquor-profiles\\" + profileName;
  const wslUserDir = "/mnt/c/Users/asus/zyquor-profiles/" + profileName;
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

  spawn("powershell.exe", ["-ExecutionPolicy", "Bypass", "-File", wslToWinPath(psPath)], {
    detached: true,
    stdio: "ignore"
  }).on("error", () => undefined).unref();

  console.log(`Opened Windows Chrome with CDP on http://127.0.0.1:${port}`);
  console.log(`Profile: ${wslUserDir}`);
  console.log("Keep this Chrome window open while Zyquor prepares/posts.");
}

function launchLinuxChrome() {
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

  for (const command of candidates) {
    try {
      const result = spawn(command, ["--version"], { stdio: "ignore" });
      result.on("error", () => undefined);
      const child = spawn(
        command,
        [
          `--user-data-dir=${profileDir}`,
          "--profile-directory=Default",
          `--remote-debugging-port=${port}`,
          "--remote-debugging-address=127.0.0.1",
          "--no-first-run",
          "--no-default-browser-check",
          "--no-sandbox",
          "--disable-crash-reporter",
          "--disable-dev-shm-usage",
          "--ozone-platform=x11",
          "https://x.com/home"
        ],
        {
          detached: true,
          env: { ...process.env, XDG_CONFIG_HOME: chromeConfigDir },
          stdio: "ignore"
        }
      );
      child.on("error", () => undefined);
      child.unref();
      console.log(`Opened Chrome with CDP on http://127.0.0.1:${port}`);
      console.log(`Profile: ${profileDir}`);
      console.log("Keep this Chrome window open while Zyquor prepares/posts.");
      process.exit(0);
    } catch {
      continue;
    }
  }

  console.error("Could not find Chrome/Chromium. Set CHROME_BIN=/path/to/chrome and retry.");
  process.exit(1);
}

if (isWsl) {
  launchWindowsChrome();
} else {
  launchLinuxChrome();
}
