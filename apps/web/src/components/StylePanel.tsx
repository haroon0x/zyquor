import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { PanelProps, StyleProfile } from "../types.js";

export function StylePanel({ panel, styleProfileId }: { panel: PanelProps; styleProfileId: string }) {
  const { busy, run } = panel;
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [systemPromptExtra, setSystemPromptExtra] = useState("");
  const [objective, setObjective] = useState("Maximize useful reach, views, and reputation without cheap spam.");
  const [bannedPhrases, setBannedPhrases] = useState("game changer\nunlock\n10x");

  async function loadStyleProfile() {
    const { profile } = await api<{ profile: StyleProfile }>(`/style-profiles/${styleProfileId}`);
    setStyleProfile(profile);
    setSystemPromptExtra(typeof profile.rules.systemPromptExtra === "string" ? profile.rules.systemPromptExtra : "");
    setObjective(
      typeof profile.rules.objective === "string"
        ? profile.rules.objective
        : "Maximize useful reach, views, and reputation without cheap spam."
    );
    setBannedPhrases(profile.bannedPhrases.join("\n"));
  }

  useEffect(() => {
    void loadStyleProfile();
  }, [styleProfileId, panel.refreshToken]);

  function saveStyleProfile() {
    if (!styleProfile) return;
    run(async () => {
      const { profile } = await api<{ profile: StyleProfile }>(`/style-profiles/${styleProfile.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          bannedPhrases: bannedPhrases.split(/\n+/).map((line) => line.trim()).filter(Boolean),
          rules: { ...styleProfile.rules, objective, systemPromptExtra },
          tone: styleProfile.tone
        })
      });
      setStyleProfile(profile);
    });
  }

  return styleProfile ? (
    <section className="panel settings">
      <div className="panel-head">
        <h2>Prompt</h2>
        <span>{styleProfile.name}</span>
      </div>
      <div className="settings-grid">
        <label>
          Tone
          <input
            value={styleProfile.tone ?? ""}
            onChange={(event) => setStyleProfile({ ...styleProfile, tone: event.target.value || null })}
          />
        </label>
        <label>
          Objective
          <input value={objective} onChange={(event) => setObjective(event.target.value)} />
        </label>
        <label>
          Banned phrases
          <textarea value={bannedPhrases} onChange={(event) => setBannedPhrases(event.target.value)} rows={5} />
        </label>
        <label>
          Extra system prompt
          <textarea value={systemPromptExtra} onChange={(event) => setSystemPromptExtra(event.target.value)} rows={5} />
        </label>
      </div>
      <button disabled={busy} onClick={saveStyleProfile}>Save prompt</button>
    </section>
  ) : null;
}
