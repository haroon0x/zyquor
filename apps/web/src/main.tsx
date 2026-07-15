import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, liveModelLabel, loadAppData } from "./api.js";
import { AutomationPanel } from "./components/AutomationPanel.js";
import { CandidatesPanel } from "./components/CandidatesPanel.js";
import { Composer } from "./components/Composer.js";
import { DesktopSettingsPanel } from "./components/DesktopSettingsPanel.js";
import { GenerationPanel } from "./components/GenerationPanel.js";
import { JobsPanel } from "./components/JobsPanel.js";
import { SourcePacketsPanel } from "./components/SourcePacketsPanel.js";
import { StylePanel } from "./components/StylePanel.js";
import { WorkerPanel } from "./components/WorkerPanel.js";
import { Busy } from "./components/Feedback.js";
import type {
  Account,
  BrowserSession,
  DraftResponse,
  GenerationConfig,
  GenerationModelOptions,
  PanelProps
} from "./types.js";
import "./styles.css";

function App() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState("account_personal");
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [editedText, setEditedText] = useState("");
  const [postPlan, setPostPlan] = useState("single");
  const [tweetType, setTweetType] = useState("useful_info");
  const [idea, setIdea] = useState("");
  const [replyToUrl, setReplyToUrl] = useState("");
  const [autoPost, setAutoPost] = useState(false);
  const [scheduledFor, setScheduledFor] = useState("");
  const [scheduleSpacingMinutes, setScheduleSpacingMinutes] = useState(90);
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(null);
  const [generation, setGeneration] = useState<GenerationConfig | null>(null);
  const [generationModelOptions, setGenerationModelOptions] = useState<GenerationModelOptions>({});
  const [error, setError] = useState<string | null>(null);
  const [busyScopes, setBusyScopes] = useState<string[]>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const refreshRequestIdRef = useRef(0);
  const isElectron = Boolean(window.zyquor);
  const appVersion = window.zyquor?.appVersion ?? "";

  function reportError(caught: unknown, fallback: string) {
    setError(caught instanceof Error ? caught.message : fallback);
  }

  async function loadRootData() {
    const requestId = refreshRequestIdRef.current + 1;
    refreshRequestIdRef.current = requestId;
    const { accounts: loadedAccounts, generation: generationResponse } = await loadAppData();
    if (requestId !== refreshRequestIdRef.current) return;
    const nextActiveAccount = loadedAccounts.find((account) => account.id === activeAccountId) ?? loadedAccounts[0] ?? null;
    setAccounts(loadedAccounts);
    setGeneration(generationResponse.generation);
    setGenerationModelOptions(generationResponse.providers ?? {});
    if (nextActiveAccount) setActiveAccountId(nextActiveAccount.id);
  }

  useEffect(() => {
    void loadRootData().catch((caught) => reportError(caught, "API unavailable"));
  }, []);

  useEffect(() => {
    setAutoPost(false);
  }, [draft?.draft.id]);

  async function refresh() {
    setRefreshToken((current) => current + 1);
    await loadRootData();
  }

  function run(action: () => Promise<void>, scope: string) {
    setError(null);
    setBusyScopes((current) => current.includes(scope) ? current : [...current, scope]);
    void action()
      .catch((caught) => reportError(caught, "Unknown error"))
      .finally(() => setBusyScopes((current) => current.filter((item) => item !== scope)));
  }

  function checkBrowserSession() {
    run(async () => {
      const session = await api<BrowserSession>(`/browser/x-session?accountId=${encodeURIComponent(activeAccountId)}`);
      setBrowserSession(session);
    }, "header");
  }

  const activeAccount = accounts.find((account) => account.id === activeAccountId);
  const panelFor = (scope: string): PanelProps => ({
    accountId: activeAccountId,
    busy: busyScopes.includes(scope),
    refresh,
    refreshToken,
    reportError,
    run: (action) => run(action, scope)
  });
  const composerState = {
    autoPost, idea, postPlan, replyToUrl, scheduleSpacingMinutes, scheduledFor, tweetType,
    setDraft, setEditedText, setIdea, setPostPlan, setReplyToUrl, setTweetType
  };
  const candidatesState = {
    autoPost, draft, editedText, postPlan, scheduleSpacingMinutes, scheduledFor,
    setAutoPost, setDraft, setEditedText, setScheduleSpacingMinutes, setScheduledFor
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div className="product-lockup">
          <p className="wordmark">Zyquor</p>
          <p className="tagline">Draft, review, prepare.</p>
        </div>
        <div className="product-controls">
          {activeAccount ? <span>@{activeAccount.handle}</span> : null}
          {generation ? (
            <span className={generation.configured ? "provider-pill" : "provider-pill failed"}>
              {liveModelLabel(generation)}
            </span>
          ) : null}
          {browserSession ? (
            <span className={browserSession.loggedIn ? "session-pill" : "session-pill failed"}>
              X {browserSession.loggedIn ? "logged in" : "logged out"}
            </span>
          ) : <span className="session-pill unknown">X unchecked</span>}
          <select
            aria-label="Active account"
            value={activeAccountId}
            onChange={(event) => {
              setActiveAccountId(event.target.value);
              setBrowserSession(null);
            }}
          >
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}
          </select>
          <button className="secondary compact-button" disabled={busyScopes.includes("header")} onClick={checkBrowserSession}>
            <Busy active={busyScopes.includes("header")} />Check X
          </button>
        </div>
      </header>

      {error ? <p className="notice error" role="alert">{error}</p> : null}
      <section className="app-layout">
        <div className="primary-flow">
          <Composer panel={panelFor("composer")} state={composerState} />
          <CandidatesPanel panel={panelFor("candidates")} state={candidatesState} />
          <JobsPanel panel={panelFor("jobs")} />
        </div>
        <aside className="utility-flow">
          <AutomationPanel panel={panelFor("automation")} />
          <WorkerPanel panel={panelFor("worker")} />
          <SourcePacketsPanel panel={panelFor("sources")} state={{ setDraft, setEditedText }} />
          {activeAccount ? <StylePanel panel={panelFor("style")} styleProfileId={activeAccount.styleProfileId} /> : null}
          <GenerationPanel
            panel={panelFor("generation")}
            state={{ generation, generationModelOptions, setGeneration, setGenerationModelOptions }}
          />
          {isElectron ? <DesktopSettingsPanel panel={panelFor("desktop-settings")} /> : null}
        </aside>
      </section>
      {appVersion ? <footer className="version-footer">v{appVersion}</footer> : null}
    </main>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing #root element");

createRoot(root).render(<App />);
