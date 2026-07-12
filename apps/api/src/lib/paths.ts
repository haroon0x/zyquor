import { isAbsolute, resolve } from "node:path";
import { resolveDataRoot } from "@zyquor/core";

export function workspaceRoot() {
  return resolveDataRoot();
}

export function defaultGenerationConfigPath() {
  return resolve(workspaceRoot(), "data/generation.json");
}

export function resolveProfileDir(profileDir: string) {
  return isAbsolute(profileDir) ? profileDir : resolve(workspaceRoot(), profileDir);
}
