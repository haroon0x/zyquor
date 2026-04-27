import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface Account {
  id: string;
  displayName: string;
  handle: string;
  postingMode: string;
  profileDir: string;
  styleProfileId: string;
  enabled: boolean;
  dailyPostLimit: number | null;
  quietHoursEnd: string | null;
  quietHoursStart: string | null;
}

interface Draft {
  id: string;
  sourceInput: string;
  editedText: string | null;
  status: string;
}

interface Candidate {
  id: string;
  text: string;
  selected: boolean;
}

interface DraftResponse {
  draft: Draft;
  candidates: Candidate[];
}

interface Job {
  id: string;
  accountId: string;
  draftId: string;
  status: string;
  mode: string;
  scheduledFor: string | null;
  approvedAt: string | null;
}

interface Attempt {
  id: string;
  jobId: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  screenshotPath: string | null;
  tracePath: string | null;
}

interface GenerationConfig {
  provider: string;
  model: string;
  configured: boolean;
  baseUrl?: string;
}

interface BrowserSession {
  accountId: string;
  cdpUrl: string | null;
  enabled: boolean;
  error: string | null;
  loggedIn: boolean;
  profileDir: string;
  url: string | null;
}

interface SourcePacket {
  id: string;
  accountId: string;
  facts: string[];
  sourceType: string;
  status: string;
  summary: string;
  title: string;
  tweetType: string;
  url: string | null;
}

const X_FREE_POST_CHARACTER_LIMIT = 280;
interface StyleProfile {
  id: string;
  name: string;
  description: string | null;
  tone: string | null;
  rules: Record<string, unknown>;
  bannedPhrases: string[];
  examplePosts: string[];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = {
    ...(init?.body ? { "content-type": "application/json" } : {}),
    ...init?.headers
  };
  const response = await fetch(`/api${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState("account_personal");
  const [postPlan, setPostPlan] = useState("single");
  const [tweetType, setTweetType] = useState("useful_info");
  const [idea, setIdea] = useState("");
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [editedText, setEditedText] = useState("");
  const [autoPost, setAutoPost] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [scheduleSpacingMinutes, setScheduleSpacingMinutes] = useState(90);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [attemptsByJob, setAttemptsByJob] = useState<Record<string, Attempt[]>>({});
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(null);
  const [generation, setGeneration] = useState<GenerationConfig | null>(null);
  const [generationDraft, setGenerationDraft] = useState({ model: "", provider: "mock" });
  const [sourcePackets, setSourcePackets] = useState<SourcePacket[]>([]);
  const [packetDraft, setPacketDraft] = useState({
    facts: "",
    sourceType: "manual",
    summary: "",
    title: "",
    tweetType: "useful_info",
    url: ""
  });
  const [styleProfile, setStyleProfile] = useState<StyleProfile | null>(null);
  const [systemPromptExtra, setSystemPromptExtra] = useState("");
  const [objective, setObjective] = useState("Maximize useful reach, views, and reputation without cheap spam.");
  const [bannedPhrases, setBannedPhrases] = useState("game changer\nunlock\n10x");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState<string[]>([]);
  const refreshRequestIdRef = useRef(0);

  useEffect(() => {
    void refresh().catch((caught) => {
      setError(caught instanceof Error ? caught.message : "API unavailable");
    });
  }, []);

  async function refresh() {
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    const [{ accounts: loadedAccounts }, { generation: loadedGeneration }] = await Promise.all([
      api<{ accounts: Account[] }>("/accounts"),
      api<{ generation: GenerationConfig }>("/generation")
    ]);
    const nextActiveAccount = loadedAccounts.find((account) => account.id === activeAccountId) ?? loadedAccounts[0] ?? null;
    const nextActiveAccountId = nextActiveAccount?.id ?? activeAccountId;
    const [{ jobs: loadedJobs }, { packets: loadedSourcePackets }] = await Promise.all([
      api<{ jobs: Job[] }>(`/jobs?accountId=${encodeURIComponent(nextActiveAccountId)}`),
      api<{ packets: SourcePacket[] }>(`/source-packets?accountId=${encodeURIComponent(nextActiveAccountId)}`)
    ]);
    const attemptsEntries = await Promise.all(
      loadedJobs.map(async (job) => {
        const { attempts } = await api<{ attempts: Attempt[] }>(`/jobs/${job.id}/attempts`);
        return [job.id, attempts] as const;
      })
    );
    if (requestId !== refreshRequestIdRef.current) {
      return;
    }
    const availableJobIds = new Set(loadedJobs.map((job) => job.id));

    setAccounts(loadedAccounts);
    setJobs(loadedJobs);
    setGeneration(loadedGeneration);
    setGenerationDraft({ model: loadedGeneration.model, provider: loadedGeneration.provider });
    setSourcePackets(loadedSourcePackets);
    setAttemptsByJob(Object.fromEntries(attemptsEntries));
    setSelectedJobIds((current) => current.filter((id) => availableJobIds.has(id)));
    if (nextActiveAccount) {
      setActiveAccountId(nextActiveAccount.id);
      await loadStyleProfile(nextActiveAccount.styleProfileId);
    }
  }

  async function loadStyleProfile(styleProfileId: string) {
    const { profile } = await api<{ profile: StyleProfile }>(`/style-profiles/${styleProfileId}`);
    setStyleProfile(profile);
    setSystemPromptExtra(typeof profile.rules.systemPromptExtra === "string" ? profile.rules.systemPromptExtra : "");
    setObjective(
      typeof profile.rules.objective === "string"
        ? profile.rules.objective
        : "Maximize useful reach, views, and reputation without cheap spam."
    );
    setBannedPhrases(profile.bannedPhrases.join("\n"));
  }

  async function loadSourcePackets(accountId: string) {
    const { packets } = await api<{ packets: SourcePacket[] }>(
      `/source-packets?accountId=${encodeURIComponent(accountId)}`
    );
    setSourcePackets(packets);
  }

  function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    void action()
      .catch((caught) => {
        setError(caught instanceof Error ? caught.message : "Unknown error");
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function generateDrafts() {
    run(async () => {
      const mode = autoPost ? "autopost" : scheduledFor ? "scheduled" : "prepare_only";

      if (autoPost && postPlan === "single") {
        const created = await api<DraftResponse>("/drafts", {
          method: "POST",
          body: JSON.stringify({ accountId: activeAccountId, idea, count: 1, tweetType })
        });
        const text = created.candidates[0]?.text;
        if (!text) {
          throw new Error("Yolo generation returned no candidate");
        }
        const approved = await api<{ draft: Draft; job: Job }>(`/drafts/${created.draft.id}/approve`, {
          method: "POST",
          body: JSON.stringify({
            editedText: text,
            mode,
            scheduledFor: scheduledFor ? new Date(scheduledFor).toISOString() : null
          })
        });
        if (!scheduledFor) {
          await api(`/jobs/${approved.job.id}/post`, { method: "POST" });
        }
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
            accountId: activeAccountId,
            ideas,
            mode,
            scheduleSpacingMinutes,
            scheduleStart: scheduledFor ? new Date(scheduledFor).toISOString() : null,
            tweetType
          })
        });
        setDraft(null);
        setEditedText("");
        await refresh();
        return;
      }

      const response = await api<DraftResponse>("/drafts", {
        method: "POST",
        body: JSON.stringify({ accountId: activeAccountId, idea, count: 3, tweetType })
      });
      setDraft(response);
      setEditedText(response.candidates[0]?.text ?? "");
    });
  }

  function selectCandidate(candidate: Candidate) {
    if (!draft) {
      return;
    }

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
    if (!draft) {
      return;
    }

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

  function prepareJob(job: Job) {
    run(async () => {
      await api(`/jobs/${job.id}/prepare`, { method: "POST" });
      await refresh();
    });
  }

  function postJob(job: Job) {
    run(async () => {
      await api(`/jobs/${job.id}/post`, { method: "POST" });
      await refresh();
    });
  }

  function postAllReadyJobs() {
    run(async () => {
      const result = await api<{
        failed: number;
        posted: number;
        total: number;
      }>("/jobs/post-ready", {
        method: "POST",
        body: JSON.stringify({ accountId: activeAccountId })
      });
      await refresh();
      if (result.failed > 0) {
        setError(`Post all finished: ${result.posted}/${result.total} posted, ${result.failed} failed.`);
      }
    });
  }

  function prepareAllReadyJobs() {
    run(async () => {
      const now = Date.now();
      const readyJobs = jobs.filter((job) => {
        if (job.accountId !== activeAccountId) {
          return false;
        }
        if (job.status !== "approved" && job.status !== "failed") {
          return false;
        }
        if (!job.scheduledFor) {
          return true;
        }
        return Date.parse(job.scheduledFor) <= now;
      });
      for (const job of readyJobs) {
        await api(`/jobs/${job.id}/prepare`, { method: "POST" });
      }
      await refresh();
    });
  }

  function deleteJob(job: Job) {
    run(async () => {
      await api(`/jobs/${job.id}`, { method: "DELETE" });
      await refresh();
    });
  }

  function toggleJobSelection(jobId: string) {
    setSelectedJobIds((current) =>
      current.includes(jobId) ? current.filter((id) => id !== jobId) : [...current, jobId]
    );
  }

  function clearJobSelection() {
    setSelectedJobIds([]);
  }

  function deleteSelectedJobs() {
    run(async () => {
      const selected = jobs.filter((job) => selectedJobIds.includes(job.id) && job.accountId === activeAccountId);
      for (const job of selected) {
        if (job.status === "failed" || job.status === "prepared") {
          await api(`/jobs/${job.id}`, { method: "DELETE" });
        }
      }
      setSelectedJobIds([]);
      await refresh();
    });
  }

  function checkBrowserSession() {
    run(async () => {
      const session = await api<BrowserSession>(`/browser/x-session?accountId=${encodeURIComponent(activeAccountId)}`);
      setBrowserSession(session);
    });
  }

  function saveStyleProfile() {
    if (!styleProfile) {
      return;
    }

    run(async () => {
      const { profile } = await api<{ profile: StyleProfile }>(`/style-profiles/${styleProfile.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          bannedPhrases: bannedPhrases
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean),
          rules: {
            ...styleProfile.rules,
            objective,
            systemPromptExtra
          },
          tone: styleProfile.tone
        })
      });
      setStyleProfile(profile);
    });
  }

  function saveGenerationConfig() {
    run(async () => {
      const { generation: savedGeneration } = await api<{ generation: GenerationConfig }>("/generation", {
        method: "PATCH",
        body: JSON.stringify({
          model: generationDraft.model.trim(),
          provider: generationDraft.provider
        })
      });
      setGeneration(savedGeneration);
      setGenerationDraft({ model: savedGeneration.model, provider: savedGeneration.provider });
    });
  }

  function createSourcePacket() {
    run(async () => {
      await api<{ packet: SourcePacket }>("/source-packets", {
        method: "POST",
        body: JSON.stringify({
          accountId: activeAccountId,
          facts: packetDraft.facts
            .split(/\n+/)
            .map((line) => line.trim())
            .filter(Boolean),
          sourceType: packetDraft.sourceType,
          summary: packetDraft.summary,
          title: packetDraft.title,
          tweetType: packetDraft.tweetType,
          url: packetDraft.url.trim() || null
        })
      });
      setPacketDraft({ ...packetDraft, facts: "", summary: "", title: "", url: "" });
      await refresh();
    });
  }

  function draftFromSourcePacket(packet: SourcePacket) {
    run(async () => {
      const response = await api<DraftResponse & { packet: SourcePacket }>(`/source-packets/${packet.id}/draft`, {
        method: "POST"
      });
      setDraft({ draft: response.draft, candidates: response.candidates });
      setEditedText(response.candidates[0]?.text ?? "");
      await refresh();
    });
  }

  const activeAccount = accounts.find((account) => account.id === activeAccountId);
  const accountJobs = jobs.filter((job) => job.accountId === activeAccountId);
  const nowMs = Date.now();
  const scheduledLaterJobs = accountJobs.filter(
    (job) => Boolean(job.scheduledFor) && Date.parse(job.scheduledFor ?? "") > nowMs
  );
  const failedJobs = accountJobs.filter((job) => job.status === "failed");
  const postedJobs = accountJobs.filter((job) => job.status === "posted");
  const readyNowJobs = accountJobs.filter((job) => {
    if (job.status !== "approved" && job.status !== "prepared") {
      return false;
    }
    if (!job.scheduledFor) {
      return true;
    }
    return Date.parse(job.scheduledFor) <= nowMs;
  });
  const otherJobs = accountJobs.filter(
    (job) =>
      !readyNowJobs.some((item) => item.id === job.id) &&
      !scheduledLaterJobs.some((item) => item.id === job.id) &&
      !failedJobs.some((item) => item.id === job.id) &&
      !postedJobs.some((item) => item.id === job.id)
  );
  const selectedDeletableJobs = accountJobs.filter(
    (job) => selectedJobIds.includes(job.id) && (job.status === "failed" || job.status === "prepared")
  );
  const readyForBulkPrepare = accountJobs.filter((job) => {
    if (job.status !== "approved" && job.status !== "failed") {
      return false;
    }
    if (!job.scheduledFor) {
      return true;
    }
    return Date.parse(job.scheduledFor) <= nowMs;
  });

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Zyquor</p>
          <h1>Draft, review, prepare.</h1>
        </div>
        <select
          aria-label="Active account"
          value={activeAccountId}
          onChange={(event) => {
            const account = accounts.find((item) => item.id === event.target.value);
            setActiveAccountId(event.target.value);
            setBrowserSession(null);
            setSelectedJobIds([]);
            if (account) {
              void loadSourcePackets(account.id).catch((caught) => {
                setError(caught instanceof Error ? caught.message : "Source packets unavailable");
              });
              void loadStyleProfile(account.styleProfileId).catch((caught) => {
                setError(caught instanceof Error ? caught.message : "Style profile unavailable");
              });
            }
          }}
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.displayName}
            </option>
          ))}
        </select>
      </section>

      {activeAccount ? (
        <section className="account-strip">
          <span>@{activeAccount.handle}</span>
          {generation ? (
            <span className={generation.configured ? "provider-pill" : "provider-pill failed"}>
              {generation.provider}:{generation.model}
            </span>
          ) : null}
          {browserSession ? (
            <span className={browserSession.loggedIn ? "session-pill" : "session-pill failed"}>
              X {browserSession.loggedIn ? "logged in" : "logged out"}
            </span>
          ) : (
            <span className="session-pill unknown">X unchecked</span>
          )}
          <button className="strip-button" disabled={busy} onClick={checkBrowserSession}>
            Check X
          </button>
        </section>
      ) : null}

      {error ? <div className="alert">{error}</div> : null}

      <section className="workspace">
        <form
          className="panel composer"
          onSubmit={(event) => {
            event.preventDefault();
            generateDrafts();
          }}
        >
          <label htmlFor="idea">Idea</label>
          <textarea
            id="idea"
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            placeholder={postPlan === "batch" ? "One tweet idea per line..." : "Write rough idea..."}
            rows={8}
          />
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
              <select value={tweetType} onChange={(event) => setTweetType(event.target.value)}>
                <option value="feed_observation">feed_observation</option>
                <option value="news_context">news_context</option>
                <option value="useful_info">useful_info</option>
                <option value="guide">guide</option>
                <option value="lesson">lesson</option>
                <option value="tool">tool</option>
                <option value="opinion">opinion</option>
                <option value="reply">reply</option>
              </select>
            </label>
          </div>
          <button disabled={!idea.trim() || busy}>
            {postPlan === "batch" ? "Create batch jobs" : autoPost ? "Yolo post" : "Generate drafts"}
          </button>
        </form>

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
              Yolo autopost
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
      </section>

      <section className="panel source-packets">
        <div className="panel-head">
          <h2>Sources</h2>
          <span>{sourcePackets.length}</span>
        </div>
        <div className="source-layout">
          <form
            className="source-form"
            onSubmit={(event) => {
              event.preventDefault();
              createSourcePacket();
            }}
          >
            <div className="settings-grid">
              <label>
                Source
                <select
                  value={packetDraft.sourceType}
                  onChange={(event) => setPacketDraft({ ...packetDraft, sourceType: event.target.value })}
                >
                  <option value="manual">manual</option>
                  <option value="news">news</option>
                  <option value="feed">feed</option>
                  <option value="bookmark">bookmark</option>
                  <option value="note">note</option>
                  <option value="guide">guide</option>
                </select>
              </label>
              <label>
                Type
                <select
                  value={packetDraft.tweetType}
                  onChange={(event) => setPacketDraft({ ...packetDraft, tweetType: event.target.value })}
                >
                  <option value="feed_observation">feed_observation</option>
                  <option value="news_context">news_context</option>
                  <option value="useful_info">useful_info</option>
                  <option value="guide">guide</option>
                  <option value="lesson">lesson</option>
                  <option value="tool">tool</option>
                  <option value="opinion">opinion</option>
                  <option value="reply">reply</option>
                </select>
              </label>
              <label>
                Title
                <input value={packetDraft.title} onChange={(event) => setPacketDraft({ ...packetDraft, title: event.target.value })} />
              </label>
              <label>
                URL
                <input value={packetDraft.url} onChange={(event) => setPacketDraft({ ...packetDraft, url: event.target.value })} />
              </label>
              <label>
                Summary
                <textarea
                  value={packetDraft.summary}
                  onChange={(event) => setPacketDraft({ ...packetDraft, summary: event.target.value })}
                  rows={4}
                />
              </label>
              <label>
                Facts
                <textarea
                  value={packetDraft.facts}
                  onChange={(event) => setPacketDraft({ ...packetDraft, facts: event.target.value })}
                  placeholder="One fact per line"
                  rows={5}
                />
              </label>
            </div>
            <button disabled={!packetDraft.title.trim() || !packetDraft.summary.trim() || busy}>Create source</button>
          </form>

          <div className="source-list">
            {sourcePackets.length ? (
              sourcePackets.map((packet) => (
                <article className="source-card" key={packet.id}>
                  <div className="source-meta">
                    <strong>{packet.title}</strong>
                    <span>
                      {packet.sourceType} · {packet.tweetType} · {packet.status}
                    </span>
                  </div>
                  <p>{packet.summary}</p>
                  {packet.facts.length ? (
                    <ul>
                      {packet.facts.slice(0, 3).map((fact) => (
                        <li key={fact}>{fact}</li>
                      ))}
                    </ul>
                  ) : null}
                  <button className="secondary" disabled={busy} onClick={() => draftFromSourcePacket(packet)}>
                    Draft
                  </button>
                </article>
              ))
            ) : (
              <p className="empty">Manual, news, feed, bookmark, note, and guide packets appear here.</p>
            )}
          </div>
        </div>
      </section>

      {styleProfile ? (
        <section className="panel settings">
          <div className="panel-head">
            <h2>Prompt</h2>
            <span>{styleProfile.name}</span>
          </div>
          <div className="settings-grid">
            <label>
              Tone
              <input
                value={styleProfile.tone ?? ""}
                onChange={(event) => setStyleProfile({ ...styleProfile, tone: event.target.value || null })}
              />
            </label>
            <label>
              Objective
              <input value={objective} onChange={(event) => setObjective(event.target.value)} />
            </label>
            <label>
              Banned phrases
              <textarea value={bannedPhrases} onChange={(event) => setBannedPhrases(event.target.value)} rows={5} />
            </label>
            <label>
              Extra system prompt
              <textarea value={systemPromptExtra} onChange={(event) => setSystemPromptExtra(event.target.value)} rows={5} />
            </label>
          </div>
          <button disabled={busy} onClick={saveStyleProfile}>
            Save prompt
          </button>
        </section>
      ) : null}

      <section className="panel settings">
        <div className="panel-head">
          <h2>Model</h2>
          {generation ? (
            <span className={generation.configured ? "provider-pill" : "provider-pill failed"}>
              {generation.configured ? "configured" : "missing key"}
            </span>
          ) : null}
        </div>
        <div className="settings-grid">
          <label>
            Provider
            <select
              value={generationDraft.provider}
              onChange={(event) => setGenerationDraft({ ...generationDraft, provider: event.target.value })}
            >
              <option value="mock">mock</option>
              <option value="ollama">ollama</option>
              <option value="gemini">gemini</option>
            </select>
          </label>
          <label>
            Model name
            <input
              value={generationDraft.model}
              onChange={(event) => setGenerationDraft({ ...generationDraft, model: event.target.value })}
              placeholder={generationDraft.provider === "gemini" ? "gemini-2.5-flash" : "llama3.1"}
            />
          </label>
        </div>
        <button disabled={!generationDraft.model.trim() || busy} onClick={saveGenerationConfig}>
          Save model
        </button>
      </section>

      <section className="panel queue">
        <div className="panel-head">
          <h2>Jobs</h2>
          <span>{jobs.length}</span>
        </div>
        <div className="job-dashboard">
          <span>ready now {readyNowJobs.length}</span>
          <span>scheduled later {scheduledLaterJobs.length}</span>
          <span>failed {failedJobs.length}</span>
          <span>posted {postedJobs.length}</span>
        </div>
        {readyNowJobs.length || failedJobs.length ? (
          <button className="secondary queue-action" disabled={busy} onClick={postAllReadyJobs}>
            Post all ready
          </button>
        ) : null}
        {readyForBulkPrepare.length ? (
          <button className="secondary queue-action" disabled={busy} onClick={prepareAllReadyJobs}>
            Prepare all ready
          </button>
        ) : null}
        {selectedDeletableJobs.length ? (
          <button className="secondary danger queue-action" disabled={busy} onClick={deleteSelectedJobs}>
            Delete selected failed/prepared ({selectedDeletableJobs.length})
          </button>
        ) : null}
        {selectedJobIds.length ? (
          <button className="secondary queue-action" disabled={busy} onClick={clearJobSelection}>
            Clear selection ({selectedJobIds.length})
          </button>
        ) : null}
        {accountJobs.length ? (
          <div className="job-buckets">
            {[
              { title: "Ready now", jobs: readyNowJobs },
              { title: "Scheduled later", jobs: scheduledLaterJobs },
              { title: "Failed", jobs: failedJobs },
              { title: "Posted", jobs: postedJobs },
              { title: "Other", jobs: otherJobs }
            ].map((bucket) => (
              <section className="job-bucket" key={bucket.title}>
                <div className="panel-head">
                  <h3>{bucket.title}</h3>
                  <span>{bucket.jobs.length}</span>
                </div>
                {bucket.jobs.length ? (
                  <div className="job-list">
                    {bucket.jobs.map((job) => (
                      <article className="job" key={job.id}>
                        <div>
                          <strong>{job.id}</strong>
                          <span>{job.scheduledFor ? `${job.mode} · ${new Date(job.scheduledFor).toLocaleString()}` : job.mode}</span>
                        </div>
                        <span className={`status ${job.status}`}>{job.status}</span>
                        <label className="checkbox-row job-select">
                          <input
                            checked={selectedJobIds.includes(job.id)}
                            type="checkbox"
                            onChange={() => toggleJobSelection(job.id)}
                          />
                          Select
                        </label>
                        <div className="job-actions">
                          <button
                            className="secondary"
                            disabled={(job.status !== "approved" && job.status !== "failed") || busy}
                            onClick={() => prepareJob(job)}
                          >
                            Prepare
                          </button>
                          <button
                            className="secondary"
                            disabled={(job.status !== "approved" && job.status !== "prepared" && job.status !== "failed") || busy}
                            onClick={() => postJob(job)}
                          >
                            Post
                          </button>
                          <button className="secondary danger" disabled={job.status === "running" || busy} onClick={() => deleteJob(job)}>
                            Delete
                          </button>
                        </div>
                        {attemptsByJob[job.id]?.length ? (
                          <div className="attempts">
                            {attemptsByJob[job.id]?.map((attempt) => (
                              <p key={attempt.id}>
                                <strong>{attempt.status}</strong>
                                {attempt.errorMessage ? `: ${attempt.errorMessage}` : ""}
                                {attempt.screenshotPath ? ` Screenshot: ${attempt.screenshotPath}` : ""}
                                {attempt.tracePath ? ` Trace: ${attempt.tracePath}` : ""}
                              </p>
                            ))}
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="empty">No jobs.</p>
                )}
              </section>
            ))}
          </div>
        ) : (
          <p className="empty">No jobs for selected account.</p>
        )}
      </section>
    </main>
  );
}

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing #root element");
}

createRoot(root).render(<App />);
