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

let launchedChromePids: Map<number, number | null> = new Map();

interface PostingChromeState {
  profileDir: string;
  pid: number | null;
  cdpPort?: number;
  cdpUrl?: string;
}

function profileKeyForDesktp(profileDir: string): string {
  const normalized = resolve(profileDir).replaceAll("\\", "/");
  const marker = "/profiles/";
  const idx = normalized.lastIndexOf(marker);
  return idx === -1 ? normalized : normalized.slice(idx + marker.length);
}

function readAllPostingChromeStates(): PostingChromeState[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(dataPath("posting-chrome.json"), "utf8"));
    if (!parsed || typeof parsed !== "object") return [];
    const record = parsed as Record<string, unknown>;
    if (typeof record.profileDir === "string") {
      const legacy = record as { profileDir: string; pid?: unknown; cdpPort?: unknown; cdpUrl?: unknown };
      return [{ profileDir: resolve(legacy.profileDir), pid: typeof legacy.pid === "number" ? legacy.pid : null, cdpPort: typeof legacy.cdpPort === "number" ? legacy.cdpPort : undefined, cdpUrl: typeof legacy.cdpUrl === "string" ? legacy.cdpUrl : undefined }];
    }
    const out: PostingChromeState[] = [];
    for (const v of Object.values(record)) {
      if (!v || typeof v !== "object") continue;
      const rec = v as { profileDir?: unknown; pid?: unknown; cdpPort?: unknown; cdpUrl?: unknown };
      if (typeof rec.profileDir !== "string") continue;
      out.push({ profileDir: resolve(rec.profileDir), pid: typeof rec.pid === "number" ? rec.pid : null, cdpPort: typeof rec.cdpPort === "number" ? rec.cdpPort : undefined, cdpUrl: typeof rec.cdpUrl === "string" ? rec.cdpUrl : undefined });
    }
    return out;
  } catch { return []; }
}

function readPostingChromeState(): PostingChromeState | null {
  return readAllPostingChromeStates()[0] ?? null;
}

function readPostingChromeStateFor(profileDir: string): PostingChromeState | null {
  const key = profileKeyForDesktp(profileDir);
  return readAllPostingChromeStates().find((s) => profileKeyForDesktp(s.profileDir) === key) ?? null;
}

function writePostingChromeState(state: PostingChromeState): void {
  writePostingChromeStateFor(state);
}

function writePostingChromeStateFor(state: PostingChromeState): void {
  try {
    const all = readAllPostingChromeStates();
    const map: Record<string, PostingChromeState> = {};
    for (const s of all) map[profileKeyForDesktp(s.profileDir)] = s;
    map[profileKeyForDesktp(state.profileDir)] = { profileDir: resolve(state.profileDir), pid: state.pid, cdpPort: state.cdpPort, cdpUrl: state.cdpUrl };
    writeFileSync(dataPath("posting-chrome.json"), JSON.stringify(map));
  } catch {}
}

function clearPostingChromeState(): void {
  try { writeFileSync(dataPath("posting-chrome.json"), "{}"); } catch {}
}

function clearPostingChromeStateFor(profileDir: string): void {
  try {
    const all = readAllPostingChromeStates();
    const key = profileKeyForDesktp(profileDir);
    const map: Record<string, PostingChromeState> = {};
    for (const s of all) if (profileKeyForDesktp(s.profileDir) !== key) map[profileKeyForDesktp(s.profileDir)] = s;
    if (Object.keys(map).length === 0) writeFileSync(dataPath("posting-chrome.json"), "{}");
    else writeFileSync(dataPath("posting-chrome.json"), JSON.stringify(map));
  } catch { try { writeFileSync(dataPath("posting-chrome.json"), "{}"); } catch {} }
}

export function launchedPostingChromePid(): number | null {
  return launchedChromePids.values().next().value ?? null;
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
    launchedChromePids.delete(opts.cdpPort);
    const stale = readAllPostingChromeStates().find((s) => s.cdpPort === opts.cdpPort);
    if (stale) clearPostingChromeStateFor(stale.profileDir);
    return { closed: false, reason: "not-running" };
  }

  const pid = launchedChromePids.get(opts.cdpPort) ?? (await pidListeningOnPort(opts.cdpPort));
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
      launchedChromePids.delete(opts.cdpPort);
      const stale = readAllPostingChromeStates().find((s) => s.cdpPort === opts.cdpPort);
      if (stale) clearPostingChromeStateFor(stale.profileDir);
      else {
        const all = readAllPostingChromeStates();
        for (const s of all) if (s.cdpPort === opts.cdpPort) clearPostingChromeStateFor(s.profileDir);
      }
      return { closed: true };
    }
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_INTERVAL_MS));
  }
  return { closed: false, reason: "still-running" };
}

let launchQueues: Map<number, Promise<unknown>> = new Map();

export async function launchPostingChrome(opts: {
  profileDir: string;
  cdpPort: number;
}): Promise<{ launched: boolean; reason?: string }> {
  const key = opts.cdpPort;
  const prev = launchQueues.get(key) ?? Promise.resolve();
  const next = prev.then(() => runLaunchPostingChrome(opts), () => runLaunchPostingChrome(opts));
  launchQueues.set(key, next.catch(() => undefined));
  return next;
}

async function runLaunchPostingChrome(opts: {
  profileDir: string;
  cdpPort: number;
}): Promise<{ launched: boolean; reason?: string }> {
  const cdpUrl = `http://127.0.0.1:${opts.cdpPort}`;

  if (await isCdpUp(cdpUrl)) {
    const state = readPostingChromeStateFor(opts.profileDir);
    if (state && resolve(state.profileDir) === resolve(opts.profileDir)) {
      return { launched: false, reason: "already-running" };
    }
    const pidOnPort = launchedChromePids.get(opts.cdpPort) ?? (state?.pid ?? null);
    if (pidOnPort) {
      try { process.kill(pidOnPort, "SIGTERM"); } catch {}
      launchedChromePids.delete(opts.cdpPort);
    }
    const deadline = Date.now() + 3_000;
    while (await isCdpUp(cdpUrl)) {
      if (Date.now() > deadline) return { launched: false, reason: "cdp-port-busy" };
      await new Promise((resolveDelay) => setTimeout(resolveDelay, CDP_POLL_INTERVAL_MS));
    }
  }

  assertDedicatedProfileDir(opts.profileDir);

  const chromePath = findChrome();
  if (!chromePath) return { launched: false, reason: "chrome-not-found" };

  const args = [
    `--remote-debugging-port=${opts.cdpPort}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${opts.profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];

  const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
  launchedChromePids.set(opts.cdpPort, child.pid ?? null);
  writePostingChromeStateFor({ profileDir: opts.profileDir, pid: child.pid ?? null, cdpPort: opts.cdpPort, cdpUrl });

  const start = Date.now();
  while (Date.now() - start < CDP_POLL_TIMEOUT_MS) {
    if (await isCdpUp(cdpUrl)) return { launched: true };
    await new Promise((resolve) => setTimeout(resolve, CDP_POLL_INTERVAL_MS));
  }
  return { launched: false, reason: "cdp-timeout" };
}
