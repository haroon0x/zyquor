import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { PanelProps, StyleProfile, SystemFeedback } from "../types.js";
import { Busy, InlineError, PanelIcon, errorMessage } from "./Feedback.js";

export function StylePanel({ panel, styleProfileId }: { panel: PanelProps; styleProfileId: string }) {
  const { busy, run, accountId } = panel;
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [systemPromptExtra, setSystemPromptExtra] = useState("");
  const [objective, setObjective] = useState("Maximize useful reach, views, and reputation without cheap spam.");
  const [bannedPhrases, setBannedPhrases] = useState("game changer\nunlock\n10x");
  const [examplePosts, setExamplePosts] = useState("");
  const [systemFeedback, setSystemFeedback] = useState<SystemFeedback[]>([]);
  const [feedbackText, setFeedbackText] = useState("");

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
    const { items } = await api<{ items: SystemFeedback[] }>(`/system-feedback?accountId=${encodeURIComponent(accountId)}`);
    setSystemFeedback(items);
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

  function addSystemFeedback() {
    if (!feedbackText.trim()) return;
    run(async () => {
      await api("/system-feedback", {
        method: "POST",
        body: JSON.stringify({ accountId, text: feedbackText.trim() })
      });
      setFeedbackText("");
      const { items } = await api<{ items: SystemFeedback[] }>(`/system-feedback?accountId=${encodeURIComponent(accountId)}`);
      setSystemFeedback(items);
    });
  }

  function deleteSystemFeedback(id: string) {
    run(async () => {
      await api(`/system-feedback/${id}`, { method: "DELETE" });
      setSystemFeedback(systemFeedback.filter((item) => item.id !== id));
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
      <button disabled={busy} onClick={saveStyleProfile}><Busy active={busy} />Save prompt</button>
      <div className="system-feedback-section">
        <h3>System feedback</h3>
        <p className="empty">Standing corrections injected into every generation for this account.</p>
        {systemFeedback.length ? (
          <ul className="feedback-list">
            {systemFeedback.map((item) => (
              <li key={item.id}>
                <span>{item.text}</span>
                <button className="secondary danger compact-button" disabled={busy} onClick={() => deleteSystemFeedback(item.id)}>Remove</button>
              </li>
            ))}
          </ul>
        ) : <p className="empty">No standing feedback yet.</p>}
        <div className="source-actions">
          <textarea
            aria-label="New system feedback"
            placeholder="e.g. Never open with the source name — open with the payoff. No 'unlock' or 'game changer' even in quotes."
            rows={3}
            value={feedbackText}
            onChange={(event) => setFeedbackText(event.target.value)}
          />
          <button className="secondary" disabled={busy || !feedbackText.trim()} onClick={addSystemFeedback}><Busy active={busy} />Add feedback</button>
        </div>
      </div></>
      : !loadError ? <p className="empty">Loading prompt…</p> : null}
    </section>
  );
}
