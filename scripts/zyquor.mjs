#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "./load-env.mjs";

loadDotEnv();

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] ?? "start";
const apiPort = process.env.ZYQUOR_API_PORT_OVERRIDE ?? "3001";
const apiUrl = process.env.ZYQUOR_API_URL_OVERRIDE ?? `http://127.0.0.1:${apiPort}`;
const webUrl = "http://127.0.0.1:5173/";
const cdpUrl = process.env.ZYQUOR_BROWSER_CDP_URL ?? "http://127.0.0.1:9222";

function run(commandName, commandArgs, options = {}) {
  const result = spawnSync(commandName, commandArgs, {
    cwd: rootDir,
    env: { ...process.env, ...options.env },
    stdio: options.stdio ?? "inherit"
  });
  return result.status ?? 1;
}

function spawnService(name, commandName, commandArgs, env = {}) {
  const child = spawn(commandName, commandArgs, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal || (code !== null && code !== 0)) {
      console.error(`[${name}] exited: ${signal ?? code}`);
    }
  });

  return child;
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function httpOk(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitFor(name, url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await httpOk(url)) {
      return true;
    }
    await sleep(1_000);
  }

  console.error(`${name} did not become ready: ${url}`);
  return false;
}

async function printStatus() {
  const health = await fetch(`${apiUrl}/health`).then((response) => response.json()).catch((error) => ({ error: String(error) }));
  const session = await fetch(`${apiUrl}/browser/x-session?accountId=account_personal`)
    .then((response) => response.json())
    .catch((error) => ({ error: String(error) }));

  console.log("");
  console.log("Zyquor running");
  console.log(`Web: ${webUrl}`);
  console.log(`API: ${apiUrl}`);
  console.log(`X: ${session.loggedIn ? "logged in" : "not logged in"}`);
  console.log(`Generation: ${health.generation?.provider ?? "unknown"} ${health.generation?.model ?? ""}`.trim());
  console.log("");
  console.log("Use web UI for normal work. Keep this terminal open.");
  console.log("Post manually from UI, or explicit CLI:");
  console.log("  zyquor post <jobId>");
  console.log("");
}

async function start() {
  mkdirSync(resolve(rootDir, "profiles/personal-main"), { recursive: true });

  if (!(await httpOk(`${cdpUrl}/json/version`))) {
    const code = run("node", ["scripts/open-x-profile-cdp.mjs"], { stdio: "inherit" });
    if (code !== 0) {
      process.exit(code);
    }
    await sleep(3_000);
  }

  const commonEnv = {
    ZYQUOR_API_PORT: apiPort,
    ZYQUOR_API_URL: apiUrl,
    ZYQUOR_BROWSER_CDP_URL: cdpUrl,
    ZYQUOR_ENABLE_BROWSER_PREPARE: process.env.ZYQUOR_ENABLE_BROWSER_PREPARE ?? "1",
    ZYQUOR_ENABLE_BROWSER_POST: process.env.ZYQUOR_ENABLE_BROWSER_POST ?? "1"
  };

  const apiAlreadyRunning = await httpOk(`${apiUrl}/health`);
  const api = apiAlreadyRunning ? null : spawnService("api", "pnpm", ["--filter", "@zyquor/api", "dev"], commonEnv);
  const apiReady = apiAlreadyRunning || (await waitFor("API", `${apiUrl}/health`));
  if (!apiReady) {
    api?.kill("SIGINT");
    process.exit(1);
  }

  const webAlreadyRunning = await httpOk(webUrl);
  const web = webAlreadyRunning
    ? null
    : spawnService("web", "pnpm", ["--filter", "@zyquor/web", "dev"], {
        ...commonEnv,
        ZYQUOR_API_URL: apiUrl
      });
  const worker = spawnService("worker", "pnpm", ["--filter", "@zyquor/worker", "dev"], {
    ...commonEnv,
    ZYQUOR_RUN_WORKER: "1",
    ZYQUOR_WORKER_POLL_MS: process.env.ZYQUOR_WORKER_POLL_MS ?? "5000"
  });

  if (!webAlreadyRunning) {
    await waitFor("Web", webUrl, 90_000);
  }
  await printStatus();

  const stop = () => {
    api?.kill("SIGINT");
    web?.kill("SIGINT");
    worker.kill("SIGINT");
  };
  process.on("SIGINT", () => {
    stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stop();
    process.exit(0);
  });
}

async function check() {
  if (!(await httpOk(`${apiUrl}/health`))) {
    console.error(`API not running at ${apiUrl}. Run: zyquor`);
    process.exit(1);
  }
  await printStatus();
}

async function post(jobId) {
  if (!jobId) {
    console.error("Usage: zyquor post <jobId>");
    process.exit(1);
  }
  const response = await fetch(`${apiUrl}/jobs/${jobId}/post`, { method: "POST" });
  const body = await response.text();
  console.log(body);
  process.exit(response.ok ? 0 : 1);
}

if (!existsSync(resolve(rootDir, "node_modules"))) {
  console.error("Dependencies missing. Run once: pnpm install");
  process.exit(1);
}

if (command === "start") {
  await start();
} else if (command === "check") {
  await check();
} else if (command === "post") {
  await post(args[1]);
} else if (command === "help" || command === "--help" || command === "-h") {
  console.log("Usage: zyquor [start|check|post <jobId>]");
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
