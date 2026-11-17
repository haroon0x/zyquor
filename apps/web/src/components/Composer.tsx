import { useState } from "react";
import { api } from "../api.js";
import type { Candidate, Draft, DraftResponse, PanelProps } from "../types.js";
import { tweetTypeOptions } from "../types.js";
import { Busy, PanelIcon } from "./Feedback.js";

export interface ComposerState {
  autoPost: boolean;
  idea: string;
  postPlan: string;
  replyToUrl: string;
  scheduleSpacingMinutes: number;
  scheduledFor: string;
  tweetType: string;
  setDraft: (draft: DraftResponse | null) => void;
  setAutoPost: (value: boolean) => void;
  setEditedText: (text: string) => void;
  setIdea: (idea: string) => void;
  setPostPlan: (plan: string) => void;
  setReplyToUrl: (url: string) => void;
  setScheduleSpacingMinutes: (minutes: number) => void;
  setScheduledFor: (value: string) => void;
  setTweetType: (tweetType: string) => void;
}

export function Composer({ panel, state }: { panel: PanelProps; state: ComposerState }) {
  const { accountId, busy, notify, refresh, run } = panel;
  const {
    autoPost,
    idea,
    postPlan,
    replyToUrl,
    scheduleSpacingMinutes,
    scheduledFor,
    tweetType,
    setDraft,
    setAutoPost,
    setEditedText,
    setIdea,
    setPostPlan,
    setReplyToUrl,
    setScheduleSpacingMinutes,
    setScheduledFor,
    setTweetType
  } = state;
  const [showReplyTarget, setShowReplyTarget] = useState(Boolean(replyToUrl));

  function generateDrafts() {
    run(async () => {
      const mode = autoPost ? "autopost" : scheduledFor ? "scheduled" : "prepare_only";

      if (autoPost && postPlan === "single") {
        const created = await api<DraftResponse>(replyToUrl.trim() ? "/drafts" : "/drafts/research", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            idea,
            count: 1,
            tweetType,
            ...(replyToUrl.trim() ? { replyToUrl: replyToUrl.trim() } : {}),
            yolo: true,
            autopost: true
          })
        });
        if (replyToUrl.trim()) {
          await api<DraftResponse>(`/drafts/${created.draft.id}/generate`, {
            method: "POST",
            body: JSON.stringify({})
          });
        }
        setDraft(null);
        setEditedText("");
        await refresh();
        notify("Autopost queued — the worker will publish it without another review.", "info");
        return;
      }

      if (postPlan === "batch") {
        const ideas = idea
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean);
        await api<{ items: Array<{ candidates: Candidate[]; draft: Draft }> }>("/draft-batches", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            ideas,
            mode,
            scheduleSpacingMinutes,
            scheduleStart: scheduledFor ? new Date(scheduledFor).toISOString() : null,
            tweetType,
            yolo: autoPost,
            autopost: autoPost
          })
        });
        setDraft(null);
        setEditedText("");
        await refresh();
        notify(
          `${ideas.length} batch job${ideas.length === 1 ? "" : "s"} queued — review and approve them in the Queue.`,
          "success"
        );
        return;
      }

      const research = !replyToUrl.trim();
      const created = await api<DraftResponse>(research ? "/drafts/research" : "/drafts", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          idea,
          count: 3,
          tweetType,
          ...(replyToUrl.trim() ? { replyToUrl: replyToUrl.trim() } : {})
        })
      });
      let response: DraftResponse;
      try {
        response = research
          ? created
          : await api<DraftResponse>(`/drafts/${created.draft.id}/generate`, {
              method: "POST",
              body: JSON.stringify({})
            });
      } catch (error) {
        await api(`/drafts/${created.draft.id}`, { method: "DELETE" }).catch(() => undefined);
        throw error;
      }
      setDraft(response);
      setEditedText(response.candidates[0]?.text ?? "");
      if (response.candidates.length) {
        notify(`Drafts ready — ${response.candidates.length} candidate${response.candidates.length === 1 ? "" : "s"} below.`, "success");
      } else {
        notify("No candidates came back. Try a more concrete idea or regenerate.", "error");
      }
    });
  }

  const trimmedIdea = idea.trim();
  const batchIdeas = idea.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const nextStep = postPlan === "batch"
    ? autoPost
      ? "Autopost batch — each line becomes a job the worker publishes without another review."
      : `Batch: ${batchIdeas.length || 0} line${batchIdeas.length === 1 ? "" : "s"} → one draft each, approved in the Queue and spaced ${scheduleSpacingMinutes} min apart.`
    : autoPost
      ? "Autopost — one generated post, queued for the worker to publish without another review. Only use when you mean it."
      : scheduledFor
        ? "Scheduled — generates drafts to review; approved jobs wait for the chosen time."
        : replyToUrl.trim()
          ? "Reply draft — generates reply candidates for that post; review and approve before anything is sent."
          : "Review first — generates drafts here; approve one to queue it. Nothing is posted until Post in the Queue.";
  const nextStepWarning = autoPost;
  const submitLabel = postPlan === "batch"
    ? autoPost ? "Autopost batch" : "Create batch jobs"
    : autoPost
      ? "Autopost without review"
      : scheduledFor
        ? "Generate & schedule"
        : "Generate drafts";

  return (
    <form
      className="panel composer"
      onSubmit={(event) => {
        event.preventDefault();
        generateDrafts();
      }}
    >
      <div className="panel-head">
        <div>
          <h2 className="panel-title"><PanelIcon name="pencil" />New post</h2>
          <p className="empty">Start with the rough thought. Zyquor will shape the final copy.</p>
        </div>
      </div>
      <label className="idea-field" htmlFor="idea">
        Idea
        <textarea
          id="idea"
          value={idea}
          onChange={(event) => setIdea(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && idea.trim() && !busy) {
              event.preventDefault();
              generateDrafts();
            }
          }}
          placeholder={postPlan === "batch" ? "One post idea per line…" : "Enter a topic or rough post…"}
          rows={8}
        />
      </label>
      <div className="compose-options">
        <label>
          Plan
          <select disabled={busy} value={postPlan} onChange={(event) => setPostPlan(event.target.value)}>
            <option value="single">single</option>
            <option value="batch">batch</option>
          </select>
        </label>
        <label>
          Type
          <select
            value={replyToUrl.trim() && postPlan === "single" ? "reply" : tweetType}
            onChange={(event) => setTweetType(event.target.value)}
            disabled={busy || (Boolean(replyToUrl.trim()) && postPlan === "single")}
          >
            {tweetTypeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          Schedule
          <input disabled={busy} type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />
        </label>
        {postPlan === "batch" ? (
          <label>
            Spacing
            <input
              max="480"
              min="15"
              step="15"
              disabled={busy}
              type="number"
              value={scheduleSpacingMinutes}
              onChange={(event) => setScheduleSpacingMinutes(Number(event.target.value))}
            />
          </label>
        ) : null}
        {postPlan === "single" && (showReplyTarget || replyToUrl.trim()) ? (
          <label className="reply-target-field">
            Reply target
            <input
              type="url"
              value={replyToUrl}
              onChange={(event) => setReplyToUrl(event.target.value)}
              onBlur={() => {
                if (!replyToUrl.trim()) setShowReplyTarget(false);
              }}
              placeholder="https://x.com/handle/status/123…"
            />
          </label>
        ) : postPlan === "single" ? (
          <button className="ghost reply-target-toggle" disabled={busy} type="button" onClick={() => setShowReplyTarget(true)}>+ Reply target</button>
        ) : null}
        <label className={autoPost ? "checkbox-row switch-row autopost-control warning" : "checkbox-row switch-row autopost-control"}>
          <input checked={autoPost} disabled={busy} type="checkbox" onChange={(event) => setAutoPost(event.target.checked)} />
          <span aria-hidden="true" className="switch" />
          <span>
            Autopost
            {autoPost ? <small>Posts without review</small> : null}
          </span>
        </label>
      </div>
      <p className={nextStepWarning ? "compose-next compose-next--warn" : "compose-next"}>
        <span aria-hidden="true" className="compose-next-mark" />
        {nextStep}
      </p>
      <div className="compose-submit-row">
        <button className="composer-submit" disabled={!trimmedIdea || busy}>
          <Busy active={busy} />
          {busy ? "Writing candidates…" : submitLabel}
        </button>
        <span className="compose-shortcut" title="Generate from the keyboard">⌘ / Ctrl + Enter</span>
      </div>
      {busy ? (
        <p className="compose-progress" role="status">Generating takes a few seconds up to about a minute. The rest of the app stays usable.</p>
      ) : !trimmedIdea ? (
        <p className="compose-hint">Add an idea above to continue.</p>
      ) : null}
    </form>
  );
}
