import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { platform } from "node:os";
import { assertDedicatedProfileDir } from "@zyquor/accounts";

const CDP_POLL_INTERVAL_MS = 500;
const CDP_POLL_TIMEOUT_MS = 15_000;

export function findChrome(): string | null {
  const envPath = process.env.ZYQUOR_CHROME_PATH;
  if (envPath) {
    return existsSync(envPath) ? envPath : null;
  }

  if (platform() === "win32") {
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env.LocalAppData ?? "C:\\Users\\" + (process.env.USERNAME ?? "user") + "\\AppData\\Local";

    const candidates = [
      programFiles + "\\Google\\Chrome\\Application\\chrome.exe",
      programFilesX86 + "\\Google\\Chrome\\Application\\chrome.exe",
      localAppData + "\\Google\\Chrome\\Application\\chrome.exe",
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    return null;
  }

  // linux
  const chromeBin = process.env.CHROME_BIN;
  if (chromeBin && existsSync(chromeBin)) return chromeBin;

  const linuxCandidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/local/bin/google-chrome-stable",
    "/usr/local/bin/google-chrome",
    "/snap/bin/google-chrome-stable",
    "/snap/bin/google-chrome-enterprise",
  ];

  for (const candidate of linuxCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function isCdpUp(cdpUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);

  try {
    const response = await fetch(cdpUrl + "/json/version", {
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

let launchedChromePid: number | null = null;

export function launchedPostingChromePid(): number | null {
  return launchedChromePid;
}

function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", () => done(""));
    child.on("close", () => done(output));
  });
}

export async function pidListeningOnPort(port: number): Promise<number | null> {
  if (platform() === "win32") {
    const output = await runCommand("powershell.exe", [
      "-NoProfile",
      "-Command",
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`
    ]);
    const pid = Number(output.trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }

  const output = await runCommand("lsof", ["-t", "-i", `:${port}`, "-sTCP:LISTEN"]);
  const pid = Number(output.split("\n")[0]?.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function closePostingChrome(opts: { cdpPort: number }): Promise<{ closed: boolean; reason?: string }> {
  const cdpUrl = `http://127.0.0.1:${opts.cdpPort}`;
  if (!(await isCdpUp(cdpUrl))) {
    launchedChromePid = null;
    return { closed: false, reason: "not-running" };
  }

  const pid = launchedChromePid ?? (await pidListeningOnPort(opts.cdpPort));
  if (pid === null) {
    return { closed: false, reason: "pid-not-found" };
  }
  if (platform() === "win32") {
    await new Promise<void>((done) => {
      const kill = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      kill.on("error", () => done());
      kill.on("exit", () => done());
    });
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        return { closed: false, reason: "kill-failed" };
      }
    }
  }

  const start = Date.now();
  while (Date.now() - start < CDP_POLL_TIMEOUT_MS) {
    if (!(await isCdpUp(cdpUrl))) {
      launchedChromePid = null;
      return { closed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_INTERVAL_MS));
  }
  return { closed: false, reason: "still-running" };
}

export async function launchPostingChrome(opts: {
  profileDir: string;
  cdpPort: number;
}): Promise<{ launched: boolean; reason?: string }> {
  const cdpUrl = `http://127.0.0.1:${opts.cdpPort}`;

  if (await isCdpUp(cdpUrl)) {
    return { launched: false, reason: "already-running" };
  }

  assertDedicatedProfileDir(opts.profileDir);

  const chromePath = findChrome();
  if (!chromePath) {
    return { launched: false, reason: "chrome-not-found" };
  }

  const args = [
    `--remote-debugging-port=${opts.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  const child = spawn(chromePath, args, {
    detached: true,
    stdio: "ignore",
  });

  child.on("error", () => undefined);
  child.unref();
  launchedChromePid = child.pid ?? null;

  const start = Date.now();
  while (Date.now() - start < CDP_POLL_TIMEOUT_MS) {
    if (await isCdpUp(cdpUrl)) {
      return { launched: true };
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_INTERVAL_MS));
  }

  return { launched: false, reason: "cdp-timeout" };
}
