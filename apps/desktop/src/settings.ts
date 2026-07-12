import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DesktopSettings {
  enableBrowserPrepare?: boolean;
  enableBrowserPost?: boolean;
  closeChromeAfterPost?: boolean;
  llmProvider?: string;
  openrouterApiKey?: string;
  geminiApiKey?: string;
  chromePath?: string;
  cdpPort?: number;
  startWithWindows?: boolean;
}

function settingsPath(dataRoot: string): string {
  return join(dataRoot, "settings.json");
}

export function loadSettings(dataRoot: string): DesktopSettings {
  const path = settingsPath(dataRoot);
  if (!existsSync(path)) return {};

  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.warn("settings: settings.json is not a JSON object — ignoring");
      return {};
    }
    return parsed as DesktopSettings;
  } catch (err) {
    console.warn("settings: failed to parse settings.json — ignoring:", (err as Error).message);
    return {};
  }
}

export function saveSettings(dataRoot: string, settings: DesktopSettings): void {
  const path = settingsPath(dataRoot);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf8");
  renameSync(tmp, path);
}

export function applySettingsToEnv(settings: DesktopSettings): void {
  // Only set env vars NOT already present in process.env
  // (existing env/shell precedence wins, matching dotenv loader semantics)
  const map: Record<string, string | undefined> = {
    ZYQUOR_ENABLE_BROWSER_PREPARE: settings.enableBrowserPrepare !== undefined ? String(Number(settings.enableBrowserPrepare)) : undefined,
    ZYQUOR_ENABLE_BROWSER_POST: settings.enableBrowserPost !== undefined ? String(Number(settings.enableBrowserPost)) : undefined,
    ZYQUOR_BROWSER_CLOSE_AFTER_POST: settings.closeChromeAfterPost !== undefined ? String(Number(settings.closeChromeAfterPost)) : undefined,
    ZYQUOR_LLM_PROVIDER: settings.llmProvider,
    ZYQUOR_OPENROUTER_API_KEY: settings.openrouterApiKey,
    ZYQUOR_GEMINI_API_KEY: settings.geminiApiKey,
    ZYQUOR_CHROME_PATH: settings.chromePath,
    ZYQUOR_BROWSER_CDP_PORT: settings.cdpPort !== undefined ? String(settings.cdpPort) : undefined,
  };

  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
