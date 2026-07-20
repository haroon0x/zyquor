import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { IngestConfig, PanelProps } from "../types.js";
import { tweetTypeOptions } from "../types.js";
import { Busy, InlineError, PanelIcon, errorMessage } from "./Feedback.js";

function draftFromIngestConfig(config: IngestConfig | null) {
  const usefulWeight = config?.tweetTypeMix.useful_info ?? 0;
  const topTweetType = config && Object.keys(config.tweetTypeMix).length
    ? Object.entries(config.tweetTypeMix).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "useful_info"
    : "useful_info";
  return {
    enabled: config?.enabled ?? false,
    feedUrl: typeof config?.metadata.feedUrl === "string" ? config.metadata.feedUrl : "",
    maxPacketsPerDay: config?.maxPacketsPerDay ?? 10,
    scheduleWindowEnd: config?.scheduleWindowEnd ?? "23:59",
    scheduleWindowStart: config?.scheduleWindowStart ?? "00:00",
    sourceType: config?.sourceType ?? "news",
    tweetType: usefulWeight > 0 ? "useful_info" : topTweetType
  };
}

export function AutomationPanel({ panel }: { panel: PanelProps }) {
  const { accountId, busy, refresh, refreshToken, run } = panel;
  const [ingestConfigs, setIngestConfigs] = useState<IngestConfig[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [automationDraft, setAutomationDraft] = useState(draftFromIngestConfig(null));

  async function loadConfig() {
    setLoadError(null);
    const { configs } = await api<{ configs: IngestConfig[] }>(`/ingest-configs?accountId=${encodeURIComponent(accountId)}`);
    setIngestConfigs(configs);
    setAutomationDraft(draftFromIngestConfig(configs[0] ?? null));
  }

  useEffect(() => {
    void loadConfig().catch((error) => setLoadError(errorMessage(error, "Automation unavailable")));
  }, [accountId, refreshToken]);

  function saveAutomationConfig() {
    run(async () => {
      const existing = ingestConfigs[0] ?? null;
      const payload = {
        accountId,
        enabled: automationDraft.enabled,
        maxPacketsPerDay: automationDraft.maxPacketsPerDay,
        metadata: automationDraft.sourceType === "feed" ? { feedUrl: automationDraft.feedUrl.trim() } : {},
        scheduleWindowEnd: automationDraft.scheduleWindowEnd,
        scheduleWindowStart: automationDraft.scheduleWindowStart,
        sourceType: automationDraft.sourceType,
        tweetTypeMix: { [automationDraft.tweetType]: 100 }
      };
      if (existing) await api(`/ingest-configs/${existing.id}`, { method: "PATCH", body: JSON.stringify(payload) });
      else await api("/ingest-configs", { method: "POST", body: JSON.stringify(payload) });
      await refresh();
    });
  }

  function toggleAutomation() {
    const existing = ingestConfigs[0] ?? null;
    const nextEnabled = !automationDraft.enabled;
    setAutomationDraft({ ...automationDraft, enabled: nextEnabled });
    run(async () => {
      if (existing) {
        await api(`/ingest-configs/${existing.id}`, { method: "PATCH", body: JSON.stringify({ enabled: nextEnabled }) });
      } else {
        await api("/ingest-configs", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            enabled: nextEnabled,
            maxPacketsPerDay: automationDraft.maxPacketsPerDay,
            metadata: automationDraft.sourceType === "feed" ? { feedUrl: automationDraft.feedUrl.trim() } : {},
            scheduleWindowEnd: automationDraft.scheduleWindowEnd,
            scheduleWindowStart: automationDraft.scheduleWindowStart,
            sourceType: automationDraft.sourceType,
            tweetTypeMix: { [automationDraft.tweetType]: 100 }
          })
        });
      }
      await refresh();
    });
  }

  function runAutomationNow() {
    run(async () => {
      const result = await api<{ processed: number }>("/ingest-run", { method: "POST" });
      await refresh();
      if (result.processed === 0) throw new Error("Automation ran, but no new eligible source items were found.");
    });
  }

  return (
    <section className="panel automation">
      <div className="panel-head">
        <div>
          <h2 className="panel-title"><PanelIcon name="zap" />Automatic Poster</h2>
          <p className="empty">Live sources create clean autopost jobs. Disable anytime.</p>
        </div>
        <span className={automationDraft.enabled ? "pill pill--succeeded" : "pill pill--pending"}>
          {automationDraft.enabled ? "enabled" : "disabled"}
        </span>
      </div>
      <InlineError message={loadError} />
      <div className="automation-grid">
        <label className="checkbox-row switch-row">
          <input checked={automationDraft.enabled} disabled={busy} type="checkbox" onChange={toggleAutomation} />
          <span aria-hidden="true" className="switch" />
          Auto ingest and post
        </label>
        <label>
          Live source
          <select value={automationDraft.sourceType} onChange={(event) => setAutomationDraft({ ...automationDraft, sourceType: event.target.value })}>
            <option value="news">Aggregated tech/news</option>
            <option value="feed">RSS feed URL</option>
          </select>
        </label>
        {automationDraft.sourceType === "feed" ? (
          <label className="wide-field">
            RSS feed URL
            <input placeholder="https://example.com/feed.xml" value={automationDraft.feedUrl} onChange={(event) => setAutomationDraft({ ...automationDraft, feedUrl: event.target.value })} />
          </label>
        ) : null}
        <label>
          Tweet style
          <select value={automationDraft.tweetType} onChange={(event) => setAutomationDraft({ ...automationDraft, tweetType: event.target.value })}>
            {tweetTypeOptions.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </label>
        <label>
          Daily max
          <input min="1" max="10" type="number" value={automationDraft.maxPacketsPerDay} onChange={(event) => setAutomationDraft({ ...automationDraft, maxPacketsPerDay: Math.min(10, Math.max(1, Number(event.target.value))) })} />
        </label>
        <div className="time-grid wide-field">
          <label>
            Start
            <input type="time" value={automationDraft.scheduleWindowStart} onChange={(event) => setAutomationDraft({ ...automationDraft, scheduleWindowStart: event.target.value })} />
          </label>
          <label>
            End
            <input type="time" value={automationDraft.scheduleWindowEnd} onChange={(event) => setAutomationDraft({ ...automationDraft, scheduleWindowEnd: event.target.value })} />
          </label>
        </div>
      </div>
      <div className="automation-actions">
        <button disabled={busy || (automationDraft.sourceType === "feed" && !automationDraft.feedUrl.trim())} onClick={saveAutomationConfig}><Busy active={busy} />Save automation</button>
        <button className="secondary" disabled={busy || !automationDraft.enabled || (automationDraft.sourceType === "feed" && !automationDraft.feedUrl.trim())} onClick={runAutomationNow}><Busy active={busy} />Run now</button>
      </div>
    </section>
  );
}
