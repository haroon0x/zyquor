import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

const FIVE_MB = 5 * 1024 * 1024;

let _logPath: string | null = null;

const baseConsoleLog = console.log.bind(console);

function rotateIfNeeded(logPath: string): void {
  try {
    const stat = statSync(logPath);
    if (stat.size > FIVE_MB) {
      renameSync(logPath, logPath + ".1");
    }
  } catch {
    // file doesn't exist or can't be stat'd — no rotation needed
  }
}

export function logFilePath(): string | null {
  return _logPath;
}

export function logTail(lines: number): string[] {
  if (!_logPath) return [];
  try {
    const content = readFileSync(_logPath, "utf8");
    const all = content.split("\n").filter((line) => line.length > 0);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

export function initFileLog(dataRoot: string): void {
  const logsDir = join(dataRoot, "logs");
  mkdirSync(logsDir, { recursive: true });

  _logPath = join(logsDir, "main.log");
  rotateIfNeeded(_logPath);

  logLine("info", "log initialized");

  process.on("uncaughtException", (err) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    logLine("error", `uncaughtException: ${msg}`);
    // keep running — only exit on truly fatal conditions
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    logLine("error", `unhandledRejection: ${msg}`);
    // keep running
  });
}

/**
 * Write a timestamped log line to the file (if initialized) and console.
 */
export function logLine(level: string, msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}`;

  baseConsoleLog(line);

  if (_logPath) {
    try {
      appendFileSync(_logPath, line + "\n", "utf8");
    } catch {
      // swallow — don't crash because of logging
    }
  }
}
