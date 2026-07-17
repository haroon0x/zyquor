import { useEffect, useState } from "react";
import { api } from "../api.js";
import { CandidatesPanel, type CandidatesState } from "../components/CandidatesPanel.js";
import { Composer, type ComposerState } from "../components/Composer.js";
import { Busy } from "../components/Feedback.js";
import type { PanelProps, QualityGateFailure, QualityGateMetadata } from "../types.js";

function rejectionReason(qualityGate: QualityGateMetadata) {
  if (qualityGate.reason === "ai_slop_phrase_detected" || qualityGate.slopPhrase) {
    return `Slop phrase detected${qualityGate.slopPhrase ? `: “${qualityGate.slopPhrase}”` : ""}`;
  }
  return "Below quality threshold";
}

function rejectedTime(value: string) {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

export function ComposeView({
  candidatesPanel,
  candidatesState,
  composerPanel,
  composerState
}: {
  candidatesPanel: PanelProps;
  candidatesState: CandidatesState;
  composerPanel: PanelProps;
  composerState: ComposerState;
}) {
  const [failures, setFailures] = useState<QualityGateFailure[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void api<{ drafts: QualityGateFailure[] }>("/drafts/quality-gate-failures")
      .then(({ drafts }) => {
        if (active) setFailures(drafts);
      })
      .catch((error) => {
        if (active) composerPanel.reportError(error, "Could not load quality gate rejections");
      });
    return () => {
      active = false;
    };
  }, [composerPanel.refreshToken]);

  function reviewFailure(failure: QualityGateFailure) {
    const selectedCandidate = failure.candidates.find((candidate) => candidate.selected) ?? failure.candidates[0];
    candidatesState.setDraft(failure);
    candidatesState.setEditedText(failure.draft.editedText ?? selectedCandidate?.text ?? "");
    candidatesState.setAutoPost(false);
    candidatesState.setScheduledFor("");
  }

  function deleteFailure(failure: QualityGateFailure) {
    setDeletingId(failure.draft.id);
    composerPanel.run(async () => {
      try {
        await api(`/drafts/${failure.draft.id}`, { method: "DELETE" });
        setFailures((current) => current.filter((item) => item.draft.id !== failure.draft.id));
        if (candidatesState.draft?.draft.id === failure.draft.id) {
          candidatesState.setDraft(null);
          candidatesState.setEditedText("");
        }
      } finally {
        setDeletingId(null);
      }
    });
  }

  return (
    <div className="compose-view">
      <Composer panel={composerPanel} state={composerState} />
      <CandidatesPanel panel={candidatesPanel} state={candidatesState} />
      {failures.length ? (
        <section className="quality-gate-rejections" aria-label="Quality gate rejections">
          <div className="quality-gate-head">
            <div>
              <h2>Quality gate rejections</h2>
              <p>Automatic drafts held back for manual review.</p>
            </div>
            <span>{failures.length}</span>
          </div>
          <div className="quality-gate-list">
            {failures.map((failure) => (
              <article className="quality-gate-row" key={failure.draft.id}>
                <div className="quality-gate-details">
                  <strong>{rejectionReason(failure.qualityGate)}</strong>
                  <div>
                    <span>
                      Best score {failure.qualityGate.bestQuality ?? "—"} / {failure.qualityGate.threshold} required
                    </span>
                    <time dateTime={failure.qualityGate.rejectedAt}>{rejectedTime(failure.qualityGate.rejectedAt)}</time>
                  </div>
                </div>
                <div className="quality-gate-actions">
                  <button
                    className="secondary compact-button"
                    disabled={composerPanel.busy}
                    onClick={() => reviewFailure(failure)}
                  >
                    Review in editor
                  </button>
                  <button
                    className="ghost danger compact-button"
                    disabled={composerPanel.busy}
                    onClick={() => deleteFailure(failure)}
                  >
                    <Busy active={deletingId === failure.draft.id} />Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
