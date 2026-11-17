import { useEffect, useState } from "react";
import { api } from "../api.js";
import type { Candidate, Draft, DraftResponse, Job, PanelProps } from "../types.js";
import { Busy, StatusBadge } from "./Feedback.js";

export interface CandidatesState {
  autoPost: boolean;
  draft: DraftResponse | null;
  editedText: string;
  postPlan: string;
  scheduleSpacingMinutes: number;
  scheduledFor: string;
  setAutoPost: (value: boolean) => void;
  setDraft: (draft: DraftResponse | null) => void;
  setEditedText: (text: string) => void;
  setScheduleSpacingMinutes: (minutes: number) => void;
  setScheduledFor: (value: string) => void;
}

export function CandidatesPanel({ panel, state }: { panel: PanelProps; state: CandidatesState }) {
  const { busy, navigate, notify, refresh, run } = panel;
  const {
    autoPost,
    draft,
    editedText,
    postPlan,
    scheduleSpacingMinutes,
    scheduledFor,
    setAutoPost,
    setDraft,
    setEditedText,
    setScheduleSpacingMinutes,
    setScheduledFor
  } = state;
  const selectedCandidate = draft?.candidates.find((candidate) => candidate.selected) ?? null;
  const editedCharacterLength = editedText.length;
  const [queuedJob, setQueuedJob] = useState<Job | null>(null);

  useEffect(() => {
    setQueuedJob(null);
  }, [draft?.draft.id]);

  function selectCandidate(candidate: Candidate) {
    if (!draft) return;
    run(async () => {
      const response = await api<DraftResponse>(`/drafts/${draft.draft.id}/select`, {
        method: "POST",
        body: JSON.stringify({ candidateId: candidate.id, editedText: candidate.text })
      });
      setDraft(response);
      setEditedText(response.draft.editedText ?? candidate.text);
    });
  }

  function approveDraft() {
    if (!draft) return;
    run(async () => {
      const response = await api<{ draft: Draft; job: Job }>(`/drafts/${draft.draft.id}/approve`, {
        method: "POST",
        body: JSON.stringify({
          editedText,
          mode: autoPost ? "autopost" : scheduledFor ? "scheduled" : "prepare_only",
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null
        })
      });
      setDraft({ ...draft, draft: response.draft });
      setAutoPost(false);
      setScheduledFor("");
      setQueuedJob(response.job);
      notify(
        response.job.mode === "autopost"
          ? "Approved as autopost — the worker will publish it without another review."
          : "Approved and queued. Nothing is posted until you press Post in the Queue.",
        response.job.mode === "autopost" ? "info" : "success"
      );
      await refresh();
    });
  }

  function evaluateDraft() {
    if (!draft) return;
    run(async () => {
      const response = await api<DraftResponse>(`/drafts/${draft.draft.id}/evaluate`, {
        method: "POST"
      });
      setDraft(response);
      notify(`Local scores refreshed for ${response.candidates.length} candidate${response.candidates.length === 1 ? "" : "s"}.`, "info");
    });
  }

  return (
    <section className="candidate-results" aria-label="Draft candidates">
      {draft?.candidates.length ? (
        <>
          <div className="candidate-results-head">
            <div>
              <h2>Candidates</h2>
              <p>Select the card you want, edit if needed, then Approve.</p>
            </div>
            <div className="candidate-results-actions">
              <button className="secondary compact-button" disabled={busy} onClick={evaluateDraft}>
                <Busy active={busy} />Evaluate (local)
              </button>
              <StatusBadge status={draft.draft.status} />
            </div>
          </div>
          <p className="candidate-hint">
            Approving queues the job — it does <strong>not</strong> post. Every post is published explicitly from the Queue.
          </p>
          {queuedJob ? (
            <div className="approved-callout" role="status">
              <div>
                <strong>Queued as {queuedJob.mode === "autopost" ? "an autopost job" : "a review job"}</strong>
                <span>
                  {queuedJob.mode === "autopost"
                    ? "The worker will publish it without another review."
                    : "Nothing is posted until you press Post in the Queue."}
                </span>
              </div>
              <button className="secondary compact-button" type="button" onClick={() => navigate("queue")}>Open Queue</button>
            </div>
          ) : null}
          <div className="candidate-list data-content">
            {draft.candidates.map((candidate) => {
              const selected = candidate.id === selectedCandidate?.id;
              return (
                <article
                  aria-pressed={selected}
                  className={selected ? "candidate-card selected" : "candidate-card"}
                  key={candidate.id}
                  onClick={() => {
                    if (!selected && !busy) selectCandidate(candidate);
                  }}
                  onKeyDown={(event) => {
                    if (!selected && !busy && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      selectCandidate(candidate);
                    }
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <div className="candidate-copy">
                    <p>{candidate.text}</p>
                    <div className="candidate-meta">
                      <span><Busy active={busy && !selected} />{candidate.text.length} characters</span>
                      {candidate.score.judgeVerdict && candidate.score.judgeScore !== undefined ? (
                        <span
                          aria-label={`${candidate.score.judgeVerdict}, ${candidate.score.judgeScore} out of 10`}
                          className={`judge-badge judge-badge--${candidate.score.judgeVerdict}`}
                          title={candidate.score.judgeReasons?.join("; ")}
                        >
                          <strong>{candidate.score.judgeVerdict}</strong>
                          <span>{candidate.score.judgeScore}/10</span>
                        </span>
                      ) : null}
                    </div>
                  </div>
                  {selected ? (
                    <div className="candidate-editor" onClick={(event) => event.stopPropagation()}>
                      <div className="editor-meta">
                        <span>Inline editor</span>
                        <span className="character-count">{editedCharacterLength} characters</span>
                      </div>
                      <textarea aria-label="Edited draft" value={editedText} onChange={(event) => setEditedText(event.target.value)} rows={8} />
                      <div className="approve-row">
                        <label>
                          Schedule
                          <input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />
                        </label>
                        {postPlan === "batch" ? (
                          <label>
                            Batch spacing
                            <input
                              max="480"
                              min="15"
                              step="15"
                              type="number"
                              value={scheduleSpacingMinutes}
                              onChange={(event) => setScheduleSpacingMinutes(Number(event.target.value))}
                            />
                          </label>
                        ) : null}
                        <label className={autoPost ? "checkbox-row switch-row autopost-control warning" : "checkbox-row switch-row autopost-control"}>
                          <input checked={autoPost} type="checkbox" onChange={(event) => setAutoPost(event.target.checked)} />
                          <span aria-hidden="true" className="switch" />
                          <span>Autopost{autoPost ? <small>Posts without review</small> : null}</span>
                        </label>
                        <button
                          disabled={
                            !draft ||
                            !editedText.trim() ||
                            draft.draft.status === "approved" ||
                            busy
                          }
                          onClick={approveDraft}
                        >
                          <Busy active={busy} />Approve
                        </button>
                      </div>
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}
