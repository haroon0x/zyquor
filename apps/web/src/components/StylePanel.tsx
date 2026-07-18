import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { PanelProps, StyleProfile } from "../types.js";
import { Busy, InlineError, PanelIcon, errorMessage } from "./Feedback.js";

export function StylePanel({ panel, styleProfileId }: { panel: PanelProps; styleProfileId: string }) {
  const { busy, run } = panel;
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [systemPromptExtra, setSystemPromptExtra] = useState("");
  const [objective, setObjective] = useState("Maximize useful reach, views, and reputation without cheap spam.");
  const [bannedPhrases, setBannedPhrases] = useState("game changer\nunlock\n10x");
  const [examplePosts, setExamplePosts] = useState("");

  async function loadStyleProfile() {
    setLoadError(null);
    const { profile } = await api<{ profile: StyleProfile }>(`/style-profiles/${styleProfileId}`);
    setStyleProfile(profile);
    setSystemPromptExtra(typeof profile.rules.systemPromptExtra === "string" ? profile.rules.systemPromptExtra : "");
    setObjective(
      typeof profile.rules.objective === "string"
        ? profile.rules.objective
        : "Maximize useful reach, views, and reputation without cheap spam."
    );
    setBannedPhrases(profile.bannedPhrases.join("\n"));
    setExamplePosts(profile.examplePosts.join("\n\n"));
  }

  useEffect(() => {
    void loadStyleProfile().catch((error) => setLoadError(errorMessage(error, "Prompt unavailable")));
  }, [styleProfileId, panel.refreshToken]);

  function saveStyleProfile() {
    if (!styleProfile) return;
    run(async () => {
      const { profile } = await api<{ profile: StyleProfile }>(`/style-profiles/${styleProfile.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          bannedPhrases: bannedPhrases.split(/\n+/).map((line) => line.trim()).filter(Boolean),
          examplePosts: examplePosts.split(/\n{2,}/).map((post) => post.trim()).filter(Boolean),
          rules: { ...styleProfile.rules, objective, systemPromptExtra },
          tone: styleProfile.tone
        })
      });
      setStyleProfile(profile);
    });
  }

  return (
    <section className="panel settings">
      <div className="panel-head">
        <h2 className="panel-title"><PanelIcon name="edit" />Style</h2>
        {styleProfile ? <span>{styleProfile.name}</span> : null}
      </div>
      <InlineError message={loadError} />
      {styleProfile ? <><div className="settings-grid">
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
          Example posts, separated by a blank line
          <textarea value={examplePosts} onChange={(event) => setExamplePosts(event.target.value)} rows={8} />
        </label>
        <label>
          Extra system prompt
          <textarea value={systemPromptExtra} onChange={(event) => setSystemPromptExtra(event.target.value)} rows={5} />
        </label>
      </div>
      <button disabled={busy} onClick={saveStyleProfile}><Busy active={busy} />Save prompt</button></> : !loadError ? <p className="empty">Loading prompt…</p> : null}
    </section>
  );
}
