import { useState } from "react";
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
          placeholder={postPlan === "batch" ? "One post idea per line…" : "What do you want to say?"}
          rows={8}
        />
      </label>
      <div className="compose-options">
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
        <label>
          Schedule
          <input type="datetime-local" value={scheduledFor} onChange={(event) => setScheduledFor(event.target.value)} />
        </label>
        {postPlan === "batch" ? (
          <label>
            Spacing
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
          <button className="ghost reply-target-toggle" type="button" onClick={() => setShowReplyTarget(true)}>+ Reply target</button>
        ) : null}
        <label className={autoPost ? "checkbox-row switch-row autopost-control warning" : "checkbox-row switch-row autopost-control"}>
          <input checked={autoPost} type="checkbox" onChange={(event) => setAutoPost(event.target.checked)} />
          <span aria-hidden="true" className="switch" />
          <span>
            Autopost
            {autoPost ? <small>Posts without review</small> : null}
          </span>
        </label>
      </div>
      <button className="composer-submit" disabled={!idea.trim() || busy}>
        <Busy active={busy} />
        {postPlan === "batch" ? "Create batch jobs" : autoPost ? "Autopost" : "Generate drafts"}
      </button>
    </form>
  );
}
