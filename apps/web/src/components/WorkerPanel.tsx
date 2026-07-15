import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { IngestRun, PanelProps, WorkerStatus } from "../types.js";
import { Busy, InlineError, StatusBadge, errorMessage } from "./Feedback.js";

export function WorkerPanel({ panel }: { panel: PanelProps }) {
  const { accountId, busy, refreshToken, run } = panel;
  const [ingestRuns, setIngestRuns] = useState<IngestRun[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);

  async function loadWorkerPanel() {
    setLoadError(null);
    const [status, { runs }] = await Promise.all([
      api<WorkerStatus>("/worker/status"),
      api<{ runs: IngestRun[] }>(`/ingest-runs?accountId=${encodeURIComponent(accountId)}`)
    ]);
    setWorkerStatus(status);
    setIngestRuns(runs);
  }

  useEffect(() => {
    void loadWorkerPanel().catch((error) => setLoadError(errorMessage(error, "Worker status unavailable")));
  }, [accountId, refreshToken]);

  return (
    <section className="panel worker-panel">
      <div className="panel-head">
        <div>
          <h2>Worker</h2>
          <p className="empty">
            Last heartbeat {workerStatus?.lastHeartbeatAt ? new Date(workerStatus.lastHeartbeatAt).toLocaleString() : "never"}
          </p>
        </div>
        <div className="panel-head-actions">
          <span className={workerStatus?.workerRunning ? "provider-pill" : "session-pill failed"}>
            {workerStatus?.workerRunning ? "running" : "offline"}
          </span>
          <button className="secondary compact-button" disabled={busy} onClick={() => run(panel.refresh)}>
            <Busy active={busy} />Refresh
          </button>
        </div>
      </div>
      <InlineError message={loadError} />
      <p className={workerStatus?.lastError ? "worker-error" : "empty"}>
        Last error: {workerStatus?.lastError ?? "none"}
      </p>
      <div className="ingest-run-list">
        {ingestRuns.length ? (
          ingestRuns.slice(0, 5).map((ingestRun) => (
            <article className="ingest-run" key={ingestRun.id}>
              <div>
                <strong>{new Date(ingestRun.startedAt).toLocaleString()}</strong>
                <span>{ingestRun.packetsCreated} packets created</span>
              </div>
              <StatusBadge status={ingestRun.status} />
              {ingestRun.error ? <p>{ingestRun.error}</p> : null}
            </article>
          ))
        ) : (
          <p className="empty">No ingest runs for this account.</p>
        )}
      </div>
    </section>
  );
}
