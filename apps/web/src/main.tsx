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

type GenerationModelOptions = Record<string, string[]>;

interface GenerationResponse {
  generation: GenerationConfig;
  providers: GenerationModelOptions;
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

interface IngestConfig {
  id: string;
  accountId: string;
  enabled: boolean;
  maxPacketsPerDay: number;
  metadata: Record<string, unknown>;
  scheduleWindowEnd: string;
  scheduleWindowStart: string;
  sourceType: string;
  tweetTypeMix: Record<string, number>;
}

interface StyleProfile {
  id: string;
  name: string;
  description: string | null;
  tone: string | null;
  rules: Record<string, unknown>;
  bannedPhrases: string[];
  examplePosts: string[];
}

const X_FREE_POST_CHARACTER_LIMIT = 280;
const tweetTypeOptions = [
  "feed_observation",
  "news_context",
  "useful_info",
  "guide",
  "lesson",
  "tool",
  "opinion",
  "reply",
  "hiring",
  "article_summary",
  "narrative_history"
];

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

const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini",
  ollama: "Ollama",
  openrouter: "OpenRouter"
};

function providerLabel(provider: string) {
  return PROVIDER_LABELS[provider] ?? provider;
}

function liveModelLabel(generation: GenerationConfig | null) {
  if (!generation) {
    return "Model unavailable";
  }
  return `${providerLabel(generation.provider)} / ${generation.model}`;
}

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState("account_personal");
  const [postPlan, setPostPlan] = useState("single");
  const [tweetType, setTweetType] = useState("useful_info");
  const [idea, setIdea] = useState("");
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [editedText, setEditedText] = useState("");
  const [autoPost, setAutoPost] = useState(true);
  const [scheduledFor, setScheduledFor] = useState("");
  const [scheduleSpacingMinutes, setScheduleSpacingMinutes] = useState(90);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [attemptsByJob, setAttemptsByJob] = useState<Record<string, Attempt[]>>({});
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(null);
  const [generation, setGeneration] = useState<GenerationConfig | null>(null);
  const [generationModelOptions, setGenerationModelOptions] = useState<GenerationModelOptions>({});
  const [generationDraft, setGenerationDraft] = useState({ model: "", provider: "openrouter" });
  const [sourcePackets, setSourcePackets] = useState<SourcePacket[]>([]);
  const [ingestConfigs, setIngestConfigs] = useState<IngestConfig[]>([]);
  const [automationDraft, setAutomationDraft] = useState({
    enabled: false,
    feedUrl: "",
    maxPacketsPerDay: 1000,
    scheduleWindowEnd: "23:59",
    scheduleWindowStart: "00:00",
    sourceType: "news",
    tweetType: "useful_info"
  });
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
    const [{ accounts: loadedAccounts }, generationResponse] = await Promise.all([
      api<{ accounts: Account[] }>("/accounts"),
      api<GenerationResponse>("/generation")
    ]);
    const loadedGeneration = generationResponse.generation;
    const nextActiveAccount = loadedAccounts.find((account) => account.id === activeAccountId) ?? loadedAccounts[0] ?? null;
    const nextActiveAccountId = nextActiveAccount?.id ?? activeAccountId;
    const [{ jobs: loadedJobs }, { packets: loadedSourcePackets }, { configs: loadedIngestConfigs }] = await Promise.all([
      api<{ jobs: Job[] }>(`/jobs?accountId=${encodeURIComponent(nextActiveAccountId)}`),
      api<{ packets: SourcePacket[] }>(`/source-packets?accountId=${encodeURIComponent(nextActiveAccountId)}`),
      api<{ configs: IngestConfig[] }>(`/ingest-configs?accountId=${encodeURIComponent(nextActiveAccountId)}`)
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
    setGenerationModelOptions(generationResponse.providers ?? {});
    setGenerationDraft({ model: loadedGeneration.model, provider: loadedGeneration.provider });
    setSourcePackets(loadedSourcePackets);
    setIngestConfigs(loadedIngestConfigs);
    setAutomationDraft(draftFromIngestConfig(loadedIngestConfigs[0] ?? null));
    setAttemptsByJob(Object.fromEntries(attemptsEntries));
    setSelectedJobIds((current) => current.filter((id) => availableJobIds.has(id)));
    if (nextActiveAccount) {
      setActiveAccountId(nextActiveAccount.id);
      await loadStyleProfile(nextActiveAccount.styleProfileId);
    }
  }

  function draftFromIngestConfig(config: IngestConfig | null) {
    const usefulWeight = config?.tweetTypeMix.useful_info ?? 0;
    const topTweetType =
      config && Object.keys(config.tweetTypeMix).length
        ? Object.entries(config.tweetTypeMix).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "useful_info"
        : "useful_info";
    return {
      enabled: config?.enabled ?? false,
      feedUrl: typeof config?.metadata.feedUrl === "string" ? config.metadata.feedUrl : "",
      maxPacketsPerDay: config?.maxPacketsPerDay ?? 3,
      scheduleWindowEnd: config?.scheduleWindowEnd ?? "23:59",
      scheduleWindowStart: config?.scheduleWindowStart ?? "00:00",
      sourceType: config?.sourceType ?? "news",
      tweetType: usefulWeight > 0 ? "useful_info" : topTweetType
    };
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
        await api<{ draft: Draft; job: Job }>("/drafts", {
          method: "POST",
          body: JSON.stringify({
            accountId: activeAccountId,
            idea,
            count: 1,
            tweetType,
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
            accountId: activeAccountId,
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

  function deleteCleanupJobs() {
    run(async () => {
      await api("/jobs/cleanup", { method: "DELETE" });
      await refresh();
    });
  }

  function deleteAllJobs() {
    run(async () => {
      if (window.confirm("Delete ALL jobs?")) {
        await api(`/jobs?accountId=${encodeURIComponent(activeAccountId)}`, { method: "DELETE" });
        await refresh();
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
      const response = await api<GenerationResponse>("/generation", {
        method: "PATCH",
        body: JSON.stringify({
          model: generationDraft.model.trim(),
          provider: generationDraft.provider
        })
      });
      const savedGeneration = response.generation;
      setGeneration(savedGeneration);
      setGenerationModelOptions(response.providers ?? generationModelOptions);
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

  function saveAutomationConfig() {
    run(async () => {
      const existing = ingestConfigs[0] ?? null;
      const payload = {
        accountId: activeAccountId,
        enabled: automationDraft.enabled,
        maxPacketsPerDay: automationDraft.maxPacketsPerDay,
        metadata: automationDraft.sourceType === "feed" ? { feedUrl: automationDraft.feedUrl.trim() } : {},
        scheduleWindowEnd: automationDraft.scheduleWindowEnd,
        scheduleWindowStart: automationDraft.scheduleWindowStart,
        sourceType: automationDraft.sourceType,
        tweetTypeMix: { [automationDraft.tweetType]: 100 }
      };
      if (existing) {
        await api(`/ingest-configs/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify(payload)
        });
      } else {
        await api("/ingest-configs", {
          method: "POST",
          body: JSON.stringify(payload)
        });
      }
      await refresh();
    });
  }

  function toggleAutomation() {
    const existing = ingestConfigs[0] ?? null;
    const nextEnabled = !automationDraft.enabled;
    setAutomationDraft({ ...automationDraft, enabled: nextEnabled });
    run(async () => {
      if (existing) {
        await api(`/ingest-configs/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ enabled: nextEnabled })
        });
      } else {
        await api("/ingest-configs", {
          method: "POST",
          body: JSON.stringify({
            accountId: activeAccountId,
            enabled: nextEnabled,
            maxPacketsPerDay: automationDraft.maxPacketsPerDay,
            metadata: automationDraft.sourceType === "feed" ? { feedUrl: automationDraft.feedUrl.trim() } : {},
            scheduleWindowEnd: automationDraft.scheduleWindowEnd,
            scheduleWindowStart: automationDraft.scheduleWindowStart,
            sourceType: automationDraft.sourceType,
            tweetTypeMix: { [automationDraft.tweetType]: 100 }
          })
        });
      }
      await refresh();
    });
  }

  function runAutomationNow() {
    run(async () => {
      const result = await api<{ processed: number }>("/ingest-run", { method: "POST" });
      await refresh();
      if (result.processed === 0) {
        setError("Automation ran, but no new eligible source items were found.");
      }
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

  function deleteDraftFromSourcePacket(packet: SourcePacket) {
    run(async () => {
      if (packet.status === "drafted" && window.confirm("Delete generated draft and reset this source?")) {
        await api(`/source-packets/${packet.id}/draft`, { method: "DELETE" });
        setDraft(null);
        setEditedText("");
        await refresh();
      }
    });
  }

  function deleteSourcePacket(packet: SourcePacket) {
    run(async () => {
      if (window.confirm("Delete this source? Non-posted source drafts will be removed too.")) {
        await api(`/source-packets/${packet.id}`, { method: "DELETE" });
        setDraft(null);
        setEditedText("");
        await refresh();
      }
    });
  }

  function deleteAllSources() {
    run(async () => {
      if (sourcePackets.length > 0 && window.confirm("Delete all sources for this account? Non-posted source drafts will be removed too.")) {
        await api(`/source-packets?accountId=${encodeURIComponent(activeAccountId)}`, { method: "DELETE" });
        setDraft(null);
        setEditedText("");
        await refresh();
      }
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
  const providerOptions = Object.keys(generationModelOptions).length
    ? Object.keys(generationModelOptions)
    : ["openrouter", "gemini", "ollama"];
  const selectedProviderModels = generationModelOptions[generationDraft.provider] ?? [];
  const selectedProviderHasModel = selectedProviderModels.includes(generationDraft.model);

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
              Live model: {liveModelLabel(generation)}
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

      <section className="panel automation">
        <div className="panel-head">
          <div>
            <h2>Automatic Poster</h2>
            <p className="empty">Live sources create clean autopost jobs. Disable anytime.</p>
          </div>
          <span className={automationDraft.enabled ? "provider-pill" : "session-pill unknown"}>
            {automationDraft.enabled ? "enabled" : "disabled"}
          </span>
        </div>
        <div className="automation-grid">
          <label className="checkbox-row switch-row">
            <input checked={automationDraft.enabled} type="checkbox" onChange={toggleAutomation} />
            Auto ingest and post
          </label>
          <label>
            Live source
            <select
              value={automationDraft.sourceType}
              onChange={(event) => setAutomationDraft({ ...automationDraft, sourceType: event.target.value })}
            >
              <option value="news">Aggregated tech/news</option>
              <option value="feed">RSS feed URL</option>
            </select>
          </label>
          {automationDraft.sourceType === "feed" ? (
            <label className="wide-field">
              RSS feed URL
              <input
                placeholder="https://example.com/feed.xml"
                value={automationDraft.feedUrl}
                onChange={(event) => setAutomationDraft({ ...automationDraft, feedUrl: event.target.value })}
              />
            </label>
          ) : null}
          <label>
            Tweet style
            <select
              value={automationDraft.tweetType}
              onChange={(event) => setAutomationDraft({ ...automationDraft, tweetType: event.target.value })}
            >
              {tweetTypeOptions.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label>
            Daily max
            <input
              min="1"
              max="1000"
              type="number"
              value={automationDraft.maxPacketsPerDay}
              onChange={(event) => setAutomationDraft({ ...automationDraft, maxPacketsPerDay: Number(event.target.value) })}
            />
          </label>
          <label>
            Start
            <input
              type="time"
              value={automationDraft.scheduleWindowStart}
              onChange={(event) => setAutomationDraft({ ...automationDraft, scheduleWindowStart: event.target.value })}
            />
          </label>
          <label>
            End
            <input
              type="time"
              value={automationDraft.scheduleWindowEnd}
              onChange={(event) => setAutomationDraft({ ...automationDraft, scheduleWindowEnd: event.target.value })}
            />
          </label>
        </div>
        <div className="automation-actions">
          <button
            disabled={busy || (automationDraft.sourceType === "feed" && !automationDraft.feedUrl.trim())}
            onClick={saveAutomationConfig}
          >
            Save automation
          </button>
          <button
            className="secondary"
            disabled={busy || !automationDraft.enabled || (automationDraft.sourceType === "feed" && !automationDraft.feedUrl.trim())}
            onClick={runAutomationNow}
          >
            Run now
          </button>
        </div>
      </section>

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
                {tweetTypeOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <button disabled={!idea.trim() || busy}>
            {postPlan === "batch" ? "Create batch jobs" : autoPost ? "Autopost" : "Generate drafts"}
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
              Autopost
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
          <div className="panel-head-actions">
            <span>{sourcePackets.length}</span>
            <button className="secondary danger compact-button" disabled={busy || sourcePackets.length === 0} onClick={deleteAllSources}>
              Delete all
            </button>
          </div>
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
                  <option value="job">job</option>
                </select>
              </label>
              <label>
                Type
                <select
                  value={packetDraft.tweetType}
                  onChange={(event) => setPacketDraft({ ...packetDraft, tweetType: event.target.value })}
                >
                  {tweetTypeOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
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
                  <div className="source-actions">
                    <button
                      className="secondary"
                      disabled={busy || packet.status === "drafted"}
                      onClick={() => draftFromSourcePacket(packet)}
                    >
                      Draft
                    </button>
                    <button
                      className="secondary danger"
                      disabled={busy || packet.status !== "drafted"}
                      onClick={() => deleteDraftFromSourcePacket(packet)}
                    >
                      Delete draft
                    </button>
                    <button className="secondary danger" disabled={busy} onClick={() => deleteSourcePacket(packet)}>
                      Delete source
                    </button>
                  </div>
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
              {generation.configured ? `Live: ${liveModelLabel(generation)}` : `${providerLabel(generation.provider)} key missing`}
            </span>
          ) : null}
        </div>
        {generation ? <p className="model-live">Realtime generator: {liveModelLabel(generation)}</p> : null}
        <div className="settings-grid">
          <label>
            Provider
            <select
              value={generationDraft.provider}
              onChange={(event) => {
                const provider = event.target.value;
                const models = generationModelOptions[provider] ?? [];
                setGenerationDraft({
                  provider,
                  model: models[0] ?? ""
                });
              }}
            >
              {providerOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {providerLabel(provider)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Model
            <select
              value={generationDraft.model}
              onChange={(event) => setGenerationDraft({ ...generationDraft, model: event.target.value })}
            >
              {selectedProviderModels.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
              {!selectedProviderHasModel && generationDraft.model ? (
                <option value={generationDraft.model}>{generationDraft.model}</option>
              ) : null}
            </select>
          </label>
          <label>
            Custom model
            <input
              value={generationDraft.model}
              onChange={(event) => setGenerationDraft({ ...generationDraft, model: event.target.value })}
              placeholder={selectedProviderModels[0] ?? "model name"}
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
        {postedJobs.length || failedJobs.length ? (
          <button className="secondary queue-action" disabled={busy} onClick={deleteCleanupJobs}>
            Cleanup
          </button>
        ) : null}
        {accountJobs.length ? (
          <button className="secondary danger queue-action" disabled={busy} onClick={deleteAllJobs}>
            Delete all
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
