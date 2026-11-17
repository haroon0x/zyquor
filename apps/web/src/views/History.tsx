import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Busy, InlineError, errorMessage } from "../components/Feedback.js";
import type { PanelProps, PostHistory } from "../types.js";

export function HistoryView({ panel }: { panel: PanelProps }) {
  const { accountId, busy, navigate, notify, refresh, refreshToken, run } = panel;
  const [history, setHistory] = useState<PostHistory[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setHistory([]);
    setLoaded(false);
    setLoadError(null);
    void api<{ history: PostHistory[] }>("/history")
      .then(({ history: loadedHistory }) => {
        if (active) setHistory(loadedHistory.filter((item) => item.accountId === accountId));
      })
      .catch((error) => {
        if (active) setLoadError(errorMessage(error, "History unavailable"));
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [accountId, refreshToken]);

  function deletePost(item: PostHistory) {
    if (!window.confirm("Delete this post from X? This removes it from your timeline and cannot be undone.")) return;
    run(async () => {
      await api(`/history/${item.id}/delete`, { method: "POST" });
      notify("Deleted from X and marked as deleted in History.", "success");
      await refresh();
    });
  }

  return (
    <section className="history-panel">
      <InlineError message={loadError} />
      {history.length ? (
        <div className="history-list">
          {history.map((item) => {
            const sourceLink = item.sourceUrl ?? item.postUrl;
            const deleted = typeof item.metadata?.deletedAt === "string";
            return (
              <article className="history-row" key={item.id}>
                <p>{item.postedText}</p>
                <div className="history-meta">
                  <time dateTime={item.postedAt}>{new Date(item.postedAt).toLocaleString()}</time>
                  <span>{item.tweetType ?? "post"}</span>
                  {deleted ? <span className="pill pill--failed">deleted</span> : null}
                  {sourceLink ? <a href={sourceLink} rel="noreferrer" target="_blank">{item.sourceTitle ?? (item.sourceUrl ? "Source" : "View post")}</a> : null}
                  {!deleted && item.postUrl ? (
                    <button aria-label="Delete post from X" className="ghost danger compact-button" disabled={busy} title="Delete from X" onClick={() => deletePost(item)}>
                      <Busy active={busy} />Delete
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : loaded && !loadError ? (
        <div className="view-empty-state">
          <p>Nothing posted yet</p>
          <p className="empty-state-hint">Approve a draft in Compose, then publish it from the Queue. Posts appear here with their permalinks for 24 hours.</p>
          <button className="secondary compact-button" type="button" onClick={() => navigate("queue")}>Open the Queue</button>
        </div>
      ) : !loadError ? (
        <div aria-label="Loading history" className="skeleton-table">
          {[0, 1, 2].map((row) => (
            <div className="skeleton-row" key={row}>
              <span className="skeleton-line" />
              <span className="skeleton-line skeleton-line--short" />
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
