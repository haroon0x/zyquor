import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";
import { logLine } from "./log.js";

export interface DesktopSettings {
  enableBrowserPrepare?: boolean;
  enableBrowserPost?: boolean;
  closeChromeAfterPost?: boolean;
  headless?: boolean;
  commandCodePath?: string;
  opencodePath?: string;
  opencodeVariant?: string;
  llmProvider?: string;
  geminiApiKey?: string;
  chromePath?: string;
  cdpPort?: number;
  startWithWindows?: boolean;
  feedbackDir?: string;
  autoApproveSourcePackets?: boolean;
}

const SECRET_FIELDS = ["geminiApiKey"] as const;
const ENCRYPTED_PREFIX = "enc:v1:";

let encryptionUnavailableWarningLogged = false;

function warnEncryptionUnavailable(): void {
  if (encryptionUnavailableWarningLogged) return;
  encryptionUnavailableWarningLogged = true;
  logLine("warn", "settings: secure API key storage is unavailable; API keys will be stored in plaintext");
}

function decryptSecrets(settings: DesktopSettings): DesktopSettings {
  const decrypted = { ...settings };
  const hasSecrets = SECRET_FIELDS.some((field) => typeof decrypted[field] === "string");
  if (!hasSecrets) return decrypted;

  const encryptionAvailable = safeStorage.isEncryptionAvailable();
  if (!encryptionAvailable) warnEncryptionUnavailable();

  for (const field of SECRET_FIELDS) {
    const value = decrypted[field];
    if (typeof value !== "string" || !value.startsWith(ENCRYPTED_PREFIX)) continue;

    if (!encryptionAvailable) {
      delete decrypted[field];
      continue;
    }

    try {
      decrypted[field] = safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), "base64"));
    } catch (err) {
      delete decrypted[field];
      logLine("error", `settings: failed to decrypt ${field}: ${(err as Error).message}`);
    }
  }

  return decrypted;
}

function encryptSecrets(settings: DesktopSettings): DesktopSettings {
  const encrypted = { ...settings };
  const hasSecrets = SECRET_FIELDS.some((field) => typeof encrypted[field] === "string");
  if (!hasSecrets) return encrypted;

  if (!safeStorage.isEncryptionAvailable()) {
    warnEncryptionUnavailable();
    return encrypted;
  }

  for (const field of SECRET_FIELDS) {
    const value = encrypted[field];
    if (typeof value !== "string") continue;
    encrypted[field] = ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString("base64");
  }

  return encrypted;
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
    return decryptSecrets(parsed as DesktopSettings);
  } catch (err) {
    console.warn("settings: failed to parse settings.json — ignoring:", (err as Error).message);
    return {};
  }
}

export function saveSettings(dataRoot: string, settings: DesktopSettings): void {
  const path = settingsPath(dataRoot);
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(encryptSecrets(settings), null, 2), "utf8");
  renameSync(tmp, path);
}

export function applySettingsToEnv(settings: DesktopSettings, options: { overwrite?: boolean } = {}): void {
  // Only set env vars NOT already present in process.env
  // (existing env/shell precedence wins, matching dotenv loader semantics)
  const map: Record<string, string | undefined> = {
    ZYQUOR_ENABLE_BROWSER_PREPARE: settings.enableBrowserPrepare !== undefined ? String(Number(settings.enableBrowserPrepare)) : undefined,
    ZYQUOR_ENABLE_BROWSER_POST: settings.enableBrowserPost !== undefined ? String(Number(settings.enableBrowserPost)) : undefined,
    ZYQUOR_BROWSER_CLOSE_AFTER_POST: settings.closeChromeAfterPost !== undefined ? String(Number(settings.closeChromeAfterPost)) : undefined,
    ZYQUOR_BROWSER_HEADLESS: settings.headless !== undefined ? String(Number(settings.headless)) : undefined,
    ZYQUOR_COMMAND_CODE_PATH: settings.commandCodePath,
    ZYQUOR_OPENCODE_PATH: settings.opencodePath,
    ZYQUOR_OPENCODE_VARIANT: settings.opencodeVariant,
    ZYQUOR_LLM_PROVIDER: settings.llmProvider,
    ZYQUOR_GEMINI_API_KEY: settings.geminiApiKey,
    ZYQUOR_CHROME_PATH: settings.chromePath,
    ZYQUOR_BROWSER_CDP_PORT: settings.cdpPort !== undefined ? String(settings.cdpPort) : undefined,
    ZYQUOR_BROWSER_CDP_URL: settings.cdpPort !== undefined ? `http://127.0.0.1:${settings.cdpPort}` : undefined,
  };

  for (const [key, value] of Object.entries(map)) {
    if (value !== undefined && (options.overwrite || process.env[key] === undefined)) {
      process.env[key] = value;
    }
  }
}

export function applyDesktopEnvDefaults(settings: DesktopSettings): void {
  process.env.ZYQUOR_LLM_PROVIDER ??= "opencode";
  process.env.ZYQUOR_COMMAND_CODE_MODEL ??= "gpt-5.6-luna";
  process.env.ZYQUOR_OPENCODE_MODEL ??= "opencode/deepseek-v4.1-flash-free";
  process.env.ZYQUOR_OPENCODE_PATH ??= "opencode";
  process.env.ZYQUOR_ENABLE_BROWSER_PREPARE ??= String(Number(settings.enableBrowserPrepare ?? true));
  process.env.ZYQUOR_ENABLE_BROWSER_POST ??= String(Number(settings.enableBrowserPost ?? true));
  process.env.ZYQUOR_BROWSER_CHANNEL ??= 'chrome';
  process.env.ZYQUOR_BROWSER_CDP_URL ??= 'http://127.0.0.1:' + (settings.cdpPort ?? 9222);
  process.env.ZYQUOR_BROWSER_HEADLESS ??= String(Number(settings.headless ?? false));
  process.env.ZYQUOR_OLLAMA_BASE_URL ??= 'http://127.0.0.1:11434';
  process.env.ZYQUOR_QUALITY_MIN ??= '7';
}
