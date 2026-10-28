import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initFileLog, logLine, flushLogSync, logTail } from "./log.js";

const tmpRoot = "/tmp/zyquor-desktop-log-test";

beforeEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("initFileLog", () => {
  it("creates logs dir and main.log with init line", () => {
    initFileLog(tmpRoot);

    const logPath = join(tmpRoot, "logs", "main.log");
    expect(existsSync(logPath)).toBe(true);

    const content = readFileSync(logPath, "utf8");
    expect(content).toContain("log initialized");
  });

  it("rotates when main.log exceeds 5 MB", () => {
    const logsDir = join(tmpRoot, "logs");
    mkdirSync(logsDir, { recursive: true });
    const logPath = join(logsDir, "main.log");

    // Write ~5.1 MB fake log
    const chunk = "x".repeat(1024) + "\n";
    const buf = Buffer.alloc(0);
    const needed = Math.ceil((5.1 * 1024 * 1024) / chunk.length);
    const parts: string[] = [];
    for (let i = 0; i < needed; i++) {
      parts.push(chunk);
    }
    writeFileSync(logPath, parts.join(""));

    const preSize = statSync(logPath).size;
    expect(preSize).toBeGreaterThan(5 * 1024 * 1024);

    initFileLog(tmpRoot);

    // main.log.1 should exist and contain the old oversized data
    const rotatedPath = join(logsDir, "main.log.1");
    expect(existsSync(rotatedPath)).toBe(true);
    expect(statSync(rotatedPath).size).toBe(preSize);

    // main.log should be fresh
    const newContent = readFileSync(logPath, "utf8");
    expect(newContent).toContain("log initialized");
    expect(newContent.length).toBeLessThan(preSize);
  });
});

describe("logLine", () => {
  it("appends a timestamped line", () => {
    initFileLog(tmpRoot);
    logLine("info", "test message");
    flushLogSync();

    const content = readFileSync(join(tmpRoot, "logs", "main.log"), "utf8");
    const lines = content.trim().split("\n");

    expect(lines.length).toBeGreaterThanOrEqual(2);
    const lastLine = lines[lines.length - 1]!;
    expect(lastLine).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[info\] test message$/);
  });

  it("does not crash when called before initFileLog", () => {
    expect(() => logLine("info", "pre-init")).not.toThrow();
  });

  it("keeps buffered lines visible to logTail before the flush", () => {
    initFileLog(tmpRoot);
    logLine("info", "buffered line");
    expect(logTail(1)[0]).toContain("buffered line");
  });

  it("batches many lines into a single write", () => {
    initFileLog(tmpRoot);
    for (let i = 0; i < 200; i++) logLine("info", `burst ${i}`);
    flushLogSync();

    const content = readFileSync(join(tmpRoot, "logs", "main.log"), "utf8");
    expect(content).toContain("burst 199");
    expect(content.match(/burst 199/g)).toHaveLength(1);
  });
});
