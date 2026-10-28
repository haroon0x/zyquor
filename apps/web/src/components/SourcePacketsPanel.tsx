import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { DraftResponse, PanelProps, SourcePacket } from "../types.js";
import { tweetTypeOptions } from "../types.js";
import { Busy, InlineError, PanelIcon, StatusBadge, errorMessage } from "./Feedback.js";

const PACKETS_POLL_MS = 5000;

export interface SourcePacketsState {
  setDraft: (draft: DraftResponse | null) => void;
  setEditedText: (text: string) => void;
}

export function ManualSourcePanel({ panel }: { panel: PanelProps }) {
  const { accountId, busy, refresh, run } = panel;
  const [expanded, setExpanded] = useState(false);
  const [packetDraft, setPacketDraft] = useState({
    facts: "", sourceType: "manual", summary: "", title: "", tweetType: "useful_info", url: ""
  });

  function createSourcePacket() {
    run(async () => {
      await api<{ packet: SourcePacket }>("/source-packets", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          facts: packetDraft.facts.split(/\n+/).map((line) => line.trim()).filter(Boolean),
          sourceType: packetDraft.sourceType,
          summary: packetDraft.summary,
          title: packetDraft.title,
          tweetType: packetDraft.tweetType,
          url: packetDraft.url.trim() || null
        })
      });
      setPacketDraft({ ...packetDraft, facts: "", summary: "", title: "", url: "" });
      setExpanded(false);
      await refresh();
    });
  }

  return (
    <section className="panel manual-source-panel">
      <div className="panel-head">
        <div>
          <h2 className="panel-title"><PanelIcon name="inbox" />Sources</h2>
          <p className="empty">Add a one-off source alongside the automatic feed.</p>
        </div>
        <button className="secondary compact-button" type="button" onClick={() => setExpanded((current) => !current)}>
          {expanded ? "Close" : "Add manual source"}
        </button>
      </div>
      {expanded ? (
        <form className="source-form" onSubmit={(event) => { event.preventDefault(); createSourcePacket(); }}>
          <div className="settings-grid">
            <label>
              Source
              <select value={packetDraft.sourceType} onChange={(event) => setPacketDraft({ ...packetDraft, sourceType: event.target.value })}>
                <option value="manual">manual</option>
                <option value="news">news</option>
                <option value="feed">feed</option>
                <option value="bookmark">bookmark</option>
                <option value="note">note</option>
                <option value="guide">guide</option>
                <option value="job">job</option>
              </select>
            </label>
            <label>
              Type
              <select value={packetDraft.tweetType} onChange={(event) => setPacketDraft({ ...packetDraft, tweetType: event.target.value })}>
                {tweetTypeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label>Title<input value={packetDraft.title} onChange={(event) => setPacketDraft({ ...packetDraft, title: event.target.value })} /></label>
            <label>URL<input value={packetDraft.url} onChange={(event) => setPacketDraft({ ...packetDraft, url: event.target.value })} /></label>
            <label>Summary<textarea value={packetDraft.summary} onChange={(event) => setPacketDraft({ ...packetDraft, summary: event.target.value })} rows={3} /></label>
            <label>Facts<textarea value={packetDraft.facts} onChange={(event) => setPacketDraft({ ...packetDraft, facts: event.target.value })} placeholder="One fact per line" rows={5} /></label>
          </div>
          <button disabled={!packetDraft.title.trim() || !packetDraft.summary.trim() || busy}><Busy active={busy} />Create source</button>
        </form>
      ) : null}
    </section>
  );
}

export function SourcePacketsPanel({ panel, state }: { panel: PanelProps; state: SourcePacketsState }) {
  const { accountId, busy, refresh, refreshToken, run } = panel;
  const { setDraft, setEditedText } = state;
  const [sourcePackets, setSourcePackets] = useState<SourcePacket[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedbackDraft, setFeedbackDraft] = useState<Record<string, string>>({});

  async function loadSourcePackets() {
    setLoadError(null);
    const { packets } = await api<{ packets: SourcePacket[] }>(`/source-packets?accountId=${encodeURIComponent(accountId)}`);
    setSourcePackets(packets);
  }

  useEffect(() => {
    void loadSourcePackets().catch((error) => setLoadError(errorMessage(error, "Source packets unavailable")));
  }, [accountId, refreshToken]);

  // Ingest creates and drafts packets in the background; poll so the list keeps up.
  // Skipped while an action is in flight or the tab is hidden, and refreshed as
  // soon as the tab becomes visible again.
  useEffect(() => {
    if (busy) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void loadSourcePackets().catch(() => undefined);
    }, PACKETS_POLL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden && !busy) void loadSourcePackets().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [accountId, busy]);

  function draftFromSourcePacket(packet: SourcePacket) {
    run(async () => {
      const response = await api<DraftResponse & { packet: SourcePacket }>(`/source-packets/${packet.id}/draft`, { method: "POST" });
      setDraft({ draft: response.draft, candidates: response.candidates });
      setEditedText(response.candidates[0]?.text ?? "");
      await refresh();
      window.location.hash = "compose";
    });
  }

  function reviewSourcePacket(packet: SourcePacket) {
    run(async () => {
      const response = await api<DraftResponse>(`/source-packets/${packet.id}/draft`);
      setDraft({ draft: response.draft, candidates: response.candidates });
      setEditedText(response.draft.editedText ?? response.candidates[0]?.text ?? "");
      await refresh();
      window.location.hash = "compose";
    });
  }

  function setPacketFeedback(packet: SourcePacket, feedback: string) {
    run(async () => {
      await api(`/source-packets/${packet.id}/feedback`, {
        method: "POST",
        body: JSON.stringify({ feedback: feedback.trim() || null })
      });
      setFeedbackDraft(({ [packet.id]: _cleared, ...rest }) => rest);
      await refresh();
    });
  }

  function regenerateSourcePacket(packet: SourcePacket) {
    run(async () => {
      const response = await api<DraftResponse & { packet: SourcePacket }>(`/source-packets/${packet.id}/regenerate`, {
        method: "POST",
        body: JSON.stringify({ feedback: feedbackDraft[packet.id]?.trim() || packet.feedback?.trim() || null })
      });
      setDraft({ draft: response.draft, candidates: response.candidates });
      setEditedText(response.candidates[0]?.text ?? "");
      setFeedbackDraft(({ [packet.id]: _cleared, ...rest }) => rest);
      await refresh();
      window.location.hash = "compose";
    });
  }

  function deleteDraftFromSourcePacket(packet: SourcePacket) {
    run(async () => {
      if (packet.status === "drafted" && window.confirm("Delete generated draft and reset this source?")) {
        await api(`/source-packets/${packet.id}/draft`, { method: "DELETE" });
        setDraft(null);
        setEditedText("");
        await refresh();
      }
    });
  }

  function deleteSourcePacket(packet: SourcePacket) {
    run(async () => {
      if (window.confirm("Delete this source? Non-posted source drafts will be removed too.")) {
        await api(`/source-packets/${packet.id}`, { method: "DELETE" });
        setDraft(null);
        setEditedText("");
        await refresh();
      }
    });
  }

  function deleteAllSources() {
    run(async () => {
      if (sourcePackets.length > 0 && window.confirm("Delete all sources for this account? Non-posted source drafts will be removed too.")) {
        await api(`/source-packets?accountId=${encodeURIComponent(accountId)}`, { method: "DELETE" });
        setDraft(null);
        setEditedText("");
        await refresh();
      }
    });
  }

  return (
    <section className="panel source-packets">
      <div className="panel-head">
        <div>
          <h2 className="panel-title"><PanelIcon name="layers" />Source packets</h2>
          <p className="empty">Review packets and turn the strongest ones into drafts.</p>
        </div>
        <div className="panel-head-actions">
          <span>{sourcePackets.length}</span>
          <button className="secondary danger compact-button" disabled={busy || sourcePackets.length === 0} onClick={deleteAllSources}><Busy active={busy} />Delete all</button>
        </div>
      </div>
      <InlineError message={loadError} />
      <div className="source-list">
        {sourcePackets.length ? sourcePackets.map((packet) => (
          <article className="source-card" key={packet.id}>
            <div className="source-meta">
              <strong>{packet.title}</strong>
              <span>{packet.sourceType} · {packet.tweetType}</span>
              <StatusBadge status={packet.status} />
            </div>
            <p>{packet.summary}</p>
            {packet.facts.length ? <ul>{packet.facts.slice(0, 3).map((fact) => <li key={fact}>{fact}</li>)}</ul> : null}
            {packet.status === "drafted" ? (
              <div className="source-feedback">
                <textarea
                  aria-label="Feedback for this post"
                  placeholder="What was wrong with the last draft? e.g. lead reads like a recap, drop the hype, lead with the mechanism."
                  rows={3}
                  value={feedbackDraft[packet.id] ?? packet.feedback ?? ""}
                  onChange={(event) => setFeedbackDraft({ ...feedbackDraft, [packet.id]: event.target.value })}
                />
                <div className="source-actions">
                  <button className="ghost" disabled={busy || !feedbackDraft[packet.id]?.trim()} onClick={() => setPacketFeedback(packet, feedbackDraft[packet.id] ?? "")}><Busy active={busy} />Save note</button>
                </div>
              </div>
            ) : null}
            <div className="source-actions">
              <button className="secondary" disabled={busy || packet.status === "drafted"} onClick={() => draftFromSourcePacket(packet)}><Busy active={busy} />Draft</button>
              {packet.status === "drafted" ? <button className="secondary" disabled={busy} onClick={() => reviewSourcePacket(packet)}><Busy active={busy} />Review</button> : null}
              {packet.status === "drafted" ? <button className="secondary" disabled={busy || !(feedbackDraft[packet.id]?.trim() || packet.feedback?.trim())} onClick={() => regenerateSourcePacket(packet)}><Busy active={busy} />Regenerate</button> : null}
              {packet.status === "drafted" ? <button className="secondary danger" disabled={busy} onClick={() => deleteDraftFromSourcePacket(packet)}><Busy active={busy} />Delete draft</button> : null}
              <button className="secondary danger" disabled={busy} onClick={() => deleteSourcePacket(packet)}><Busy active={busy} />Delete source</button>
            </div>
          </article>
        )) : <p className="empty">No source packets yet.</p>}
      </div>
    </section>
  );
}
