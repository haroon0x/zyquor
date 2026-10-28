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

/** Per-account posting Chrome runs on its own remote-debugging port so jobs
 * for different accounts can run at the same time. Profiles named in
 * ZYQUOR_BROWSER_CDP_BASE_PROFILES (default "personal-main") sit on the base
 * port, willainotice on base+1, anything else on a stable hash offset. */
function basePortProfiles(): string[] {
  return (process.env.ZYQUOR_BROWSER_CDP_BASE_PROFILES ?? "personal-main")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

export function perProfileCdpUrl(base: string | undefined, profileDir: string): string {
  try {
    const url = new URL(base ?? "http://127.0.0.1:9222");
    const basePort = Number(url.port || 9222);
    const normalized = profileDir.replaceAll("\\", "/").toLowerCase();
    let offset = 0;
    if (normalized.includes("willainotice")) offset = 1;
    else if (!basePortProfiles().some((name) => normalized.includes(name))) {
      let h = 0;
      for (let i = 0; i < normalized.length; i++) h = (h * 31 + normalized.charCodeAt(i)) % 10;
      offset = h;
    }
    url.port = String(basePort + offset);
    return url.toString().replace(/\/$/, "");
  } catch {
    return base ?? "http://127.0.0.1:9222";
  }
}
