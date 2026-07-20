import type { FastifyInstance } from "fastify";
import type { AppDeps, DesktopSettingsData } from "../deps.js";

const SENSITIVE_KEYS = new Set(["openrouterApiKey", "geminiApiKey"]);

const RESTART_REQUIRED_KEYS = new Set([
  "enableBrowserPrepare",
  "enableBrowserPost",
  "closeChromeAfterPost",
  "commandCodePath",
  "llmProvider",
  "openrouterApiKey",
  "geminiApiKey",
  "chromePath",
  "cdpPort",
]);

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

    const updated = deps.desktopSettings!.update(patch);
    const masked = maskSettings(updated);

    let restartRequired = false;
    for (const key of Object.keys(patch)) {
      if (RESTART_REQUIRED_KEYS.has(key)) {
        restartRequired = true;
        break;
      }
    }

    return { ...masked, restartRequired };
  });
}
