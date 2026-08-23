import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { KnowledgeEntry, KnowledgeKind, PanelProps } from "../types.js";
import { Busy, InlineError, PanelIcon, errorMessage } from "./Feedback.js";

const KINDS: Array<{ label: string; value: KnowledgeKind }> = [
  { value: "product_fact", label: "Product fact" },
  { value: "feature", label: "Feature" },
  { value: "pricing", label: "Pricing" },
  { value: "persona", label: "Persona" },
  { value: "opinion_stance", label: "Opinion / stance" },
  { value: "audience", label: "Audience" },
  { value: "faq", label: "FAQ / support answer" },
  { value: "never_claim", label: "Never claim" }
];

const KIND_LABEL: Record<KnowledgeKind, string> = Object.fromEntries(
  KINDS.map((item) => [item.value, item.label])
) as Record<KnowledgeKind, string>;

export function KnowledgePanel({ panel }: { panel: PanelProps }) {
  const { busy, run, accountId, refreshToken, reportError } = panel;
  const [entries, setEntries] = useState<KnowledgeEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<KnowledgeKind>("product_fact");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  useEffect(() => {
    let active = true;
    setLoadError(null);
    void api<{ entries: KnowledgeEntry[] }>(`/knowledge?accountId=${encodeURIComponent(accountId)}`)
      .then((result) => {
        if (active) setEntries(result.entries);
      })
      .catch((error) => {
        if (active) setLoadError(errorMessage(error, "Knowledge unavailable"));
      });
    return () => {
      active = false;
    };
  }, [accountId, refreshToken]);

  function addEntry() {
    if (!title.trim() || !content.trim()) return;
    run(async () => {
      await api("/knowledge", {
        method: "POST",
        body: JSON.stringify({ accountId, kind, title: title.trim(), content: content.trim() })
      });
      setTitle("");
      setContent("");
      const result = await api<{ entries: KnowledgeEntry[] }>(`/knowledge?accountId=${encodeURIComponent(accountId)}`);
      setEntries(result.entries);
    });
  }

  function toggleEnabled(entry: KnowledgeEntry) {
    run(async () => {
      await api(`/knowledge/${entry.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled: !entry.enabled })
      });
      setEntries((current) => current.map((item) => (item.id === entry.id ? { ...item, enabled: !item.enabled } : item)));
    });
  }

  function deleteEntry(entry: KnowledgeEntry) {
    if (!window.confirm(`Delete "${entry.title}"?`)) return;
    run(async () => {
      try {
        await api(`/knowledge/${entry.id}`, { method: "DELETE" });
        setEntries((current) => current.filter((item) => item.id !== entry.id));
      } catch (caught) {
        reportError(caught, "Delete failed");
      }
    });
  }

  return (
    <section className="panel settings">
      <div className="panel-head">
        <h2 className="panel-title"><PanelIcon name="layers" />Knowledge base</h2>
        <span className="pill">{entries.filter((entry) => entry.enabled).length} active</span>
      </div>
      <InlineError message={loadError} />
      <p className="empty">Verified facts injected into every draft for this account. Product facts for a brand handle, persona and stances for a personal one.</p>
      {entries.length ? (
        <ul className="feedback-list">
          {entries.map((entry) => (
            <li key={entry.id} className={entry.enabled ? "" : "disabled"}>
              <label className="checkbox-row switch-row">
                <input
                  aria-label={`${entry.enabled ? "Disable" : "Enable"} ${entry.title}`}
                  checked={entry.enabled}
                  disabled={busy}
                  type="checkbox"
                  onChange={() => toggleEnabled(entry)}
                />
                <span aria-hidden="true" className="switch" />
              </label>
              <span>
                <strong>{entry.title}</strong> <small className="pill">{KIND_LABEL[entry.kind]}</small>
                <br />
                {entry.content}
              </span>
              <button className="secondary danger compact-button" disabled={busy} onClick={() => deleteEntry(entry)}>Remove</button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">No knowledge entries yet.</p>
      )}
      <div className="source-actions">
        <select aria-label="Knowledge kind" value={kind} onChange={(event) => setKind(event.target.value as KnowledgeKind)}>
          {KINDS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
        </select>
        <input
          aria-label="Knowledge title"
          maxLength={200}
          placeholder="Short title, e.g. Export to CSV"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
        <textarea
          aria-label="Knowledge content"
          placeholder="The fact as you'd want it used. e.g. Exports include all fields, run server-side, available on every plan."
          rows={3}
          value={content}
          onChange={(event) => setContent(event.target.value)}
        />
        <button className="secondary" disabled={busy || !title.trim() || !content.trim()} onClick={addEntry}>
          <Busy active={busy} />Add knowledge
        </button>
      </div>
    </section>
  );
}
