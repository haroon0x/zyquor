import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findDotEnv(startDir = process.cwd()) {
  let current = resolve(startDir);
  for (;;) {
    const candidate = join(current, ".env");
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function loadDotEnv(filePath) {
  const resolvedPath = filePath ?? findDotEnv();
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return;
  }

  for (const line of readFileSync(resolvedPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(trimmed);
    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) {
      continue;
    }

    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}
