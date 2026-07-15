import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

export function ensureFirstRun(dataRoot: string): void {
  const root = resolve(dataRoot);
  mkdirSync(resolve(root, "data", "artifacts"), { recursive: true });
  mkdirSync(resolve(root, "profiles", "personal-main"), { recursive: true });
}
