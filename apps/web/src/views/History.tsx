import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Busy, InlineError, errorMessage } from "../components/Feedback.js";
import type { PanelProps, PostHistory } from "../types.js";

export function HistoryView({ panel }: { panel: PanelProps }) {
  const { accountId, busy, refresh, refreshToken, run } = panel;
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
    if (!window.confirm("Delete this post from X as well as marking it deleted here?")) return;
    run(async () => {
      await api(`/history/${item.id}/delete`, { method: "POST" });
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
      ) : loaded && !loadError ? <div className="view-empty-state"><p>Nothing posted yet</p></div> : !loadError ? <p className="empty">Loading history…</p> : null}
    </section>
  );
}
