import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Attempt, Job, PanelProps } from "../types.js";
import { Busy, InlineError, StatusBadge, errorMessage } from "./Feedback.js";

export function JobsPanel({ panel }: { panel: PanelProps }) {
  const { accountId, busy, refresh, refreshToken, run } = panel;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [attemptsByJob, setAttemptsByJob] = useState<Record<string, Attempt[]>>({});
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  async function loadJobs() {
    setLoadError(null);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const { jobs: loadedJobs } = await api<{ jobs: Job[] }>(`/jobs?accountId=${encodeURIComponent(accountId)}`);
    const attemptsEntries = await Promise.all(loadedJobs.map(async (job) => {
      const { attempts } = await api<{ attempts: Attempt[] }>(`/jobs/${job.id}/attempts`);
      return [job.id, attempts] as const;
    }));
    if (requestId !== requestIdRef.current) return;
    const availableJobIds = new Set(loadedJobs.map((job) => job.id));
    setJobs(loadedJobs);
    setAttemptsByJob(Object.fromEntries(attemptsEntries));
    setSelectedJobIds((current) => current.filter((id) => availableJobIds.has(id)));
  }

  useEffect(() => {
    void loadJobs().catch((error) => setLoadError(errorMessage(error, "Jobs unavailable")));
  }, [accountId, refreshToken]);

  function prepareJob(job: Job) { run(async () => { await api(`/jobs/${job.id}/prepare`, { method: "POST" }); await refresh(); }); }
  function postJob(job: Job) { run(async () => { await api(`/jobs/${job.id}/post`, { method: "POST" }); await refresh(); }); }
  function deleteJob(job: Job) { run(async () => { await api(`/jobs/${job.id}`, { method: "DELETE" }); await refresh(); }); }
  function postAllReadyJobs() {
    run(async () => {
      const result = await api<{ failed: number; posted: number; total: number }>("/jobs/post-ready", {
        method: "POST", body: JSON.stringify({ accountId })
      });
      await refresh();
      if (result.failed > 0) throw new Error(`Post all finished: ${result.posted}/${result.total} posted, ${result.failed} failed.`);
    });
  }
  function deleteCleanupJobs() { run(async () => { await api("/jobs/cleanup", { method: "DELETE" }); await refresh(); }); }
  function deleteAllJobs() {
    run(async () => {
      if (window.confirm("Delete ALL jobs?")) {
        await api(`/jobs?accountId=${encodeURIComponent(accountId)}`, { method: "DELETE" });
        await refresh();
      }
    });
  }
  function prepareAllReadyJobs() {
    run(async () => {
      const now = Date.now();
      const readyJobs = jobs.filter((job) => job.accountId === accountId &&
        (job.status === "approved" || job.status === "failed") &&
        (!job.scheduledFor || Date.parse(job.scheduledFor) <= now));
      for (const job of readyJobs) await api(`/jobs/${job.id}/prepare`, { method: "POST" });
      await refresh();
    });
  }
  function toggleJobSelection(jobId: string) {
    setSelectedJobIds((current) => current.includes(jobId) ? current.filter((id) => id !== jobId) : [...current, jobId]);
  }
  function deleteSelectedJobs() {
    run(async () => {
      const selected = jobs.filter((job) => selectedJobIds.includes(job.id) && job.accountId === accountId);
      for (const job of selected) {
        if (job.status === "failed" || job.status === "prepared") await api(`/jobs/${job.id}`, { method: "DELETE" });
      }
      setSelectedJobIds([]);
      await refresh();
    });
  }

  const accountJobs = jobs.filter((job) => job.accountId === accountId);
  const nowMs = Date.now();
  const scheduledLaterJobs = accountJobs.filter((job) => Boolean(job.scheduledFor) && Date.parse(job.scheduledFor ?? "") > nowMs);
  const failedJobs = accountJobs.filter((job) => job.status === "failed");
  const postedJobs = accountJobs.filter((job) => job.status === "posted");
  const readyNowJobs = accountJobs.filter((job) => (job.status === "approved" || job.status === "prepared") &&
    (!job.scheduledFor || Date.parse(job.scheduledFor) <= nowMs));
  const otherJobs = accountJobs.filter((job) =>
    !readyNowJobs.some((item) => item.id === job.id) && !scheduledLaterJobs.some((item) => item.id === job.id) &&
    !failedJobs.some((item) => item.id === job.id) && !postedJobs.some((item) => item.id === job.id));
  const selectedDeletableJobs = accountJobs.filter((job) => selectedJobIds.includes(job.id) && (job.status === "failed" || job.status === "prepared"));
  const readyForBulkPrepare = accountJobs.filter((job) => (job.status === "approved" || job.status === "failed") &&
    (!job.scheduledFor || Date.parse(job.scheduledFor) <= nowMs));

  return (
    <section className="panel queue">
      <div className="panel-head"><h2>Jobs</h2><span>{jobs.length}</span></div>
      <InlineError message={loadError} />
      <div className="job-dashboard">
        <span>ready now {readyNowJobs.length}</span><span>scheduled later {scheduledLaterJobs.length}</span>
        <span>failed {failedJobs.length}</span><span>posted {postedJobs.length}</span>
      </div>
      {readyNowJobs.length || failedJobs.length ? <button className="secondary queue-action" disabled={busy} onClick={postAllReadyJobs}><Busy active={busy} />Post all ready</button> : null}
      {readyForBulkPrepare.length ? <button className="secondary queue-action" disabled={busy} onClick={prepareAllReadyJobs}><Busy active={busy} />Prepare all ready</button> : null}
      {postedJobs.length || failedJobs.length ? <button className="secondary queue-action" disabled={busy} onClick={deleteCleanupJobs}><Busy active={busy} />Cleanup</button> : null}
      {accountJobs.length ? <button className="secondary danger queue-action" disabled={busy} onClick={deleteAllJobs}><Busy active={busy} />Delete all</button> : null}
      {selectedDeletableJobs.length ? <button className="secondary danger queue-action" disabled={busy} onClick={deleteSelectedJobs}><Busy active={busy} />Delete selected failed/prepared ({selectedDeletableJobs.length})</button> : null}
      {selectedJobIds.length ? <button className="secondary queue-action" disabled={busy} onClick={() => setSelectedJobIds([])}>Clear selection ({selectedJobIds.length})</button> : null}
      {accountJobs.length ? (
        <div className="job-buckets">
          {[
            { title: "Ready now", jobs: readyNowJobs }, { title: "Scheduled later", jobs: scheduledLaterJobs },
            { title: "Failed", jobs: failedJobs }, { title: "Posted", jobs: postedJobs }, { title: "Other", jobs: otherJobs }
          ].map((bucket) => (
            <section className="job-bucket" key={bucket.title}>
              <div className="panel-head"><h3>{bucket.title}</h3><span>{bucket.jobs.length}</span></div>
              {bucket.jobs.length ? (
                <div className="job-list">
                  {bucket.jobs.map((job) => (
                    <article className="job" key={job.id}>
                      <div>
                        <strong>{job.id}</strong>
                        <span>{job.scheduledFor ? `${job.mode} · ${new Date(job.scheduledFor).toLocaleString()}` : job.mode}</span>
                        {job.replyTo ? <span className="reply-tag">reply → @{job.replyTo.authorHandle}</span> : null}
                      </div>
                      <StatusBadge status={job.status} />
                      <label className="checkbox-row job-select">
                        <input checked={selectedJobIds.includes(job.id)} type="checkbox" onChange={() => toggleJobSelection(job.id)} />Select
                      </label>
                      <div className="job-actions">
                        <button className="secondary" disabled={(job.status !== "approved" && job.status !== "failed") || busy} onClick={() => prepareJob(job)}><Busy active={busy} />Prepare</button>
                        <button className="secondary" disabled={(job.status !== "approved" && job.status !== "prepared" && job.status !== "failed") || busy} onClick={() => postJob(job)}><Busy active={busy} />Post</button>
                        <button className="secondary danger" disabled={job.status === "running" || busy} onClick={() => deleteJob(job)}><Busy active={busy} />Delete</button>
                      </div>
                      {attemptsByJob[job.id]?.length ? <div className="attempts">{attemptsByJob[job.id]?.map((attempt) => (
                        <p key={attempt.id}><strong>{attempt.status}</strong>{attempt.errorMessage ? `: ${attempt.errorMessage}` : ""}{attempt.screenshotPath ? ` Screenshot: ${attempt.screenshotPath}` : ""}{attempt.tracePath ? ` Trace: ${attempt.tracePath}` : ""}</p>
                      ))}</div> : <p className="empty attempts-empty">No run history.</p>}
                    </article>
                  ))}
                </div>
              ) : <p className="empty">No jobs.</p>}
            </section>
          ))}
        </div>
      ) : <p className="empty">No jobs for selected account.</p>}
    </section>
  );
}
