import type { FastifyInstance } from "fastify";
import { createGenerationProviderFromEnv } from "@zyquor/generation";
import type { AppDeps, DesktopSettingsData } from "../deps.js";

const SENSITIVE_KEYS = new Set(["openrouterApiKey", "geminiApiKey"]);

const GENERATION_KEYS = new Set(["commandCodePath", "llmProvider", "openrouterApiKey", "geminiApiKey"]);

const GENERATION_ENV_KEYS: Record<string, string> = {
  commandCodePath: "ZYQUOR_COMMAND_CODE_PATH",
  geminiApiKey: "ZYQUOR_GEMINI_API_KEY",
  llmProvider: "ZYQUOR_LLM_PROVIDER",
  openrouterApiKey: "ZYQUOR_OPENROUTER_API_KEY",
};

function maskSettings(settings: DesktopSettingsData): DesktopSettingsData {
  const masked = { ...settings } as Record<string, unknown>;
  for (const key of SENSITIVE_KEYS) {
    const value = masked[key];
    if (typeof value === "string" && value.length > 0) {
      masked[key] = value.length <= 4 ? "****" : "*".repeat(value.length - 4) + value.slice(-4);
    }
  }
  return masked as DesktopSettingsData;
}

export function registerSettingsRoutes(app: FastifyInstance, deps: AppDeps): void {
  if (!deps.desktopSettings) return;

  app.get("/settings", async (_request, _reply) => {
    const settings = deps.desktopSettings!.get();
    return maskSettings(settings);
  });

  app.patch("/settings", async (request, reply) => {
    const patch = (request.body ?? {}) as DesktopSettingsData;
    const current = deps.desktopSettings!.get();
    const maskedCurrent = maskSettings(current);

    for (const key of SENSITIVE_KEYS) {
      const incoming = patch[key as keyof DesktopSettingsData];
      const stored = current[key as keyof DesktopSettingsData];
      if (typeof incoming === "string" && typeof stored === "string" && incoming === maskedCurrent[key as keyof DesktopSettingsData]) {
        delete patch[key as keyof DesktopSettingsData];
      }
    }

    for (const key of Object.keys(patch) as (keyof DesktopSettingsData)[]) {
      if (patch[key] === "") delete patch[key];
    }

    const updated = deps.desktopSettings!.update(patch);
    const masked = maskSettings(updated);

    if (typeof patch.enableBrowserPrepare === "boolean") deps.browser.enablePrepare = patch.enableBrowserPrepare;
    if (typeof patch.enableBrowserPost === "boolean") deps.browser.enablePost = patch.enableBrowserPost;
    if (typeof patch.closeChromeAfterPost === "boolean") deps.browser.closeAfterPost = patch.closeChromeAfterPost;
    if (typeof patch.cdpPort === "number") deps.browser.cdpUrl = `http://127.0.0.1:${patch.cdpPort}`;

    let restartRequired = false;
    const generationPatch = Object.keys(patch).filter((key) => GENERATION_KEYS.has(key));
    if (generationPatch.length > 0) {
      const nextEnv = { ...deps.generationEnv } as Record<string, string | undefined>;
      for (const key of generationPatch) {
        const value = updated[key as keyof DesktopSettingsData];
        nextEnv[GENERATION_ENV_KEYS[key]!] = value === undefined ? undefined : String(value);
      }
      try {
        deps.generationProvider = createGenerationProviderFromEnv(nextEnv);
        deps.generationEnv = nextEnv;
        restartRequired = false;
      } catch {
        restartRequired = true;
      }
    }

    return { ...masked, restartRequired };
  });
}
