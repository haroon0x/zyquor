import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import type { Attempt, DraftResponse, Job, PanelProps } from "../types.js";
import { Busy, InlineError, StatusBadge, errorMessage } from "./Feedback.js";

type QueueFilter = "ready" | "scheduled" | "failed" | "posted";

const JOBS_POLL_MS = 5000;
// Terminal jobs never change status again, so their draft summaries and attempt
// lists are fetched once and reused; polled payloads stop growing with history.
const TERMINAL_JOB_STATUSES = new Set(["posted", "failed", "cancelled"]);

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
  const { accountId, busy, navigate, notify, refresh, refreshToken, run } = panel;
  const [jobs, setJobs] = useState<Job[]>([]);
  const [attemptsByJob, setAttemptsByJob] = useState<Record<string, Attempt[]>>({});
  const [draftsByJob, setDraftsByJob] = useState<Record<string, JobDraftDetails>>({});
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const [scheduleEdits, setScheduleEdits] = useState<Record<string, string>>({});
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [filter, setFilter] = useState<QueueFilter>("ready");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const requestIdRef = useRef(0);
  const draftDetailsCacheRef = useRef<Record<string, JobDraftDetails>>({});

  async function loadJobs() {
    setLoadError(null);
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    const { jobs: loadedJobs } = await api<{ jobs: Job[] }>(`/jobs?accountId=${encodeURIComponent(accountId)}`);
    if (requestId !== requestIdRef.current) return;

    // Previously every poll refetched attempts + draft for every job
    // (2N+1 requests each 5s). Draft details are cached once fetched and only
    // refetched for jobs that can still change; attempts are fetched only for
    // the expanded job row.
    const detailResponses = await Promise.all(
      loadedJobs
        .filter((job) => !TERMINAL_JOB_STATUSES.has(job.status) || !draftDetailsCacheRef.current[job.id])
        .map(async (job) => {
          const draftResponse = await api<DraftResponse>(`/drafts/${job.draftId}`);
          const selectedCandidate = draftResponse.candidates.find((candidate) => candidate.selected);
          const text = draftResponse.draft.editedText ?? selectedCandidate?.text ?? draftResponse.candidates[0]?.text ?? draftResponse.draft.sourceInput;
          const metadataType = draftResponse.draft.metadata?.tweetType;
          const type = draftResponse.draft.replyTo ? "reply" : typeof metadataType === "string" ? metadataType : "—";
          return { jobId: job.id, draft: { text, type } };
        })
    );
    const expandedAttempts = expandedJobId
      ? await api<{ attempts: Attempt[] }>(`/jobs/${expandedJobId}/attempts`).then((response) => response.attempts).catch(() => null)
      : null;
    if (requestId !== requestIdRef.current) return;

    const mergedDetails: Record<string, JobDraftDetails> = {};
    for (const job of loadedJobs) {
      const cached = draftDetailsCacheRef.current[job.id];
      if (cached) mergedDetails[job.id] = cached;
    }
    for (const response of detailResponses) {
      mergedDetails[response.jobId] = response.draft;
    }
    draftDetailsCacheRef.current = mergedDetails;
    const availableJobIds = new Set(loadedJobs.map((job) => job.id));
    setJobs(loadedJobs);
    setDraftsByJob(mergedDetails);
    setAttemptsByJob((current) => (expandedAttempts ? { ...current, [expandedJobId!]: expandedAttempts } : current));
    // Keep any schedule the user is currently typing; background polls must not clobber it.
    setScheduleEdits((current) =>
      Object.fromEntries(loadedJobs.map((job) => [job.id, current[job.id] ?? toDateTimeLocal(job.scheduledFor)]))
    );
    setSelectedJobIds((current) => current.filter((id) => availableJobIds.has(id)));
    setExpandedJobId((current) => current && availableJobIds.has(current) ? current : null);
    setLoaded(true);
  }

  useEffect(() => {
    void loadJobs().catch((error) => setLoadError(errorMessage(error, "Jobs unavailable")));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, refreshToken, expandedJobId]);

  // The worker changes job state every few seconds; without this the queue is
  // stale until the user clicks something. Paused while an action is in flight
  // and while the tab is hidden (no point polling an invisible window), and
  // refreshed immediately when the tab becomes visible again.
  useEffect(() => {
    if (busy) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void loadJobs().catch(() => undefined);
    }, JOBS_POLL_MS);
    const onVisibilityChange = () => {
      if (!document.hidden && !busy) void loadJobs().catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, busy, expandedJobId]);

  function draftPreview(job: Job) {
    const text = draftsByJob[job.id]?.text ?? "this draft";
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }
  function prepareJob(job: Job) {
    run(async () => {
      await api(`/jobs/${job.id}/prepare`, { method: "POST" });
      notify("Composer filled and verified — nothing was posted. Review it in the posting browser.", "success");
      await refresh();
    });
  }
  function postJob(job: Job) {
    if (!window.confirm(`Publish this post to X now?\n\n${draftPreview(job)}\n\nThis cannot be undone.`)) return;
    run(async () => {
      await api(`/jobs/${job.id}/post`, { method: "POST" });
      notify("Posted — the permalink is saved in History.", "success");
      await refresh();
    });
  }
  function deleteJob(job: Job) {
    if (!window.confirm(`Delete this job?\n\n${draftPreview(job)}\n\nThe draft stays, only the queue entry is removed.`)) return;
    run(async () => {
      await api(`/jobs/${job.id}`, { method: "DELETE" });
      notify("Job deleted.", "info");
      await refresh();
    });
  }
  function rescheduleJob(job: Job) {
    const scheduledFor = scheduleEdits[job.id];
    if (!scheduledFor) return;
    run(async () => {
      await api(`/jobs/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ scheduledFor: new Date(scheduledFor).toISOString() })
      });
      notify(`Job scheduled for ${new Date(scheduledFor).toLocaleString()}.`, "info");
      await refresh();
    });
  }
  function clearJobSchedule(job: Job) {
    run(async () => {
      await api(`/jobs/${job.id}`, {
        method: "PATCH",
        body: JSON.stringify({ scheduledFor: null })
      });
      notify("Schedule cleared — the job is ready as soon as posting is allowed.", "info");
      await refresh();
    });
  }
  function postAllReadyJobs() {
    if (!window.confirm(`Publish all ${postableJobs.length} ready job(s) to X now? This cannot be undone.`)) return;
    run(async () => {
      const result = await api<{ failed: number; posted: number; total: number }>("/jobs/post-ready", {
        method: "POST", body: JSON.stringify({ accountId })
      });
      await refresh();
      if (result.failed > 0) {
        notify(`Posted ${result.posted}/${result.total}; ${result.failed} failed. Check the Failed filter and attempts.`, "error");
      } else {
        notify(`Posted ${result.posted}/${result.total} job(s) — permalinks are in History.`, "success");
      }
    });
  }
  function postNextNow() {
    if (!window.confirm("Publish the next ready job to X now? This cannot be undone.")) return;
    run(async () => {
      await api("/jobs/post-next", { method: "POST", body: JSON.stringify({ accountId }) });
      notify("Posted the next ready job — permalink saved in History.", "success");
      await refresh();
    });
  }
  function deleteCleanupJobs() {
    if (!window.confirm("Remove all posted and failed job records? Drafts and history stay; this cannot be undone.")) return;
    run(async () => {
      await api("/jobs/cleanup", { method: "DELETE" });
      notify("Removed posted and failed job records.", "info");
      await refresh();
    });
  }
  function deleteAllJobs() {
    if (!window.confirm(`Delete ALL jobs for @${accountId}? Drafts and history stay; this cannot be undone.`)) return;
    run(async () => {
      await api(`/jobs?accountId=${encodeURIComponent(accountId)}`, { method: "DELETE" });
      notify("All jobs deleted. Drafts and posted history were kept.", "info");
      await refresh();
    });
  }
  function prepareAllReadyJobs() {
    const now = Date.now();
    const readyJobs = jobs.filter((job) =>
      (job.status === "approved" || job.status === "failed") && (!job.scheduledFor || Date.parse(job.scheduledFor) <= now)
    );
    if (!readyJobs.length) return;
    if (!window.confirm(`Fill the X composer for ${readyJobs.length} ready job(s)? Nothing is posted; each composer stays for review.`)) return;
    run(async () => {
      for (const job of readyJobs) await api(`/jobs/${job.id}/prepare`, { method: "POST" });
      notify(`Filled ${readyJobs.length} composer(s) — review each in the posting browser before posting.`, "success");
      await refresh();
    });
  }
  function toggleJobSelection(jobId: string) {
    setSelectedJobIds((current) => current.includes(jobId) ? current.filter((id) => id !== jobId) : [...current, jobId]);
  }
  function deleteSelectedJobs() {
    const selected = jobs.filter((job) => selectedJobIds.includes(job.id));
    const deletable = selected.filter((job) => job.status === "failed" || job.status === "prepared");
    const skipped = selected.length - deletable.length;
    if (!deletable.length) {
      notify("Only failed or prepared jobs can be deleted. Posted/approved jobs are kept for the record.", "error");
      return;
    }
    if (!window.confirm(`Delete ${deletable.length} selected job(s)?${skipped ? ` ${skipped} will be skipped (not deletable).` : ""} Drafts are kept.`)) return;
    run(async () => {
      for (const job of deletable) await api(`/jobs/${job.id}`, { method: "DELETE" });
      setSelectedJobIds([]);
      notify(
        `${deletable.length} job(s) deleted${skipped ? `; ${skipped} skipped (only failed/prepared are deletable)` : ""}.`,
        skipped ? "info" : "success"
      );
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
          {nextAutopostJob ? <button className="secondary" disabled={busy} onClick={postNextNow}><Busy active={busy} />Post next</button> : null}
          {postableJobs.length ? <button className="secondary" disabled={busy} onClick={postAllReadyJobs}><Busy active={busy} />Post all ready</button> : null}
        </div>
      </div>
      {jobs.length ? (
        <div className="queue-secondary-actions">
          {selectedJobIds.length ? <span className="selection-count">{selectedJobIds.length} selected</span> : null}
          {readyForBulkPrepare.length ? <button className="ghost" disabled={busy} onClick={prepareAllReadyJobs}><Busy active={busy} />Prepare all ready</button> : null}
          {hasCleanupJobs ? <button className="ghost" disabled={busy} onClick={deleteCleanupJobs}><Busy active={busy} />Clear posted &amp; failed</button> : null}
          {selectedDeletableJobs.length ? <button className="ghost danger" disabled={busy} onClick={deleteSelectedJobs}><Busy active={busy} />Delete selected ({selectedDeletableJobs.length})</button> : null}
          {selectedJobIds.length ? <button className="ghost" disabled={busy} onClick={() => setSelectedJobIds([])}>Clear selection ({selectedJobIds.length})</button> : null}
          <button className="ghost danger" disabled={busy} onClick={deleteAllJobs}><Busy active={busy} />Delete all</button>
        </div>
      ) : null}
      {!loaded && !loadError ? (
        <div aria-label="Loading queue" className="skeleton-table">
          {[0, 1, 2, 3, 4].map((row) => (
            <div className="skeleton-row" key={row}>
              <span className="skeleton-pill" />
              <span className="skeleton-line" />
              <span className="skeleton-line skeleton-line--short" />
            </div>
          ))}
        </div>
      ) : null}
      {loaded && jobs.length ? (
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
                  title="Open job details and attempt history"
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
                    <button aria-label="Prepare job" className="ghost compact-button queue-action" disabled={!canPrepare || busy} title="Prepare — fill the composer without posting" onClick={() => prepareJob(job)}><Busy active={busy} /><ActionIcon name="prepare" /><span>Prepare</span></button>
                    {canPost ? <button aria-label="Post job" className="secondary compact-button queue-action" disabled={busy} title="Post — publish to X now" onClick={() => postJob(job)}><Busy active={busy} /><ActionIcon name="post" /><span>Post</span></button> : null}
                    <button aria-label="Delete job" className="ghost danger icon-button" disabled={job.status === "running" || busy} title="Delete job" onClick={() => deleteJob(job)}><Busy active={busy} /><ActionIcon name="delete" /></button>
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
          }) : (
            <div className="queue-filter-empty">
              <span>No {filter} jobs right now.</span>
              <button className="secondary compact-button" type="button" onClick={() => navigate("compose")}>Compose a post</button>
            </div>
          )}
        </div>
      ) : loaded && !loadError ? (
        <div className="view-empty-state">
          <p>No jobs yet</p>
          <p className="empty-state-hint">Approve a draft in Compose and it lands here for review and posting.</p>
          <button className="secondary compact-button" type="button" onClick={() => navigate("compose")}>Go to Compose</button>
        </div>
      ) : null}
    </section>
  );
}
