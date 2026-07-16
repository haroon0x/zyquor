import { useEffect, useState } from "react";
import { api } from "../api.js";
import { InlineError, errorMessage } from "../components/Feedback.js";
import type { PanelProps, PostHistory } from "../types.js";

export function HistoryView({ panel }: { panel: PanelProps }) {
  const { accountId, refreshToken } = panel;
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

  return (
    <section className="history-panel">
      <InlineError message={loadError} />
      {history.length ? (
        <div className="history-list">
          {history.map((item) => {
            const sourceLink = item.sourceUrl ?? item.postUrl;
            return (
              <article className="history-row" key={item.id}>
                <p>{item.postedText}</p>
                <div className="history-meta">
                  <time dateTime={item.postedAt}>{new Date(item.postedAt).toLocaleString()}</time>
                  <span>{item.tweetType ?? "post"}</span>
                  {sourceLink ? <a href={sourceLink} rel="noreferrer" target="_blank">{item.sourceTitle ?? (item.sourceUrl ? "Source" : "View post")}</a> : null}
                </div>
              </article>
            );
          })}
        </div>
      ) : loaded && !loadError ? <div className="view-empty-state"><p>Nothing posted yet</p></div> : !loadError ? <p className="empty">Loading history…</p> : null}
    </section>
  );
}
