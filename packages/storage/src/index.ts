import { createSqliteRepository, defaultDatabasePath } from "./sqlite.js";
import { createJsonFileRepository, defaultJsonDatabasePath } from "./memory.js";
import type { ZyquorRepository } from "./types.js";

import { createRequire } from "node:module";

export * from "./types.js";
export * from "./sqlite.js";
export * from "./memory.js";
export * from "./mappers.js";
export * from "./utils.js";
export { ensureFirstRun } from "./firstrun.js";

export async function detectSqliteSupport(): Promise<{ available: boolean; error?: string }> {
  try {
    const req = createRequire(import.meta.url);
    req("node:sqlite");
    return { available: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, error: message };
  }
}

export async function createLocalRepository(filePath = defaultDatabasePath()): Promise<ZyquorRepository> {
  try {
    return await createSqliteRepository(filePath);
  } catch (error) {
    console.warn("Failed to create SQLite repository, falling back to JSON file:", error);
    return createJsonFileRepository(defaultJsonDatabasePath());
  }
}
