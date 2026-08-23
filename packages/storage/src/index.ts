import { createRequire } from "node:module";

export * from "./types.js";
export * from "./sqlite.js";
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
