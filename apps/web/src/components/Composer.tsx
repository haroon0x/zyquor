import { api } from "../api.js";
import type { Draft, DraftResponse, Job, PanelProps } from "../types.js";
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
  setEditedText: (text: string) => void;
  setIdea: (idea: string) => void;
  setPostPlan: (plan: string) => void;
  setReplyToUrl: (url: string) => void;
  setTweetType: (tweetType: string) => void;
}

export function Composer({ panel, state }: { panel: PanelProps; state: ComposerState }) {
  const { accountId, busy, refresh, run } = panel;
  const {
    autoPost,
    idea,
    postPlan,
    replyToUrl,
    scheduleSpacingMinutes,
    scheduledFor,
    tweetType,
    setDraft,
    setEditedText,
    setIdea,
    setPostPlan,
    setReplyToUrl,
    setTweetType
  } = state;

  function generateDrafts() {
    run(async () => {
      const mode = autoPost ? "autopost" : scheduledFor ? "scheduled" : "prepare_only";

      if (autoPost && postPlan === "single") {
        await api<{ draft: Draft; job: Job }>("/drafts", {
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
        setDraft(null);
        setEditedText("");
        await refresh();
        return;
      }

      if (postPlan === "batch") {
        const ideas = idea
          .split(/\n+/)
          .map((line) => line.trim())
          .filter(Boolean);
        await api<{ items: Array<{ draft: Draft; job: Job }> }>("/draft-batches", {
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
        return;
      }

      const response = await api<DraftResponse>("/drafts", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          idea,
          count: 3,
          tweetType,
          ...(replyToUrl.trim() ? { replyToUrl: replyToUrl.trim() } : {})
        })
      });
      setDraft(response);
      setEditedText(response.candidates[0]?.text ?? "");
    });
  }

  return (
    <form
      className="panel composer"
      onSubmit={(event) => {
        event.preventDefault();
        generateDrafts();
      }}
    >
      <div className="panel-head">
        <h2 className="panel-title"><PanelIcon name="pencil" />Composer</h2>
      </div>
      <label htmlFor="idea">Idea</label>
      <textarea
        id="idea"
        value={idea}
        onChange={(event) => setIdea(event.target.value)}
        placeholder={postPlan === "batch" ? "One tweet idea per line..." : "Write rough idea..."}
        rows={8}
      />
      {postPlan === "single" ? (
        <label>
          Reply to URL
          <input
            type="url"
            value={replyToUrl}
            onChange={(event) => setReplyToUrl(event.target.value)}
            placeholder="https://x.com/handle/status/123..."
          />
        </label>
      ) : null}
      <div className="schedule-grid">
        <label>
          Plan
          <select value={postPlan} onChange={(event) => setPostPlan(event.target.value)}>
            <option value="single">single</option>
            <option value="batch">batch</option>
          </select>
        </label>
        <label>
          Type
          <select
            value={replyToUrl.trim() && postPlan === "single" ? "reply" : tweetType}
            onChange={(event) => setTweetType(event.target.value)}
            disabled={Boolean(replyToUrl.trim()) && postPlan === "single"}
          >
            {tweetTypeOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button disabled={!idea.trim() || busy}>
        <Busy active={busy} />
        {postPlan === "batch" ? "Create batch jobs" : autoPost ? "Autopost" : "Generate drafts"}
      </button>
    </form>
  );
}
