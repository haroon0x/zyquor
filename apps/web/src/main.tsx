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
import { RepliesView } from "./views/Replies.js";
import { SettingsView } from "./views/Settings.js";
import { SystemView } from "./views/System.js";
import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

type ViewId = "compose" | "queue" | "replies" | "automation" | "history" | "system" | "settings";

const views: Array<{ description: string; icon: PanelIconName; id: ViewId; title: string }> = [
  { id: "replies", icon: "inbox", title: "Replies", description: "Reply to posts and accounts you want to engage with." },
  { id: "compose", icon: "pencil", title: "Compose", description: "Turn a rough idea into a polished, reviewable post." },
  { id: "queue", icon: "list-checks", title: "Queue", description: "Prepare, schedule, post, and inspect every job." },
  { id: "automation", icon: "zap", title: "Automation", description: "Control source ingestion and the automatic posting pipeline." },
  { id: "history", icon: "clock", title: "History", description: "Review recently posted content and its sources." },
  { id: "system", icon: "activity", title: "System", description: "See what is running and take control of it." },
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
  return views.some((view) => view.id === value) ? value as ViewId : "replies";
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
  const toastIdRef = useRef(0);
  const [toasts, setToasts] = useState<Array<{ id: number; message: string; kind: "success" | "info" | "error" }>>([]);
  const [browserSessionChecking, setBrowserSessionChecking] = useState(false);
  const [systemSnapshot, setSystemSnapshot] = useState<{
    workerRunning: boolean;
    workerPaused: boolean;
    postingEnabled: boolean;
    prepareEnabled: boolean;
    canPauseWorker: boolean;
  } | null>(null);
  const [navCounts, setNavCounts] = useState<{ pendingDrafts: number; queueReady: number }>({ pendingDrafts: 0, queueReady: 0 });
  const isElectron = Boolean(window.zyquor);
  const appVersion = window.zyquor?.appVersion ?? "";

  function reportError(caught: unknown, fallback: string) {
    setError(caught instanceof Error ? caught.message : fallback);
  }

  function dismissToast(id: number) {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function notify(message: string, kind: "success" | "info" | "error" = "success") {
    toastIdRef.current += 1;
    const id = toastIdRef.current;
    setToasts((current) => [...current.slice(-3), { id, message, kind }]);
    window.setTimeout(() => dismissToast(id), kind === "error" ? 9000 : 5500);
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

  // Keep the rail's worker/posting controls live without opening System.
  useEffect(() => {
    void api<{
      posting?: { enablePost?: boolean; enablePrepare?: boolean };
      worker?: { running?: boolean; paused?: boolean };
      desktop?: unknown;
    }>("/system/status")
      .then((status) => setSystemSnapshot({
        workerRunning: status.worker?.running === true,
        workerPaused: status.worker?.paused === true,
        postingEnabled: status.posting?.enablePost === true,
        prepareEnabled: status.posting?.enablePrepare === true,
        canPauseWorker: status.desktop != null
      }))
      .catch(() => setSystemSnapshot(null));
  }, [refreshToken]);

  // What is actually waiting for the human: reviewable drafts and ready jobs.
  useEffect(() => {
    if (!activeAccountId) return;
    let active = true;
    void Promise.all([
      api<{ drafts: unknown[] }>("/drafts/pending").catch(() => ({ drafts: [] })),
      api<{ jobs: unknown[] }>(
        `/jobs?accountId=${encodeURIComponent(activeAccountId)}&statuses=approved,prepared`
      ).catch(() => ({ jobs: [] }))
    ]).then(([pending, jobs]) => {
      if (active) {
        setNavCounts({ pendingDrafts: pending.drafts.length, queueReady: jobs.jobs.length });
      }
    });
    return () => {
      active = false;
    };
  }, [activeAccountId, refreshToken]);

  // Verify the posting-browser session as soon as an account becomes active, so
  // the header never sits on an ambiguous "X unknown" until the user clicks.
  useEffect(() => {
    let active = true;
    setBrowserSessionChecking(true);
    void api<BrowserSession>(`/browser/x-session?accountId=${encodeURIComponent(activeAccountId)}`)
      .then((session) => {
        if (active) setBrowserSession(session);
      })
      .catch(() => {
        if (active) setBrowserSession(null);
      })
      .finally(() => {
        if (active) setBrowserSessionChecking(false);
      });
    return () => {
      active = false;
    };
  }, [activeAccountId]);

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

  function togglePosting() {
    const enabling = systemSnapshot?.postingEnabled !== true;
    if (enabling && !window.confirm("Arm posting? Queued autopost jobs and the worker can publish to X without another click. Only enable this when you mean it.")) return;
    run(async () => {
      await api("/system/posting", { method: "POST", body: JSON.stringify({ enablePost: enabling }) });
      setRefreshToken((current) => current + 1);
      notify(enabling ? "Posting armed — autopost jobs can publish." : "Posting is off.", enabling ? "error" : "info");
    }, "header");
  }

  function toggleWorkerPaused() {
    const paused = systemSnapshot?.workerPaused !== true;
    run(async () => {
      await api("/system/worker/pause", { method: "POST", body: JSON.stringify({ paused }) });
      setRefreshToken((current) => current + 1);
      notify(paused ? "Worker paused." : "Worker resumed.", "info");
    }, "header");
  }

  function checkBrowserSession() {
    setBrowserSessionChecking(true);
    run(async () => {
      try {
        const session = await api<BrowserSession>(`/browser/x-session?accountId=${encodeURIComponent(activeAccountId)}`);
        setBrowserSession(session);
        if (session.loggedIn) {
          notify(`X session verified${session.observedHandle ? ` as @${session.observedHandle}` : ""}.`);
        } else {
          notify("The posting browser is not logged in. Run `zyquor open-profile --manual` once.", "error");
        }
      } finally {
        setBrowserSessionChecking(false);
      }
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
      notify(`Added account @${account.handle}.`, "success");
    }, "account-create");
  }

  function stopEverything() {
    if (!window.confirm("Stop everything? This pauses the worker, turns off prepare and post, and closes the posting Chrome.")) return;
    run(async () => {
      await api("/system/stop-all", { method: "POST" });
      setRefreshToken((current) => current + 1);
      notify("Paused the worker and turned prepare/post off.", "info");
    }, "stop-all");
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
  const workerOnline = workerStatus?.workerRunning === true;
  const activeViewMeta = views.find((view) => view.id === activeView) ?? views[0]!;
  const panelFor = (scope: string): PanelProps => ({
    accountId: activeAccountId,
    busy: busyScopes.includes(scope),
    refresh,
    refreshToken,
    reportError,
    notify,
    navigate,
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
  } else if (activeView === "replies") {
    viewContent = <RepliesView panel={panelFor("replies")} />;
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
  } else if (activeView === "system") {
    viewContent = <SystemView panel={panelFor("system")} />;
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
        <div className="brand-lockup">
          <button aria-label="Go to Compose" className="brand-mark" onClick={() => navigate("compose")}>Z</button>
          <span className="brand-name">Zyquor</span>
        </div>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          {views.map((view) => {
            const badge = view.id === "queue" ? navCounts.queueReady : view.id === "compose" ? navCounts.pendingDrafts : 0;
            return (
              <a
                aria-current={activeView === view.id ? "page" : undefined}
                className={activeView === view.id ? "nav-item active" : "nav-item"}
                href={`#${view.id}`}
                key={view.id}
                onClick={() => setActiveView(view.id)}
                title={view.title}
              >
                <PanelIcon name={view.icon} />
                <span className="nav-label">{view.title}</span>
                {badge > 0 ? <span className="nav-badge">{badge}</span> : null}
              </a>
            );
          })}
        </nav>
        <div className="sidebar-status">
          <div className="rail-states">
            <div className={workerOnline ? "rail-row ok" : "rail-row warn"}>
              <span aria-hidden="true" className="rail-dot" />
              <span>{workerOnline ? (systemSnapshot?.workerPaused ? "worker paused" : "worker running") : "worker offline"}</span>
              {systemSnapshot?.canPauseWorker ? (
                <button
                  className="rail-toggle"
                  disabled={busyScopes.includes("header")}
                  onClick={toggleWorkerPaused}
                  title={systemSnapshot.workerPaused ? "Resume the background worker" : "Pause the background worker between jobs"}
                  type="button"
                >
                  {systemSnapshot.workerPaused ? "resume" : "pause"}
                </button>
              ) : null}
            </div>
            <div className={systemSnapshot?.postingEnabled ? "rail-row posting-on" : "rail-row"}>
              <span aria-hidden="true" className="rail-dot" />
              <span>posting {systemSnapshot?.postingEnabled ? "on" : "off"}</span>
              <button
                className={systemSnapshot?.postingEnabled ? "rail-toggle danger" : "rail-toggle"}
                disabled={busyScopes.includes("header")}
                onClick={togglePosting}
                title="Toggle whether queued jobs may publish to X"
                type="button"
              >
                {systemSnapshot?.postingEnabled ? "turn off" : "arm"}
              </button>
            </div>
          </div>
          <div className="rail-actions">
            <button aria-label="Setup checks" className="ghost onboarding-help" onClick={openOnboarding} title="Setup checks" type="button">?</button>
            {isElectron ? <span className="sidebar-version">v{appVersion || "—"}</span> : null}
          </div>
        </div>
      </aside>
      <div className="app-main">
        <div className="account-bar">
          <div className="account-bar-inner">
            <div className="account-cluster">
              <select
                aria-label="Active account"
                value={activeAccountId}
                disabled={busyScopes.includes("header")}
                onChange={(event) => {
                  const nextId = event.target.value;
                  const previousId = activeAccountId;
                  setActiveAccountId(nextId);
                  setBrowserSession(null);
                  // Single-account rule: switching accounts activates that
                  // account for posting (relaunches the posting Chrome with
                  // its profile) and refreshes the session indicator. On
                  // failure the selection reverts so the select never shows
                  // an account whose activation did not happen.
                  run(async () => {
                    try {
                      const result = await api<{ loggedIn: boolean }>("/browser/activate", {
                        method: "POST",
                        body: JSON.stringify({ accountId: nextId })
                      });
                      const switched = accounts.find((account) => account.id === nextId);
                      setBrowserSession({
                        accountId: nextId,
                        cdpUrl: null,
                        enabled: true,
                        error: null,
                        loggedIn: result.loggedIn,
                        profileDir: "",
                        url: null
                      });
                      notify(`Active account: @${switched?.handle ?? nextId}`, "info");
                    } catch (caught) {
                      setActiveAccountId(previousId);
                      throw caught;
                    }
                  }, "header");
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
              {browserSessionChecking ? (
                <span className="dot-chip checking" title="Checking the posting browser session">X checking…</span>
              ) : browserSession ? (
                <span
                  className={browserSession.loggedIn ? "dot-chip online" : "dot-chip offline"}
                  title={browserSession.observedHandle ? `Logged in as @${browserSession.observedHandle}` : undefined}
                >
                  X {browserSession.loggedIn ? "active" : "logged out"}
                </span>
              ) : (
                <span className="dot-chip unknown" title="Session not verified yet — click Check X">X unknown</span>
              )}
              <button className="secondary compact-button" disabled={busyScopes.includes("header") || browserSessionChecking} onClick={checkBrowserSession}>
                <Busy active={busyScopes.includes("header")} />Check X
              </button>
              {isElectron ? <button
                className="danger compact-button stop-everything"
                disabled={busyScopes.includes("stop-all")}
                onClick={stopEverything}
                title="Pause the worker, turn off prepare and post, close the posting Chrome"
              >
                <Busy active={busyScopes.includes("stop-all")} />Stop everything
              </button> : null}
            </div>
          </div>
        </div>
        <main className="content-area">
          {error ? (
            <div className="notice error notice-action" role="alert">
              <span>{error}</span>
              <span className="notice-actions">
                <button
                  className="ghost compact-button"
                  type="button"
                  onClick={() => {
                    setError(null);
                    void refresh().catch(() => undefined);
                  }}
                >
                  Retry
                </button>
                <button className="ghost compact-button" type="button" onClick={() => setError(null)}>Dismiss</button>
              </span>
            </div>
          ) : null}
          <header className="view-header">
            <h1>{activeViewMeta.title}</h1>
            <p>{activeViewMeta.description}</p>
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
      <div aria-live="polite" aria-relevant="additions" className="toast-stack" role="status">
        {toasts.map((toast) => (
          <div className={`toast toast--${toast.kind}`} key={toast.id}>
            <span aria-hidden="true" className="toast-mark" />
            <span className="toast-message">{toast.message}</span>
            <button
              aria-label="Dismiss notification"
              className="toast-close"
              onClick={() => dismissToast(toast.id)}
              type="button"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Missing #root element");

createRoot(root).render(<App />);
