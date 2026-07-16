import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, loadAppData } from "./api.js";
import { Busy, PanelIcon, type PanelIconName } from "./components/Feedback.js";
import { OnboardingWizard } from "./components/OnboardingWizard.js";
import type {
  Account,
  BrowserSession,
  DraftResponse,
  GenerationConfig,
  GenerationModelOptions,
  OnboardingStatus,
  PanelProps,
  WorkerStatus
} from "./types.js";
import { AutomationView } from "./views/Automation.js";
import { ComposeView } from "./views/Compose.js";
import { HistoryView } from "./views/History.js";
import { QueueView } from "./views/Queue.js";
import { SettingsView } from "./views/Settings.js";
import "./styles.css";

type ViewId = "compose" | "queue" | "automation" | "history" | "settings";

const views: Array<{ description: string; icon: PanelIconName; id: ViewId; title: string }> = [
  { id: "compose", icon: "pencil", title: "Compose", description: "Turn a rough idea into a polished, reviewable post." },
  { id: "queue", icon: "list-checks", title: "Queue", description: "Prepare, schedule, post, and inspect every job." },
  { id: "automation", icon: "zap", title: "Automation", description: "Control source ingestion and the automatic posting pipeline." },
  { id: "history", icon: "clock", title: "History", description: "Review recently posted content and its sources." },
  { id: "settings", icon: "settings", title: "Settings", description: "Tune generation, writing style, and desktop behavior." }
];

const ONBOARDING_COMPLETED_KEY = "zyquor:onboarding-completed";
const ONBOARDING_DISMISSED_KEY = "zyquor:onboarding-dismissed";

function hasLocalOnboardingChoice() {
  try {
    return localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "1" || localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveLocalOnboardingChoice(key: string) {
  try {
    localStorage.setItem(key, "1");
  } catch {
    return;
  }
}

function viewFromHash(): ViewId {
  const value = window.location.hash.slice(1);
  return views.some((view) => view.id === value) ? value as ViewId : "compose";
}

function App() {
  const [activeView, setActiveView] = useState<ViewId>(viewFromHash);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [activeAccountId, setActiveAccountId] = useState("account_personal");
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [newAccountHandle, setNewAccountHandle] = useState("");
  const [newAccountDisplayName, setNewAccountDisplayName] = useState("");
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
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus | null>(null);
  const [generation, setGeneration] = useState<GenerationConfig | null>(null);
  const [generationModelOptions, setGenerationModelOptions] = useState<GenerationModelOptions>({});
  const [onboardingStatus, setOnboardingStatus] = useState<OnboardingStatus | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
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
    if (!window.location.hash || !views.some((view) => `#${view.id}` === window.location.hash)) {
      window.history.replaceState(null, "", "#compose");
    }
    const syncHash = () => setActiveView(viewFromHash());
    syncHash();
    window.addEventListener("hashchange", syncHash);
    return () => window.removeEventListener("hashchange", syncHash);
  }, []);

  useEffect(() => {
    void loadRootData().catch((caught) => reportError(caught, "API unavailable"));
  }, []);

  useEffect(() => {
    void api<OnboardingStatus>("/onboarding/status")
      .then((status) => {
        setOnboardingStatus(status);
        if (status.needsOnboarding && !hasLocalOnboardingChoice()) setOnboardingOpen(true);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    void api<WorkerStatus>("/worker/status").then(setWorkerStatus).catch(() => setWorkerStatus(null));
  }, [refreshToken]);

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

  function createAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    run(async () => {
      const { account } = await api<{ account: Account }>("/accounts", {
        method: "POST",
        body: JSON.stringify({
          handle: newAccountHandle,
          ...(newAccountDisplayName ? { displayName: newAccountDisplayName } : {})
        })
      });
      await refresh();
      setActiveAccountId(account.id);
      setBrowserSession(null);
      setNewAccountHandle("");
      setNewAccountDisplayName("");
      setShowAccountForm(false);
    }, "account-create");
  }

  function navigate(view: ViewId) {
    setActiveView(view);
    window.location.hash = view;
  }

  function openOnboarding() {
    run(async () => {
      const status = await api<OnboardingStatus>("/onboarding/status");
      setOnboardingStatus(status);
      setOnboardingOpen(true);
    }, "onboarding");
  }

  const activeAccount = accounts.find((account) => account.id === activeAccountId);
  const activeViewMeta = views.find((view) => view.id === activeView) ?? views[0]!;
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
    setAutoPost, setDraft, setEditedText, setIdea, setPostPlan, setReplyToUrl,
    setScheduleSpacingMinutes, setScheduledFor, setTweetType
  };
  const candidatesState = {
    autoPost, draft, editedText, postPlan, scheduleSpacingMinutes, scheduledFor,
    setAutoPost, setDraft, setEditedText, setScheduleSpacingMinutes, setScheduledFor
  };

  let viewContent;
  if (activeView === "compose") {
    viewContent = <ComposeView candidatesPanel={panelFor("candidates")} candidatesState={candidatesState} composerPanel={panelFor("composer")} composerState={composerState} />;
  } else if (activeView === "queue") {
    viewContent = <QueueView panel={panelFor("jobs")} />;
  } else if (activeView === "automation") {
    viewContent = (
      <AutomationView
        automationPanel={panelFor("automation")}
        sourcePanel={panelFor("sources")}
        sourceState={{ setDraft, setEditedText }}
        workerPanel={panelFor("worker")}
      />
    );
  } else if (activeView === "history") {
    viewContent = <HistoryView panel={panelFor("history")} />;
  } else {
    viewContent = (
      <SettingsView
        accounts={accounts}
        accountsPanel={panelFor("accounts")}
        desktopPanel={panelFor("desktop-settings")}
        generationPanel={panelFor("generation")}
        generationState={{ generation, generationModelOptions, setGeneration, setGenerationModelOptions }}
        isElectron={isElectron}
        stylePanel={panelFor("style")}
        styleProfileId={activeAccount?.styleProfileId ?? null}
      />
    );
  }

  return (
    <>
      <div className="app-shell">
      <aside className="sidebar">
        <button aria-label="Go to Compose" className="brand-mark" onClick={() => navigate("compose")}>Z</button>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          {views.map((view) => (
            <a
              aria-current={activeView === view.id ? "page" : undefined}
              className={activeView === view.id ? "nav-item active" : "nav-item"}
              data-label={view.title}
              href={`#${view.id}`}
              key={view.id}
              onClick={() => setActiveView(view.id)}
              title={view.title}
            >
              <PanelIcon name={view.icon} />
            </a>
          ))}
        </nav>
        <div className="sidebar-status">
          <button aria-label="Open setup guide" className="ghost onboarding-help" onClick={openOnboarding} title="Setup guide">?</button>
          <span
            aria-label={workerStatus?.workerRunning ? "Worker online" : "Worker offline"}
            className={workerStatus?.workerRunning ? "dot-chip worker-chip online" : "dot-chip worker-chip offline"}
            role="status"
            title={workerStatus?.workerRunning ? "Worker online" : "Worker offline"}
          />
          {isElectron ? <span className="sidebar-version">v{appVersion || "—"}</span> : null}
        </div>
      </aside>
      <div className="app-main">
        <div className="account-bar">
          <div className="account-bar-inner">
            <div className="account-cluster">
              <select
                aria-label="Active account"
                value={activeAccountId}
                onChange={(event) => {
                  setActiveAccountId(event.target.value);
                  setBrowserSession(null);
                }}
              >
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName} · @{account.handle}</option>)}
              </select>
              <button className="ghost compact-button add-account-button" onClick={() => setShowAccountForm((current) => !current)}>
                <span aria-hidden="true">+</span><span className="add-account-label">Add account</span>
              </button>
              {showAccountForm ? (
                <form className="account-create-form" onSubmit={createAccount}>
                  <input
                    aria-label="New account handle"
                    autoFocus
                    maxLength={15}
                    pattern="[a-z0-9_]{1,15}"
                    placeholder="handle"
                    required
                    value={newAccountHandle}
                    onChange={(event) => setNewAccountHandle(event.target.value)}
                  />
                  <input
                    aria-label="New account display name"
                    maxLength={120}
                    placeholder="Display name (optional)"
                    value={newAccountDisplayName}
                    onChange={(event) => setNewAccountDisplayName(event.target.value)}
                  />
                  <button className="compact-button" disabled={busyScopes.includes("account-create")} type="submit">
                    <Busy active={busyScopes.includes("account-create")} />Create
                  </button>
                  <button className="ghost compact-button" type="button" onClick={() => setShowAccountForm(false)}>Cancel</button>
                </form>
              ) : null}
              {browserSession ? (
                <span className={browserSession.loggedIn ? "dot-chip online" : "dot-chip offline"}>X {browserSession.loggedIn ? "active" : "logged out"}</span>
              ) : <span className="dot-chip unknown">X unchecked</span>}
              <button className="secondary compact-button" disabled={busyScopes.includes("header")} onClick={checkBrowserSession}>
                <Busy active={busyScopes.includes("header")} />Check X
              </button>
            </div>
          </div>
        </div>
        <main className="content-area">
          {error ? <p className="notice error" role="alert">{error}</p> : null}
          <header className="view-header">
            <div>
              <h1>{activeViewMeta.title}</h1>
              <p>{activeViewMeta.description}</p>
            </div>
          </header>
          <div className="view-frame" key={activeView}>{viewContent}</div>
        </main>
      </div>
      </div>
      {onboardingOpen && onboardingStatus ? (
        <OnboardingWizard
          accountId={activeAccountId}
          initialStatus={onboardingStatus}
          onClose={() => setOnboardingOpen(false)}
          onComplete={() => {
            saveLocalOnboardingChoice(ONBOARDING_COMPLETED_KEY);
            setOnboardingOpen(false);
            navigate("compose");
          }}
          onDismissForever={() => {
            saveLocalOnboardingChoice(ONBOARDING_DISMISSED_KEY);
            setOnboardingOpen(false);
          }}
          onDraftCreated={(createdDraft) => {
            setDraft(createdDraft);
            setEditedText(createdDraft?.candidates[0]?.text ?? "");
          }}
          onNavigate={(view) => {
            setOnboardingOpen(false);
            navigate(view);
          }}
        />
      ) : null}
    </>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing #root element");

createRoot(root).render(<App />);
