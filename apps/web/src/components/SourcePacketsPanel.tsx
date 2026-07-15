import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { DraftResponse, PanelProps, SourcePacket } from "../types.js";
import { tweetTypeOptions } from "../types.js";
import { Busy, InlineError, PanelIcon, StatusBadge, errorMessage } from "./Feedback.js";

export interface SourcePacketsState {
  setDraft: (draft: DraftResponse | null) => void;
  setEditedText: (text: string) => void;
}

export function SourcePacketsPanel({ panel, state }: { panel: PanelProps; state: SourcePacketsState }) {
  const { accountId, busy, refresh, refreshToken, run } = panel;
  const { setDraft, setEditedText } = state;
  const [sourcePackets, setSourcePackets] = useState<SourcePacket[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [packetDraft, setPacketDraft] = useState({
    facts: "", sourceType: "manual", summary: "", title: "", tweetType: "useful_info", url: ""
  });

  async function loadSourcePackets() {
    setLoadError(null);
    const { packets } = await api<{ packets: SourcePacket[] }>(`/source-packets?accountId=${encodeURIComponent(accountId)}`);
    setSourcePackets(packets);
  }

  useEffect(() => {
    void loadSourcePackets().catch((error) => setLoadError(errorMessage(error, "Source packets unavailable")));
  }, [accountId, refreshToken]);

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
      await refresh();
    });
  }

  function draftFromSourcePacket(packet: SourcePacket) {
    run(async () => {
      const response = await api<DraftResponse & { packet: SourcePacket }>(`/source-packets/${packet.id}/draft`, { method: "POST" });
      setDraft({ draft: response.draft, candidates: response.candidates });
      setEditedText(response.candidates[0]?.text ?? "");
      await refresh();
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
        <h2 className="panel-title"><PanelIcon name="inbox" />Sources</h2>
        <div className="panel-head-actions">
          <span>{sourcePackets.length}</span>
          <button className="secondary danger compact-button" disabled={busy || sourcePackets.length === 0} onClick={deleteAllSources}><Busy active={busy} />Delete all</button>
        </div>
      </div>
      <InlineError message={loadError} />
      <div className="source-layout">
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
              <div className="source-actions">
                <button className="secondary" disabled={busy || packet.status === "drafted"} onClick={() => draftFromSourcePacket(packet)}><Busy active={busy} />Draft</button>
                <button className="secondary danger" disabled={busy || packet.status !== "drafted"} onClick={() => deleteDraftFromSourcePacket(packet)}><Busy active={busy} />Delete draft</button>
                <button className="secondary danger" disabled={busy} onClick={() => deleteSourcePacket(packet)}><Busy active={busy} />Delete source</button>
              </div>
            </article>
          )) : <p className="empty">Manual, news, feed, bookmark, note, and guide packets appear here.</p>}
        </div>
      </div>
    </section>
  );
}
