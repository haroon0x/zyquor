#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serviceDir = resolve(root, "services/crawl4ai");

const child = spawn("uv", ["run", "python", "zyquor_crawl4ai.py"], {
  cwd: serviceDir,
  stdio: "inherit"
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`Failed to start Crawl4AI service: ${error.message}`);
  process.exit(1);
});
