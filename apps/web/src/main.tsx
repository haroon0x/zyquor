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
  const [autoPost, setAutoPost] = useState(true);
  const [scheduledFor, setScheduledFor] = useState("");
  const [scheduleSpacingMinutes, setScheduleSpacingMinutes] = useState(90);
  const [browserSession, setBrowserSession] = useState<BrowserSession | null>(null);
  const [generation, setGeneration] = useState<GenerationConfig | null>(null);
  const [generationModelOptions, setGenerationModelOptions] = useState<GenerationModelOptions>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  async function refresh() {
    setRefreshToken((current) => current + 1);
    await loadRootData();
  }

  function run(action: () => Promise<void>) {
    setError(null);
    setBusy(true);
    void action()
      .catch((caught) => reportError(caught, "Unknown error"))
      .finally(() => setBusy(false));
  }

  function checkBrowserSession() {
    run(async () => {
      const session = await api<BrowserSession>(`/browser/x-session?accountId=${encodeURIComponent(activeAccountId)}`);
      setBrowserSession(session);
    });
  }

  const activeAccount = accounts.find((account) => account.id === activeAccountId);
  const panel: PanelProps = { accountId: activeAccountId, busy, refresh, refreshToken, reportError, run };
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
      <section className="topbar">
        <div><p className="eyebrow">Zyquor</p><h1>Draft, review, prepare.</h1></div>
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
          ) : <span className="session-pill unknown">X unchecked</span>}
          <button className="strip-button" disabled={busy} onClick={checkBrowserSession}><Busy active={busy} />Check X</button>
        </section>
      ) : null}

      {error ? <p className="notice error" role="alert">{error}</p> : null}
      <section className="app-layout">
        <div className="primary-flow">
          <Composer panel={panel} state={composerState} />
          <CandidatesPanel panel={panel} state={candidatesState} />
          <JobsPanel panel={panel} />
        </div>
        <aside className="utility-flow">
          <AutomationPanel panel={panel} />
          <WorkerPanel panel={panel} />
          <SourcePacketsPanel panel={panel} state={{ setDraft, setEditedText }} />
          {activeAccount ? <StylePanel panel={panel} styleProfileId={activeAccount.styleProfileId} /> : null}
          <GenerationPanel
            panel={panel}
            state={{ generation, generationModelOptions, setGeneration, setGenerationModelOptions }}
          />
          {isElectron ? <DesktopSettingsPanel panel={panel} /> : null}
        </aside>
      </section>
      {appVersion ? <footer className="version-footer">v{appVersion}</footer> : null}
    </main>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing #root element");

createRoot(root).render(<App />);
