import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

const FIVE_MB = 5 * 1024 * 1024;
const FLUSH_DELAY_MS = 100;
const MAX_BUFFERED_BYTES = 256 * 1024;

let _logPath: string | null = null;
let _buffer: string[] = [];
let _bufferBytes = 0;
let _writtenBytes = 0;
let _timer: NodeJS.Timeout | null = null;

const baseConsoleLog = console.log.bind(console);

function rotate(logPath: string): void {
  // Windows rename fails when the target exists, so drop the old backup first.
  try {
    rmSync(logPath + ".1", { force: true });
  } catch {
    // ignore
  }
  try {
    renameSync(logPath, logPath + ".1");
  } catch {
    // file missing or locked — keep appending to the current file
  }
}

function rotateIfNeeded(logPath: string): void {
  try {
    const stat = statSync(logPath);
    if (stat.size > FIVE_MB) rotate(logPath);
  } catch {
    // file doesn't exist or can't be stat'd — no rotation needed
  }
}

function fileSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

function writeNow(text: string): void {
  if (!_logPath || text.length === 0) return;
  try {
    appendFileSync(_logPath, text, "utf8");
    _writtenBytes += Buffer.byteLength(text);
  } catch {
    // swallow — don't crash because of logging
  }
}

/**
 * Push buffered lines to disk. Runs off the hot path: logLine never blocks on
 * I/O, and the flush is batched so bursts cost one write instead of one each.
 */
export function flushLog(): void {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  if (_buffer.length === 0) return;

  const text = _buffer.join("");
  const bytes = Buffer.byteLength(text);
  _buffer = [];
  _bufferBytes = 0;

  if (_logPath && _writtenBytes + bytes > FIVE_MB) {
    // Rotate on write, not only at startup, so a long-running app cannot grow
    // main.log without bound.
    rotate(_logPath);
    _writtenBytes = 0;
  }

  writeNow(text);
}

/** Drain the buffer with a blocking write. Only for shutdown paths. */
export function flushLogSync(): void {
  flushLog();
}

function scheduleFlush(): void {
  if (_timer) return;
  _timer = setTimeout(() => {
    _timer = null;
    flushLog();
  }, FLUSH_DELAY_MS);
  _timer.unref();
}

export function logFilePath(): string | null {
  return _logPath;
}

export function logTail(lines: number): string[] {
  if (!_logPath) return [];
  try {
    const content = readFileSync(_logPath, "utf8") + _buffer.join("");
    const all = content.split("\n").filter((line) => line.length > 0);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

let _handlersInstalled = false;

function installProcessHandlers(): void {
  if (_handlersInstalled) return;
  _handlersInstalled = true;

  process.on("uncaughtException", (err) => {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    logLine("error", `uncaughtException: ${msg}`);
    flushLogSync();
    // keep running — only exit on truly fatal conditions
  });

  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    logLine("error", `unhandledRejection: ${msg}`);
    // keep running
  });

  process.on("exit", flushLogSync);
}

export function initFileLog(dataRoot: string): void {
  const logsDir = join(dataRoot, "logs");
  mkdirSync(logsDir, { recursive: true });

  _logPath = join(logsDir, "main.log");
  _buffer = [];
  _bufferBytes = 0;
  _writtenBytes = fileSize(_logPath);
  rotateIfNeeded(_logPath);
  if (_writtenBytes > FIVE_MB) _writtenBytes = 0;

  // The init line is written synchronously: it is one write per process and
  // makes "did the app ever boot" answerable even after a hard crash.
  writeNow(`${new Date().toISOString()} [info] log initialized\n`);

  installProcessHandlers();
}

/**
 * Write a timestamped log line to the file (if initialized) and console.
 */
export function logLine(level: string, msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}`;

  baseConsoleLog(line);

  if (!_logPath) return;
  _buffer.push(line + "\n");
  _bufferBytes += Buffer.byteLength(line) + 1;

  if (_bufferBytes >= MAX_BUFFERED_BYTES) {
    flushLog();
    return;
  }
  scheduleFlush();
}
