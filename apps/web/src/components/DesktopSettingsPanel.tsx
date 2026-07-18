import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { DesktopSettingsData, PanelProps } from "../types.js";
import { Busy, InlineError, PanelIcon, errorMessage } from "./Feedback.js";

export function DesktopSettingsPanel({ panel }: { panel: PanelProps }) {
  const { busy, run } = panel;
  const [desktopSettings, setDesktopSettings] = useState<DesktopSettingsData>({});
  const [apiKeys, setApiKeys] = useState({ geminiApiKey: "", openrouterApiKey: "" });
  const [desktopRestartRequired, setDesktopRestartRequired] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  function patchSetting<K extends keyof DesktopSettingsData>(key: K, value: DesktopSettingsData[K] | undefined) {
    setDesktopSettings((prev) => {
      const next = { ...prev };
      if (value === undefined || value === "") delete next[key];
      else next[key] = value;
      return next;
    });
  }

  function loadDesktopSettings() {
    setLoadError(null);
    void (async () => {
      const settings = await api<DesktopSettingsData>("/settings");
      setDesktopSettings(settings);
      setDesktopRestartRequired(false);
    })().catch((error) => setLoadError(errorMessage(error, "Desktop settings unavailable")));
  }

  useEffect(() => {
    loadDesktopSettings();
  }, []);

  function saveDesktopSettings() {
    run(async () => {
      const payload: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(desktopSettings)) {
        if (key === "restartRequired" || key === "openrouterApiKey" || key === "geminiApiKey") continue;
        payload[key] = value;
      }
      if (apiKeys.openrouterApiKey) payload.openrouterApiKey = apiKeys.openrouterApiKey;
      if (apiKeys.geminiApiKey) payload.geminiApiKey = apiKeys.geminiApiKey;
      const result = await api<DesktopSettingsData & { restartRequired?: boolean }>("/settings", {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      setDesktopSettings(result);
      setApiKeys({ geminiApiKey: "", openrouterApiKey: "" });
      if (result.restartRequired) setDesktopRestartRequired(true);
    });
  }

  return (
    <section className="panel settings">
      <div className="panel-head">
        <h2 className="panel-title"><PanelIcon name="settings" />Desktop Settings</h2>
        {desktopRestartRequired ? <span className="pill pill--failed">Restart required</span> : null}
      </div>
      <InlineError message={loadError} />
      {desktopRestartRequired ? <p className="empty">Changes to browser, provider, or API keys require an app restart.</p> : null}
      <div className="settings-grid">
        <label className="checkbox-row switch-row">
          <input checked={desktopSettings.enableBrowserPrepare ?? false} type="checkbox" onChange={(event) => patchSetting("enableBrowserPrepare", event.target.checked)} />
          <span aria-hidden="true" className="switch" />
          Browser prepare
        </label>
        <label className="checkbox-row switch-row">
          <input checked={desktopSettings.enableBrowserPost ?? false} type="checkbox" onChange={(event) => patchSetting("enableBrowserPost", event.target.checked)} />
          <span aria-hidden="true" className="switch" />
          Browser post
        </label>
        <label className="checkbox-row switch-row">
          <input checked={desktopSettings.closeChromeAfterPost ?? false} type="checkbox" onChange={(event) => patchSetting("closeChromeAfterPost", event.target.checked)} />
          <span aria-hidden="true" className="switch" />
          Close Chrome after post
        </label>
        <label>
          Provider
          <select value={desktopSettings.llmProvider ?? ""} onChange={(event) => patchSetting("llmProvider", event.target.value || undefined)}>
            <option value="">(default)</option>
            <option value="command-code">Command Code</option>
            <option value="openrouter">OpenRouter</option>
            <option value="gemini">Gemini</option>
            <option value="ollama">Ollama</option>
            <option value="auto">Auto</option>
          </select>
        </label>
        <label>
          Command Code path
          <input value={desktopSettings.commandCodePath ?? ""} onChange={(event) => patchSetting("commandCodePath", event.target.value || undefined)} placeholder="command-code" />
        </label>
        <label>
          OpenRouter API key
          <input type="password" value={apiKeys.openrouterApiKey} onChange={(event) => setApiKeys((current) => ({ ...current, openrouterApiKey: event.target.value }))} placeholder={desktopSettings.openrouterApiKey ? "••••••••" : "sk-or-..."} />
        </label>
        <label>
          Gemini API key
          <input type="password" value={apiKeys.geminiApiKey} onChange={(event) => setApiKeys((current) => ({ ...current, geminiApiKey: event.target.value }))} placeholder={desktopSettings.geminiApiKey ? "••••••••" : "AIza..."} />
        </label>
        <label>
          Chrome path
          <input value={desktopSettings.chromePath ?? ""} onChange={(event) => patchSetting("chromePath", event.target.value || undefined)} placeholder="Auto-detect" />
        </label>
        <label>
          CDP port
          <input type="number" value={desktopSettings.cdpPort ?? ""} onChange={(event) => patchSetting("cdpPort", event.target.value ? Number(event.target.value) : undefined)} placeholder="9222" />
        </label>
      </div>
      <button disabled={busy} onClick={saveDesktopSettings}><Busy active={busy} />Save settings</button>
    </section>
  );
}
