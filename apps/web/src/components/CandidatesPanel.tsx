import { api } from "../api.js";
import type { Candidate, Draft, DraftResponse, Job, PanelProps } from "../types.js";
import { X_FREE_POST_CHARACTER_LIMIT } from "../types.js";

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
          mode: scheduledFor ? "scheduled" : "prepare_only",
          scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null
        })
      });
      setDraft({ ...draft, draft: response.draft });
      setScheduledFor("");
      await refresh();
    });
  }

  return (
    <>
      <section className="panel candidates">
        <div className="panel-head">
          <h2>Candidates</h2>
          <span>{draft?.draft.status ?? "empty"}</span>
        </div>
        <div className="candidate-list">
          {draft?.candidates.map((candidate) => (
            <button
              aria-pressed={candidate.selected}
              className={candidate.selected ? "candidate selected" : "candidate"}
              key={candidate.id}
              onClick={() => selectCandidate(candidate)}
            >
              {candidate.text}
            </button>
          )) ?? <p className="empty">Generate drafts to review options.</p>}
        </div>
      </section>

      <section className="panel editor">
        <div className="panel-head">
          <h2>Editor</h2>
          <span>{editedText.length}/{X_FREE_POST_CHARACTER_LIMIT}</span>
        </div>
        <textarea aria-label="Edited draft" value={editedText} onChange={(event) => setEditedText(event.target.value)} rows={12} />
        <div className="schedule-grid">
          <label className="checkbox-row">
            <input checked={autoPost} type="checkbox" onChange={(event) => setAutoPost(event.target.checked)} />
            Autopost
          </label>
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
        </div>
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
          Approve job
        </button>
      </section>
    </>
  );
}
