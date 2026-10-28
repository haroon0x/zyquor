import { useEffect, useState } from "react";
import { api } from "../api.js";
import { CandidatesPanel, type CandidatesState } from "../components/CandidatesPanel.js";
import { Busy, PanelIcon, StatusBadge } from "../components/Feedback.js";
import type {
  Draft,
  DraftResponse,
  MentionItem,
  PanelProps,
  ReplyMemoryInfo,
  ReplyTarget
} from "../types.js";

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

function countLabel(count: number, singular: string, plural: string) {
  return `${count} ${count === 1 ? singular : plural}`;
}

// One line under the draft composer so the user can see whether (and with
// what) the reply was grounded in Goldfish memory.
function memoryNote(info: ReplyMemoryInfo | undefined | null) {
  if (!info) return null;
  if (info.used) {
    const parts: string[] = [];
    if (info.wikiCount) parts.push(countLabel(info.wikiCount, "wiki fact", "wiki facts"));
    if (info.memoryCount) parts.push(countLabel(info.memoryCount, "memory", "memories"));
    const detail = parts.length ? parts.join(" + ") : "no entries";
    return `Grounded in Goldfish memory (${detail}).`;
  }
  if (info.reason === "empty") return "No relevant Goldfish memory for this author; drafted without memory.";
  if (info.reason === "disabled") return "Goldfish memory is turned off for this reply.";
  return "Goldfish memory is unavailable right now; drafted without memory.";
}

export function RepliesView({ panel }: { panel: PanelProps }) {
  const { accountId, busy, refresh, refreshToken, reportError, run } = panel;
  const [targetUrl, setTargetUrl] = useState("");
  const [useMemory, setUseMemory] = useState(true);
  const [memoryInfo, setMemoryInfo] = useState<ReplyMemoryInfo | null>(null);
  const [feed, setFeed] = useState<{ tweets: FeedTweet[]; accounts: Array<{ authorHandle: string; authorName: string }>; adsSkipped?: number } | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [mentions, setMentions] = useState<MentionItem[] | null>(null);
  const [selectedMentions, setSelectedMentions] = useState<Set<string>>(new Set());
  const [mentionsError, setMentionsError] = useState<string | null>(null);
  const [mentionBusy, setMentionBusy] = useState(false);
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

  function applyDraftResponse(response: DraftResponse) {
    setDraft({ draft: response.draft, candidates: response.candidates });
    setEditedText(response.candidates[0]?.text ?? "");
    setMemoryInfo(response.memory ?? null);
  }

  function draftFromLink(url: string) {
    run(async () => {
      const response = await api<DraftResponse & { replyTo?: ReplyTarget }>("/replies/from-url", {
        method: "POST",
        body: JSON.stringify({ accountId, url, useMemory })
      });
      applyDraftResponse(response);
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

  function scanMentions() {
    setMentionBusy(true);
    void api<{ mentions: MentionItem[]; scanned: number; adsSkipped: number }>(
      `/replies/mentions?accountId=${encodeURIComponent(accountId)}`
    )
      .then((response) => {
        setMentions(response.mentions);
        setMentionsError(null);
        // Default the selection to the actionable rows: fresh mentions that
        // are neither drafted nor posted already.
        setSelectedMentions(
          new Set(
            response.mentions
              .filter((item) => !item.drafted && !item.posted)
              .map((item) => item.url)
          )
        );
      })
      .catch((error: unknown) => {
        setMentionsError(error instanceof Error ? error.message : "Mentions scan failed");
      })
      .finally(() => setMentionBusy(false));
  }

  function draftMentionReplies(urls: string[]) {
    if (urls.length === 0) return;
    setMentionBusy(true);
    void api<{
      created: Array<{ draft: ReplyDraft; candidates: DraftResponse["candidates"] }>;
      skipped: Array<{ url: string; reason: string }>;
    }>("/replies/mentions/draft", {
      method: "POST",
      body: JSON.stringify({ accountId, mentions: urls.map((url) => ({ url })), useMemory })
    })
      .then(async (response) => {
        setMentions((current) =>
          current
            ? current.map((item) =>
                response.created.some((entry) => entry.draft.replyTo?.url === item.url)
                  ? { ...item, drafted: true }
                  : item
              )
            : current
        );
        setSelectedMentions((current) => {
          const next = new Set(current);
          for (const entry of response.created) {
            const url = entry.draft.replyTo?.url;
            if (url) next.delete(url);
          }
          return next;
        });
        const first = response.created[0];
        if (first) {
          applyDraftResponse({ draft: first.draft, candidates: first.candidates, memory: undefined });
          setMemoryInfo(null);
        }
        const skipped = response.skipped ?? [];
        if (skipped.length) {
          reportError(
            new Error(
              skipped
                .map((item) => `${item.reason}: ${item.url}`)
                .join("; ")
            ),
            "Some mentions were skipped"
          );
        }
        const reloaded = await api<{ drafts: ReplyDraft[] }>(
          `/replies/drafts?accountId=${encodeURIComponent(accountId)}`
        );
        setDrafts(reloaded.drafts);
        await refresh();
      })
      .catch((error: unknown) => {
        reportError(error, "Could not draft mention replies");
      })
      .finally(() => setMentionBusy(false));
  }

  function reviewDraft(loaded: ReplyDraft) {
    run(async () => {
      const response = await api<DraftResponse>(`/drafts/${loaded.id}`);
      setDraft({ draft: response.draft, candidates: response.candidates });
      setEditedText(response.draft.editedText ?? response.candidates[0]?.text ?? "");
      setMemoryInfo(null);
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

  const memoryLabel = memoryNote(memoryInfo);
  const selectedMentionCount = selectedMentions.size;
  const creatableMentions = (mentions ?? []).filter((item) => !item.drafted && !item.posted).length;

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
          <label className="switch-row reply-memory-switch">
            <input
              checked={useMemory}
              type="checkbox"
              onChange={(event) => setUseMemory(event.target.checked)}
            />
            <span aria-hidden="true" className="switch" />
            Ground replies in my Goldfish memory
          </label>
          <div className="form-actions">
            <button disabled={!targetUrl.trim() || busy} type="submit">
              <Busy active={busy} />Draft reply
            </button>
          </div>
        </form>
      </section>

      <CandidatesPanel panel={panel} state={candidatesState} />
      {draft && memoryLabel ? <p className="notice">{memoryLabel}</p> : null}

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
            <h2 className="panel-title"><PanelIcon name="list-checks" />Mentions</h2>
            <p className="empty">Fresh mentions from the last 48 hours. Select some and Zyquor drafts replies for review; nothing is posted automatically.</p>
          </div>
          <div className="panel-head-actions">
            <button className="secondary compact-button" disabled={mentionBusy} onClick={scanMentions}>
              <Busy active={mentionBusy} />Scan mentions
            </button>
          </div>
        </div>
        {mentionsError ? <p className="notice error">{mentionsError}</p> : null}
        {mentions ? (
          <div className="feed-targets data-content">
            {mentions.length === 0 ? (
              <p className="empty">No fresh mentions in the last 48 hours. Scan again later.</p>
            ) : (
              <>
                {selectedMentionCount > 0 ? (
                  <div className="form-actions">
                    <button
                      className="secondary compact-button"
                      disabled={mentionBusy}
                      onClick={() => draftMentionReplies(Array.from(selectedMentions))}
                    >
                      <Busy active={mentionBusy} />Draft selected replies ({selectedMentionCount})
                    </button>
                  </div>
                ) : null}
                <ul className="feed-tweet-list">
                  {mentions.map((mention) => {
                    const creatable = !mention.drafted && !mention.posted;
                    const checked = selectedMentions.has(mention.url);
                    return (
                      <li className="feed-tweet-row" key={mention.url}>
                        {creatable ? (
                          <input
                            aria-label={`Select reply draft for @${mention.authorHandle}: ${mention.text.slice(0, 60)}`}
                            checked={checked}
                            className="mentions-check"
                            type="checkbox"
                            onChange={(event) =>
                              setSelectedMentions((current) => {
                                const next = new Set(current);
                                if (event.target.checked) {
                                  next.add(mention.url);
                                } else {
                                  next.delete(mention.url);
                                }
                                return next;
                              })
                            }
                          />
                        ) : null}
                        <div className="feed-tweet-details">
                          <strong>
                            {mention.authorName ?? mention.authorHandle} · @{mention.authorHandle}
                          </strong>
                          <p>{mention.text}</p>
                          <time dateTime={mention.publishedAt ?? undefined}>{timeLabel(mention.publishedAt)}</time>
                          {mention.drafted ? <span className="pill pill--drafted">Drafted</span> : null}
                          {mention.posted ? <span className="pill pill--posted">Posted</span> : null}
                        </div>
                        <div className="feed-tweet-actions">
                          {creatable ? (
                            <button
                              className="secondary compact-button"
                              disabled={mentionBusy}
                              onClick={() => draftMentionReplies([mention.url])}
                            >
                              Draft reply
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        ) : (
          <p className="empty">
            Not scanned yet. This scans the logged-in {`account's`} mentions tab and lists who talked about you; posters
            already handled show as Drafted or Posted ({countLabel(creatableMentions, "item", "items")} actionable after a scan).
          </p>
        )}
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
