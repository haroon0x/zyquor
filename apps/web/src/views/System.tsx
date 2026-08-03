import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { Busy, InlineError, PanelIcon, errorMessage } from "../components/Feedback.js";
import type { PanelProps, SystemStatus } from "../types.js";

const STATUS_POLL_MS = 3000;
const LOG_POLL_MS = 2000;

function relativeTime(timestamp: string | null) {
  if (!timestamp) return "never";
  const deltaMs = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(deltaMs)) return "never";
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return new Date(timestamp).toLocaleString();
}

function uptime(startedAt: string | undefined) {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function logLevel(line: string) {
  if (/\[error\]/i.test(line)) return "log-line error";
  if (/\[warn\]/i.test(line)) return "log-line warn";
  return "log-line";
}

export function SystemView({ panel }: { panel: PanelProps }) {
  const { accountId, busy, refresh, refreshToken, run } = panel;
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [logFilter, setLogFilter] = useState("");
  const [followLogs, setFollowLogs] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const logBoxRef = useRef<HTMLDivElement | null>(null);

  async function loadStatus() {
    setStatus(await api<SystemStatus>("/system/status"));
  }

  async function loadLogs() {
    const { lines } = await api<{ lines: string[] }>("/system/logs?lines=400");
    setLogs(lines);
  }

  useEffect(() => {
    const tick = () => void loadStatus().then(() => setLoadError(null)).catch((error) => setLoadError(errorMessage(error, "System status unavailable")));
    tick();
    const timer = setInterval(tick, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshToken]);

  useEffect(() => {
    const tick = () => void loadLogs().catch(() => undefined);
    tick();
    const timer = setInterval(tick, LOG_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!followLogs) return;
    const box = logBoxRef.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [logs, followLogs]);

  function act(action: () => Promise<string>) {
    run(async () => {
      setNotice(null);
      const message = await action();
      setNotice(message);
      await loadStatus();
      await refresh();
    });
  }

  function launchChrome() {
    act(async () => {
      const result = await api<{ launched: boolean; reason?: string }>("/browser/launch-chrome", {
        method: "POST",
        body: JSON.stringify({ accountId })
      });
      return result.launched ? "Chrome launched" : `Chrome not launched: ${result.reason ?? "unknown"}`;
    });
  }

  function closeChrome() {
    act(async () => {
      const result = await api<{ closed: boolean; reason?: string }>("/system/chrome/close", { method: "POST" });
      return result.closed ? "Chrome closed" : `Chrome not closed: ${result.reason ?? "unknown"}`;
    });
  }

  function setWorkerPaused(paused: boolean) {
    act(async () => {
      const result = await api<{ paused: boolean }>("/system/worker/pause", {
        method: "POST",
        body: JSON.stringify({ paused })
      });
      return result.paused ? "Worker paused" : "Worker resumed";
    });
  }

  function setPostingFlag(patch: { enablePost?: boolean; enablePrepare?: boolean; autoApproveSourcePackets?: boolean }) {
    act(async () => {
      const result = await api<{ enablePost: boolean; enablePrepare: boolean; autoApproveSourcePackets?: boolean }>("/system/posting", {
        method: "POST",
        body: JSON.stringify(patch)
      });
      return `Prepare ${result.enablePrepare ? "on" : "off"} · Post ${result.enablePost ? "on" : "off"} · Automated review ${result.autoApproveSourcePackets ? "off" : "on"}`;
    });
  }

  function runIngestNow() {
    act(async () => {
      await api("/ingest-run/async", { method: "POST", body: JSON.stringify({ accountId }) });
      return "Ingest run queued";
    });
  }

  function recoverStale() {
    act(async () => {
      const jobs = await api<{ recoveredCount: number }>("/jobs/recover-stale", {
        method: "POST",
        body: JSON.stringify({ accountId })
      });
      const runs = await api<{ recoveredCount: number }>("/ingest-runs/recover-stale", { method: "POST" });
      return `Recovered ${jobs.recoveredCount} job(s), ${runs.recoveredCount} ingest run(s)`;
    });
  }

  function cancelIngest() {
    act(async () => {
      await api("/system/ingest/cancel", { method: "POST" });
      return "Ingest cancel requested — it stops after the current source.";
    });
  }

  function stopEverything() {
    if (!window.confirm("Stop everything? This pauses the worker, turns off prepare and post, and closes the posting Chrome.")) return;
    act(async () => {
      const result = await api<{ chrome: { closed: boolean; reason?: string }; runningJobIds: string[] }>("/system/stop-all", { method: "POST" });
      const chromeNote = result.chrome.closed
        ? "Chrome closed"
        : result.chrome.reason === "job-running"
          ? `Chrome left open — job ${result.runningJobIds.join(", ")} is still posting`
          : `Chrome ${result.chrome.reason ?? "untouched"}`;
      return `Stopped. Worker paused, posting off, ${chromeNote}.`;
    });
  }

  function quitApp() {
    if (!window.confirm("Quit Zyquor? The API, worker and tray icon all shut down.")) return;
    act(async () => {
      await api("/system/quit", { method: "POST" });
      return "Quitting…";
    });
  }

  function restartApp() {
    if (!window.confirm("Restart Zyquor?")) return;
    act(async () => {
      await api("/system/restart", { method: "POST" });
      return "Restarting…";
    });
  }

  const isDesktop = Boolean(status?.desktop);
  const filteredLogs = logFilter
    ? logs.filter((line) => line.toLowerCase().includes(logFilter.toLowerCase()))
    : logs;
  const jobsByStatus = Object.entries(status?.counts.jobsByStatus ?? {});

  return (
    <div className="system-view">
      <InlineError message={loadError} />
      {notice ? <p className="notice">{notice}</p> : null}

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title"><PanelIcon name="activity" />Running now</h2>
            <p className="empty">Live view of every moving part. Refreshes every {STATUS_POLL_MS / 1000}s.</p>
          </div>
          <div className="panel-head-actions">
            <span className={status?.worker.running && !status.worker.paused ? "pill pill--succeeded" : "pill pill--failed"}>
              worker {status?.worker.paused ? "paused" : status?.worker.running ? "running" : "offline"}
            </span>
            <span className={status?.desktop?.chromeConnected ? "pill pill--succeeded" : "pill pill--failed"}>
              chrome {status?.desktop?.chromeConnected ? "connected" : "off"}
            </span>
            <span className={status?.posting.enablePost ? "pill pill--failed" : "pill pill--succeeded"}>
              post {status?.posting.enablePost ? "ARMED" : "off"}
            </span>
          </div>
        </div>
        <dl className="system-grid data-content">
          <div><dt>App version</dt><dd>{status?.desktop?.appVersion ?? "—"}</dd></div>
          <div><dt>Platform</dt><dd>{status?.desktop?.platform ?? "browser"}</dd></div>
          <div><dt>Uptime</dt><dd>{uptime(status?.desktop?.startedAt ?? status?.api.startedAt)}</dd></div>
          <div><dt>Generation</dt><dd>{status ? `${status.generation.provider} / ${status.generation.model}` : "—"}</dd></div>
          <div><dt>Prepare enabled</dt><dd>{status?.posting.enablePrepare ? "yes" : "no"}</dd></div>
          <div><dt>Post enabled</dt><dd>{status?.posting.enablePost ? "yes" : "no"}</dd></div>
          <div><dt>Automated posting</dt><dd>{status?.posting.autoApproveSourcePackets ? "sources auto-approve" : "review required"}</dd></div>
          <div><dt>Chrome CDP</dt><dd>{status?.desktop?.cdpUrl ?? status?.posting.cdpUrl ?? "—"}</dd></div>
          <div><dt>Chrome pid</dt><dd>{status?.desktop?.chromePid ?? "not launched by Zyquor"}</dd></div>
          <div><dt>Worker heartbeat</dt><dd>{relativeTime(status?.worker.lastHeartbeatAt ?? null)}</dd></div>
          <div><dt>Last ingest</dt><dd>{relativeTime(status?.worker.lastIngestAt ?? null)}</dd></div>
          <div><dt>Last post</dt><dd>{relativeTime(status?.worker.lastPostAt ?? null)}</dd></div>
          <div><dt>Ingest run</dt><dd>{status?.ingestRun.running ? `running · ${status.ingestRun.processed} processed` : `idle · last ${relativeTime(status?.ingestRun.lastStartedAt ?? null)}`}</dd></div>
          <div><dt>Enabled ingest configs</dt><dd>{status?.counts.ingestConfigsEnabled ?? "—"}</dd></div>
          <div><dt>Source packets</dt><dd>{status?.counts.sourcePackets ?? "—"}</dd></div>
          <div><dt>Pending drafts</dt><dd>{status?.counts.drafts ?? "—"}</dd></div>
          <div><dt>Running jobs</dt><dd>{status?.runningJobs.length ? status.runningJobs.map((job) => job.id).join(", ") : "none"}</dd></div>
          <div><dt>Jobs</dt><dd>{jobsByStatus.length ? jobsByStatus.map(([key, value]) => `${key} ${value}`).join(" · ") : status?.counts.jobs ?? "—"}</dd></div>
          <div><dt>Data root</dt><dd className="system-path">{status?.desktop?.dataRoot ?? "—"}</dd></div>
          <div><dt>Log file</dt><dd className="system-path">{status?.desktop?.logPath ?? "—"}</dd></div>
        </dl>
        {status?.worker.lastError ? <p className="notice error">Worker error: {status.worker.lastError}</p> : null}
        {status?.ingestRun.errors.length ? (
          <p className="notice error">Ingest errors: {status.ingestRun.errors.map((entry) => `${entry.configId}: ${entry.error}`).join(" · ")}</p>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title"><PanelIcon name="settings" />Controls</h2>
            <p className="empty">Switches take effect at once. Pause and cancel stop the worker between items, never mid-post.</p>
          </div>
        </div>
        <div className="system-controls">
          <button className="secondary" disabled={busy} onClick={launchChrome}><Busy active={busy} />Launch Chrome</button>
          <button className="secondary" disabled={busy || !isDesktop} onClick={closeChrome}><Busy active={busy} />Close Chrome</button>
          <button className="secondary" disabled={busy || !isDesktop} onClick={() => setWorkerPaused(!status?.worker.paused)}>
            <Busy active={busy} />{status?.worker.paused ? "Resume worker" : "Pause worker"}
          </button>
          <button className="secondary" disabled={busy} onClick={runIngestNow}><Busy active={busy} />Run ingest now</button>
          <button className="secondary" disabled={busy || !status?.ingestRun.running} onClick={cancelIngest}><Busy active={busy} />Cancel ingest</button>
          <button className="secondary" disabled={busy} onClick={recoverStale}><Busy active={busy} />Recover stale</button>
          <button className="secondary" disabled={busy} onClick={() => setPostingFlag({ enablePrepare: !status?.posting.enablePrepare })}>
            <Busy active={busy} />{status?.posting.enablePrepare ? "Disable prepare" : "Enable prepare"}
          </button>
          <button className={status?.posting.enablePost ? "secondary" : "ghost danger"} disabled={busy} onClick={() => setPostingFlag({ enablePost: !status?.posting.enablePost })}>
            <Busy active={busy} />{status?.posting.enablePost ? "Disable posting" : "Arm posting"}
          </button>
          <button className={status?.posting.autoApproveSourcePackets ? "secondary" : "ghost"} disabled={busy} onClick={() => setPostingFlag({ autoApproveSourcePackets: !status?.posting.autoApproveSourcePackets })}>
            <Busy active={busy} />{status?.posting.autoApproveSourcePackets ? "Automated posting: on" : "Automated posting: off"}
          </button>
        </div>
        <div className="system-controls system-controls--danger">
          <button className="danger stop-everything" disabled={busy} onClick={stopEverything}><Busy active={busy} />Stop everything</button>
          <button className="ghost" disabled={busy || !isDesktop} onClick={restartApp}><Busy active={busy} />Restart app</button>
          <button className="ghost danger" disabled={busy || !isDesktop} onClick={quitApp}><Busy active={busy} />Quit Zyquor</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title"><PanelIcon name="layers" />Activity log</h2>
            <p className="empty">{isDesktop ? "Tail of main.log — worker, browser, and app events." : "Available in the desktop app."}</p>
          </div>
          <div className="panel-head-actions">
            <input aria-label="Filter log" placeholder="filter" value={logFilter} onChange={(event) => setLogFilter(event.target.value)} />
            <label className="system-follow">
              <input checked={followLogs} type="checkbox" onChange={(event) => setFollowLogs(event.target.checked)} />
              follow
            </label>
          </div>
        </div>
        <div className="log-box" ref={logBoxRef}>
          {filteredLogs.length ? filteredLogs.map((line, index) => (
            <div className={logLevel(line)} key={`${index}-${line.slice(0, 24)}`}>{line}</div>
          )) : <p className="empty">No log lines yet.</p>}
        </div>
      </section>
    </div>
  );
}
