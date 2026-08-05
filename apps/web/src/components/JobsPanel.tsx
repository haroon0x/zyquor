import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Attempt, DraftResponse, Job, PanelProps } from "../types.js";
import { Busy, InlineError, StatusBadge, errorMessage } from "./Feedback.js";

type QueueFilter = "ready" | "scheduled" | "failed" | "posted";

const JOBS_POLL_MS = 5000;

interface JobDraftDetails {
  text: string;
  type: string;
}

function ActionIcon({ name }: { name: "prepare" | "post" | "delete" }) {
  const paths = {
    prepare: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 20h14" /></>,
    post: <><path d="m4 12 16-8-5 16-3-6-8-2Z" /><path d="m12 14 8-10" /></>,
    delete: <><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="m7 7 1 13h8l1-13" /></>
  };
  return <svg aria-hidden="true" className="action-icon" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" viewBox="0 0 24 24">{paths[name]}</svg>;
}

function jobFilter(job: Job, now: number): QueueFilter {
  if (job.status === "failed") return "failed";
  if (job.status === "posted") return "posted";
  if (job.scheduledFor && Date.parse(job.scheduledFor) > now) return "scheduled";
  return "ready";
}

function canRescheduleJob(job: Job) {
  return !["running", "posted", "failed", "cancelled"].includes(job.status);
}

function toDateTimeLocal(timestamp: string | null) {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function JobsPanel({ panel }: { panel: PanelProps }) {
  const { accountId, busy, refresh, refreshToken, run } = panel;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [attemptsByJob, setAttemptsByJob] = useState<Record<string, Attempt[]>>({});
  const [draftsByJob, setDraftsByJob] = useState<Record<string, JobDraftDetails>>({});
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [scheduleEdits, setScheduleEdits] = useState<Record<string, string>>({});
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("ready");
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  async function loadJobs() {
    setLoadError(null);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const { jobs: loadedJobs } = await api<{ jobs: Job[] }>(`/jobs?accountId=${encodeURIComponent(accountId)}`);
    const details = await Promise.all(loadedJobs.map(async (job) => {
      const [{ attempts }, draftResponse] = await Promise.all([
        api<{ attempts: Attempt[] }>(`/jobs/${job.id}/attempts`),
        api<DraftResponse>(`/drafts/${job.draftId}`)
      ]);
      const selectedCandidate = draftResponse.candidates.find((candidate) => candidate.selected);
      const text = draftResponse.draft.editedText ?? selectedCandidate?.text ?? draftResponse.candidates[0]?.text ?? draftResponse.draft.sourceInput;
      const metadataType = draftResponse.draft.metadata?.tweetType;
      const type = draftResponse.draft.replyTo ? "reply" : typeof metadataType === "string" ? metadataType : "—";
      return { jobId: job.id, attempts, draft: { text, type } };
    }));
    if (requestId !== requestIdRef.current) return;
    const availableJobIds = new Set(loadedJobs.map((job) => job.id));
    setJobs(loadedJobs);
    setAttemptsByJob(Object.fromEntries(details.map((detail) => [detail.jobId, detail.attempts])));
    setDraftsByJob(Object.fromEntries(details.map((detail) => [detail.jobId, detail.draft])));
    // Keep any schedule the user is currently typing; background polls must not clobber it.
    setScheduleEdits((current) =>
      Object.fromEntries(loadedJobs.map((job) => [job.id, current[job.id] ?? toDateTimeLocal(job.scheduledFor)]))
    );
    setSelectedJobIds((current) => current.filter((id) => availableJobIds.has(id)));
    setExpandedJobId((current) => current && availableJobIds.has(current) ? current : null);
  }

  useEffect(() => {
    void loadJobs().catch((error) => setLoadError(errorMessage(error, "Jobs unavailable")));
  }, [accountId, refreshToken]);

  // The worker changes job state every few seconds; without this the queue is
  // stale until the user clicks something. Paused while an action is in flight.
  useEffect(() => {
    if (busy) return;
    const timer = setInterval(() => void loadJobs().catch(() => undefined), JOBS_POLL_MS);
    return () => clearInterval(timer);
  }, [accountId, busy]);

  function prepareJob(job: Job) { run(async () => { await api(`/jobs/${job.id}/prepare`, { method: "POST" }); await refresh(); }); }
  function postJob(job: Job) { run(async () => { await api(`/jobs/${job.id}/post`, { method: "POST" }); await refresh(); }); }
  function deleteJob(job: Job) { run(async () => { await api(`/jobs/${job.id}`, { method: "DELETE" }); await refresh(); }); }
  function rescheduleJob(job: Job) {
    const scheduledFor = scheduleEdits[job.id];
    if (!scheduledFor) return;
    run(async () => {
      await api(`/jobs/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ scheduledFor: new Date(scheduledFor).toISOString() })
      });
      await refresh();
    });
  }
  function clearJobSchedule(job: Job) {
    run(async () => {
      await api(`/jobs/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ scheduledFor: null })
      });
      await refresh();
    });
  }
  function postAllReadyJobs() {
    run(async () => {
      const result = await api<{ failed: number; posted: number; total: number }>("/jobs/post-ready", {
        method: "POST", body: JSON.stringify({ accountId })
      });
      await refresh();
      if (result.failed > 0) throw new Error(`Post all finished: ${result.posted}/${result.total} posted, ${result.failed} failed.`);
    });
  }
  function postNextNow() {
    run(async () => {
      await api("/jobs/post-next", { method: "POST", body: JSON.stringify({ accountId }) });
      await refresh();
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
      const readyJobs = jobs.filter((job) =>
        (job.status === "approved" || job.status === "failed") && (!job.scheduledFor || Date.parse(job.scheduledFor) <= now)
      );
      for (const job of readyJobs) await api(`/jobs/${job.id}/prepare`, { method: "POST" });
      await refresh();
    });
  }
  function toggleJobSelection(jobId: string) {
    setSelectedJobIds((current) => current.includes(jobId) ? current.filter((id) => id !== jobId) : [...current, jobId]);
  }
  function deleteSelectedJobs() {
    run(async () => {
      const selected = jobs.filter((job) => selectedJobIds.includes(job.id));
      for (const job of selected) {
        if (job.status === "failed" || job.status === "prepared") await api(`/jobs/${job.id}`, { method: "DELETE" });
      }
      setSelectedJobIds([]);
      await refresh();
    });
  }

  const now = Date.now();
  const nextAutopostJob = jobs
    .filter((job) => job.mode === "autopost" && (job.status === "approved" || job.status === "prepared"))
    .sort((left, right) => {
      const leftScheduled = left.scheduledFor ? Date.parse(left.scheduledFor) : Number.NEGATIVE_INFINITY;
      const rightScheduled = right.scheduledFor ? Date.parse(right.scheduledFor) : Number.NEGATIVE_INFINITY;
      return leftScheduled - rightScheduled || Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? "");
    })[0] ?? null;
  const filterCounts = jobs.reduce<Record<QueueFilter, number>>((counts, job) => {
    counts[jobFilter(job, now)] += 1;
    return counts;
  }, { ready: 0, scheduled: 0, failed: 0, posted: 0 });
  const filteredJobs = jobs.filter((job) => jobFilter(job, now) === filter);
  const postableJobs = jobs.filter((job) =>
    (job.status === "approved" || job.status === "prepared") && (!job.scheduledFor || Date.parse(job.scheduledFor) <= now)
  );
  const readyForBulkPrepare = jobs.filter((job) =>
    (job.status === "approved" || job.status === "failed") && (!job.scheduledFor || Date.parse(job.scheduledFor) <= now)
  );
  const selectedDeletableJobs = jobs.filter((job) => selectedJobIds.includes(job.id) && (job.status === "failed" || job.status === "prepared"));
  const hasCleanupJobs = jobs.some((job) => job.status === "posted" || job.status === "failed");

  return (
    <section className="queue-panel">
      <InlineError message={loadError} />
      <div className="queue-toolbar">
        <div className="segmented-control" aria-label="Queue filter">
          {(["ready", "scheduled", "failed", "posted"] as QueueFilter[]).map((option) => (
            <button aria-pressed={filter === option} className={filter === option ? "active" : ""} key={option} onClick={() => setFilter(option)}>
              {option}<span>{filterCounts[option]}</span>
            </button>
          ))}
        </div>
        <div className="queue-toolbar-actions">
          {nextAutopostJob ? <button className="secondary" disabled={busy} onClick={postNextNow}><Busy active={busy} />Post next now</button> : null}
          {postableJobs.length ? <button className="secondary" disabled={busy} onClick={postAllReadyJobs}><Busy active={busy} />Post all ready</button> : null}
        </div>
      </div>
      {jobs.length ? (
        <div className="queue-secondary-actions">
          {readyForBulkPrepare.length ? <button className="ghost" disabled={busy} onClick={prepareAllReadyJobs}><Busy active={busy} />Prepare all ready</button> : null}
          {hasCleanupJobs ? <button className="ghost" disabled={busy} onClick={deleteCleanupJobs}><Busy active={busy} />Cleanup posted / failed</button> : null}
          {selectedDeletableJobs.length ? <button className="ghost danger" disabled={busy} onClick={deleteSelectedJobs}><Busy active={busy} />Delete selected ({selectedDeletableJobs.length})</button> : null}
          {selectedJobIds.length ? <button className="ghost" disabled={busy} onClick={() => setSelectedJobIds([])}>Clear selection ({selectedJobIds.length})</button> : null}
          <button className="ghost danger" disabled={busy} onClick={deleteAllJobs}><Busy active={busy} />Delete all</button>
        </div>
      ) : null}
      {jobs.length ? (
        <div className="queue-table">
          <div className="queue-table-head" aria-hidden="true">
            <span>Status</span><span>Text</span><span>Type</span><span>Scheduled</span><span>Actions</span>
          </div>
          {filteredJobs.length ? filteredJobs.map((job) => {
            const draft = draftsByJob[job.id];
            const expanded = expandedJobId === job.id;
            const attempts = attemptsByJob[job.id] ?? [];
            const canPrepare = (job.status === "approved" || job.status === "failed") && (!job.scheduledFor || Date.parse(job.scheduledFor) <= now);
            const canPost = (job.status === "approved" || job.status === "prepared") && (!job.scheduledFor || Date.parse(job.scheduledFor) <= now);
            return (
              <article className={expanded ? "queue-row expanded" : "queue-row"} key={job.id}>
                <div
                  aria-expanded={expanded}
                  className="queue-row-summary"
                  onClick={() => setExpandedJobId(expanded ? null : job.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setExpandedJobId(expanded ? null : job.id);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="queue-status-cell">
                    <label className="queue-select" title="Select job" onClick={(event) => event.stopPropagation()}>
                      <input checked={selectedJobIds.includes(job.id)} type="checkbox" onChange={() => toggleJobSelection(job.id)} />
                    </label>
                    <StatusBadge status={job.status} />
                  </div>
                  <span className="queue-text" title={draft?.text}>{draft?.text ?? "Loading draft…"}</span>
                  <span className="queue-type">{draft?.type ?? "—"}</span>
                  <span className="queue-scheduled">{job.scheduledFor ? new Date(job.scheduledFor).toLocaleString() : "Now"}</span>
                  <div className="queue-row-actions" onClick={(event) => event.stopPropagation()}>
                    <button aria-label="Prepare job" className="ghost icon-button" disabled={!canPrepare || busy} title="Prepare" onClick={() => prepareJob(job)}><Busy active={busy} /><ActionIcon name="prepare" /></button>
                    {canPost ? <button aria-label="Post job" className="ghost icon-button" disabled={busy} title="Post" onClick={() => postJob(job)}><Busy active={busy} /><ActionIcon name="post" /></button> : null}
                    <button aria-label="Delete job" className="ghost danger icon-button" disabled={job.status === "running" || busy} title="Delete" onClick={() => deleteJob(job)}><Busy active={busy} /><ActionIcon name="delete" /></button>
                  </div>
                </div>
                {expanded ? (
                  <div className="queue-detail">
                    <p>{draft?.text ?? "Draft text unavailable."}</p>
                    <dl>
                      <div><dt>Job</dt><dd>{job.id}</dd></div>
                      <div><dt>Mode</dt><dd>{job.mode}</dd></div>
                      {job.replyTo ? <div><dt>Reply</dt><dd>@{job.replyTo.authorHandle}</dd></div> : null}
                    </dl>
                    {canRescheduleJob(job) ? (
                      <form
                        className="queue-reschedule"
                        onSubmit={(event) => {
                          event.preventDefault();
                          rescheduleJob(job);
                        }}
                      >
                        <label>
                          Schedule
                          <input
                            aria-label={`Schedule job ${job.id}`}
                            type="datetime-local"
                            value={scheduleEdits[job.id] ?? ""}
                            onChange={(event) => setScheduleEdits((current) => ({ ...current, [job.id]: event.target.value }))}
                          />
                        </label>
                        <button className="secondary compact-button" disabled={!scheduleEdits[job.id] || busy}>Save</button>
                        {job.scheduledFor ? (
                          <button className="ghost compact-button" disabled={busy} type="button" onClick={() => clearJobSchedule(job)}>Clear schedule</button>
                        ) : null}
                      </form>
                    ) : null}
                    <div className="attempt-list">
                      {attempts.length ? attempts.map((attempt) => (
                        <div className="attempt-row" key={attempt.id}>
                          <StatusBadge status={attempt.status} />
                          <span>{attempt.errorMessage ?? attempt.errorCode ?? "Attempt completed without a reported error."}</span>
                          {attempt.screenshotPath ? <a href={attempt.screenshotPath} rel="noreferrer" target="_blank">Screenshot</a> : null}
                          {attempt.tracePath ? <a href={attempt.tracePath} rel="noreferrer" target="_blank">Trace</a> : null}
                        </div>
                      )) : <p className="empty">No attempts yet.</p>}
                    </div>
                  </div>
                ) : null}
              </article>
            );
          }) : <div className="queue-filter-empty">No {filter} jobs.</div>}
        </div>
      ) : <div className="view-empty-state"><p>No jobs yet — approve a draft to queue it</p></div>}
    </section>
  );
}
