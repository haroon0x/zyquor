import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { resolve } from "node:path";
import { assertDedicatedProfileDir } from "@zyquor/accounts";
import { dataPath } from "@zyquor/core";

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

interface PostingChromeState {
  profileDir: string;
  pid: number | null;
}

// Mirrors packages/browser cdpLaunchStateFile so both launchers agree on
// which X account the running posting Chrome carries.
function readPostingChromeState(): PostingChromeState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(dataPath("posting-chrome.json"), "utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as { profileDir?: unknown }).profileDir === "string") {
      const record = parsed as { profileDir: string; pid?: unknown };
      return {
        profileDir: resolve(record.profileDir),
        pid: typeof record.pid === "number" ? record.pid : null
      };
    }
    return null;
  } catch {
    return null;
  }
}

function writePostingChromeState(state: PostingChromeState): void {
  try {
    writeFileSync(dataPath("posting-chrome.json"), JSON.stringify(state));
  } catch {
    /* best effort */
  }
}

// Mirrors packages/browser clearCdpLaunchState semantics: "{}" parses to a
// record without profileDir, so every reader sees null instead of a stale
// account attribution once no Chrome is running.
function clearPostingChromeState(): void {
  try {
    writeFileSync(dataPath("posting-chrome.json"), "{}");
  } catch {
    /* best effort */
  }
}

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
    // Nothing is running; drop any stale record so the API single-account
    // guard stops rejecting other accounts against a dead Chrome.
    clearPostingChromeState();
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
      clearPostingChromeState();
      return { closed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_INTERVAL_MS));
  }
  return { closed: false, reason: "still-running" };
}

// Serialize launches: concurrent activations interleave kill → poll-down →
// spawn → write-state and can leave posting-chrome.json recording a
// different profile than the Chrome actually serving the CDP port, which
// would let posts leave from the wrong account.
let launchQueue: Promise<unknown> = Promise.resolve();

export async function launchPostingChrome(opts: {
  profileDir: string;
  cdpPort: number;
}): Promise<{ launched: boolean; reason?: string }> {
  const next = launchQueue.then(
    () => runLaunchPostingChrome(opts),
    () => runLaunchPostingChrome(opts)
  );
  launchQueue = next.catch(() => undefined);
  return next;
}

async function runLaunchPostingChrome(opts: {
  profileDir: string;
  cdpPort: number;
}): Promise<{ launched: boolean; reason?: string }> {
  const cdpUrl = `http://127.0.0.1:${opts.cdpPort}`;

  if (await isCdpUp(cdpUrl)) {
    // Multi-account safety: the running posting Chrome is bound to one X
    // login. If it was launched for a different profile, close it and
    // relaunch with the requested profile so posts never leave from the
    // wrong handle.
    const state = readPostingChromeState();
    if (state && resolve(state.profileDir) === resolve(opts.profileDir)) {
      return { launched: false, reason: "already-running" };
    }
    if (state?.pid) {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    if (launchedChromePid) {
      try {
        process.kill(launchedChromePid, "SIGTERM");
      } catch {
        /* already gone */
      }
      launchedChromePid = null;
    }
    const deadline = Date.now() + 3_000;
    while (await isCdpUp(cdpUrl)) {
      if (Date.now() > deadline) {
        return { launched: false, reason: "cdp-port-busy" };
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, CDP_POLL_INTERVAL_MS));
    }
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
  writePostingChromeState({ profileDir: opts.profileDir, pid: launchedChromePid });

  const start = Date.now();
  while (Date.now() - start < CDP_POLL_TIMEOUT_MS) {
    if (await isCdpUp(cdpUrl)) {
      return { launched: true };
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_INTERVAL_MS));
  }

  return { launched: false, reason: "cdp-timeout" };
}
