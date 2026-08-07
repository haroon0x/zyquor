import { useEffect, useState } from "react";
import { api } from "../api.js";
import { CandidatesPanel, type CandidatesState } from "../components/CandidatesPanel.js";
import { Busy, PanelIcon, StatusBadge } from "../components/Feedback.js";
import type { Draft, DraftResponse, PanelProps, ReplyTarget } from "../types.js";

type ReplyDraft = Draft;

interface FeedTweet extends ReplyTarget {
  authorName: string;
  text: string;
  publishedAt: string | null;
  isRetweet: boolean;
}

function timeLabel(value: string | null | undefined) {
  if (!value) return "";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString();
}

export function RepliesView({ panel }: { panel: PanelProps }) {
  const { accountId, busy, refresh, refreshToken, reportError, run } = panel;
  const [targetUrl, setTargetUrl] = useState("");
  const [feed, setFeed] = useState<{ tweets: FeedTweet[]; accounts: Array<{ authorHandle: string; authorName: string }>; adsSkipped?: number } | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<ReplyDraft[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [editedText, setEditedText] = useState("");
  const [autoPost, setAutoPost] = useState(true);
  const [postPlan, setPostPlan] = useState("single");
  const [scheduledFor, setScheduledFor] = useState("");
  const [scheduleSpacingMinutes, setScheduleSpacingMinutes] = useState(90);

  const candidatesState: CandidatesState = {
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
  };

  useEffect(() => {
    let active = true;
    void api<{ drafts: ReplyDraft[] }>(`/replies/drafts?accountId=${encodeURIComponent(accountId)}`)
      .then(({ drafts: loaded }) => {
        if (active) setDrafts(loaded);
      })
      .catch((error) => {
        if (active) reportError(error, "Could not load reply drafts");
      });
    return () => {
      active = false;
    };
  }, [accountId, refreshToken, reportError]);

  function draftFromLink(url: string) {
    run(async () => {
      const response = await api<DraftResponse & { replyTo?: ReplyTarget }>("/replies/from-url", {
        method: "POST",
        body: JSON.stringify({ accountId, url })
      });
      setDraft({ draft: response.draft, candidates: response.candidates });
      setEditedText(response.candidates[0]?.text ?? "");
      setTargetUrl("");
      await refresh();
    });
  }

  function scanFeed() {
    run(async () => {
      const response = await api<{ tweets: FeedTweet[]; accounts: Array<{ authorHandle: string; authorName: string }>; adsSkipped?: number }>(
        `/replies/feed?accountId=${encodeURIComponent(accountId)}`
      );
      setFeed(response);
      setFeedError(null);
    });
  }

  function reviewDraft(loaded: ReplyDraft) {
    run(async () => {
      const response = await api<DraftResponse>(`/drafts/${loaded.id}`);
      setDraft({ draft: response.draft, candidates: response.candidates });
      setEditedText(response.draft.editedText ?? response.candidates[0]?.text ?? "");
    });
  }

  function deleteDraft(id: string) {
    setDeletingId(id);
    run(async () => {
      try {
        await api(`/drafts/${id}`, { method: "DELETE" });
        setDrafts((current) => current.filter((item) => item.id !== id));
        if (draft?.draft.id === id) {
          setDraft(null);
          setEditedText("");
        }
      } finally {
        setDeletingId(null);
      }
    });
  }

  return (
    <div className="replies-view">
      <section className="panel composer">
        <div className="panel-head">
          <div>
            <h2 className="panel-title"><PanelIcon name="inbox" />Reply to a post</h2>
            <p className="empty">Paste an x.com post link. Zyquor reads it, drafts an opinionated reply, and waits for your approval.</p>
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (targetUrl.trim()) draftFromLink(targetUrl.trim());
          }}
        >
          <label className="idea-field" htmlFor="reply-url">
            Post URL
            <input
              id="reply-url"
              placeholder="https://x.com/author/status/123…"
              value={targetUrl}
              onChange={(event) => setTargetUrl(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <button disabled={!targetUrl.trim() || busy} type="submit">
              <Busy active={busy} />Draft reply
            </button>
          </div>
        </form>
      </section>

      <CandidatesPanel panel={panel} state={candidatesState} />

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title"><PanelIcon name="zap" />From my feed</h2>
            <p className="empty">Scan your X home feed to find posts worth replying to and accounts to follow.</p>
          </div>
          <div className="panel-head-actions">
            <button className="secondary compact-button" disabled={busy} onClick={scanFeed}>
              <Busy active={busy} />Scan feed
            </button>
          </div>
        </div>
        {feedError ? <p className="notice error">{feedError}</p> : null}
        {feed ? (
          <div className="feed-targets data-content">
            {feed.adsSkipped ? <p className="notice">Skipped {feed.adsSkipped} ad/spam posts (promoted or link-heavy).</p> : null}
            <div className="feed-accounts">
              {feed.accounts.map((account) => (
                <span className="pill" key={account.authorHandle}>@{account.authorHandle}</span>
              ))}
            </div>
            <ul className="feed-tweet-list">
              {feed.tweets.map((tweet) => (
                <li className="feed-tweet-row" key={tweet.url}>
                  <div className="feed-tweet-details">
                    <strong>{tweet.authorName} · @{tweet.authorHandle}</strong>
                    <p>{tweet.text}</p>
                    <time dateTime={tweet.publishedAt ?? undefined}>{timeLabel(tweet.publishedAt)}</time>
                  </div>
                  <div className="feed-tweet-actions">
                    <button className="secondary compact-button" disabled={busy} onClick={() => draftFromLink(tweet.url)}>
                      Draft reply
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <h2 className="panel-title"><PanelIcon name="clock" />Reply drafts</h2>
            <p className="empty">Every reply starts as a draft. Approve one and it joins the auto-post queue.</p>
          </div>
        </div>
        {drafts.length ? (
          <div className="data-content">
            {drafts.map((item) => (
              <article className="reply-draft-row" key={item.id}>
                <div className="reply-draft-details">
                  <strong>@{item.replyTo?.authorHandle}</strong>
                  <span className="reply-draft-snippet">{item.replyTo?.text ?? item.sourceInput}</span>
                  <a href={item.replyTo?.url} rel="noreferrer" target="_blank">{item.replyTo?.url}</a>
                </div>
                <div className="reply-draft-actions">
                  <StatusBadge status={item.status} />
                  <button className="secondary compact-button" disabled={busy} onClick={() => reviewDraft(item)}>
                    Review
                  </button>
                  <button className="ghost danger compact-button" disabled={busy} onClick={() => deleteDraft(item.id)}>
                    <Busy active={deletingId === item.id} />Delete
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty">No reply drafts yet.</p>
        )}
      </section>
    </div>
  );
}
