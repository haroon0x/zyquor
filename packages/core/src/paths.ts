import { resolve } from "node:path";

export function resolveDataRoot(): string {
  const dataRoot = process.env.ZYQUOR_DATA_ROOT ?? process.env.ZYQUOR_WORKSPACE_ROOT;
  if (dataRoot) return resolve(dataRoot);
  return process.cwd();
}

export function dataPath(...segments: string[]): string {
  return resolve(resolveDataRoot(), ...segments);
}

export function profilesPath(...segments: string[]): string {
  return resolve(resolveDataRoot(), "profiles", ...segments);
}
