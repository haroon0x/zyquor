import { api } from "../api.js";
import type { Candidate, Draft, DraftResponse, Job, PanelProps } from "../types.js";
import { X_FREE_POST_CHARACTER_LIMIT } from "../types.js";
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
  const { busy, refresh, run } = panel;
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
      await refresh();
    });
  }

  return (
    <section className="candidate-results" aria-label="Draft candidates">
      {draft?.candidates.length ? (
        <>
          <div className="candidate-results-head">
            <div>
              <h2>Candidates</h2>
              <p>Choose a direction, edit it, then approve.</p>
            </div>
            <StatusBadge status={draft.draft.status} />
          </div>
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
                    <span><Busy active={busy && !selected} />{candidate.text.length} characters</span>
                  </div>
                  {selected ? (
                    <div className="candidate-editor" onClick={(event) => event.stopPropagation()}>
                      <div className="editor-meta">
                        <span>Inline editor</span>
                        <span className={editedText.length > X_FREE_POST_CHARACTER_LIMIT ? "character-count over-limit" : "character-count"}>
                          {editedText.length}/{X_FREE_POST_CHARACTER_LIMIT}
                        </span>
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
                            editedText.length > X_FREE_POST_CHARACTER_LIMIT ||
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
