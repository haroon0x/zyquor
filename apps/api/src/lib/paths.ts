import { isAbsolute, resolve } from "node:path";

export function workspaceRoot() {
  return process.env.ZYQUOR_WORKSPACE_ROOT ?? resolve(process.cwd(), "../..");
}

export function defaultGenerationConfigPath() {
  return resolve(workspaceRoot(), "data/generation.json");
}

export function resolveProfileDir(profileDir: string) {
  return isAbsolute(profileDir) ? profileDir : resolve(workspaceRoot(), profileDir);
}
