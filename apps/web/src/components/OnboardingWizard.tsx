import { useEffect, useRef, useState } from "react";
import { api, liveModelLabel } from "../api.js";
import { apiUrl } from "../api-base.js";
import type { BrowserSession, DraftResponse, GenerationResponse, OnboardingStatus } from "../types.js";
import { Busy } from "./Feedback.js";

const steps = ["Posting Chrome", "X login", "Generation", "Done"];
const chromeConnectionMessage = "Chrome with CDP is not running yet. Click Launch Chrome, or start the desktop app.";
const xLoginMessage = "Not logged in yet — sign in to X in the Chrome window that opened, then re-check.";

type WizardError = {
  details: string;
  message: string;
};

function TechnicalDetails({ details }: { details: string }) {
  return (
    <details className="onboarding-technical-details">
      <summary>Show technical details</summary>
      <pre>{details}</pre>
    </details>
  );
}

export function OnboardingWizard({
  accountId,
  initialStatus,
  onClose,
  onComplete,
  onDismissForever,
  onDraftCreated,
  onNavigate
}: {
  accountId: string;
  initialStatus: OnboardingStatus;
  onClose: () => void;
  onComplete: () => void;
  onDismissForever: () => void;
  onDraftCreated: (draft: DraftResponse | null) => void;
  onNavigate: (view: "compose" | "settings") => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [generation, setGeneration] = useState(initialStatus.generation);
  const [error, setError] = useState<WizardError | null>(null);
  const [launchUnavailable, setLaunchUnavailable] = useState(false);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const [testDraftId, setTestDraftId] = useState<string | null>(null);
  const [testCandidate, setTestCandidate] = useState<string | null>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>("[data-onboarding-focus]")?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"
        )
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    void api<GenerationResponse>("/generation")
      .then((response) => setGeneration((current) => ({ ...response.generation, isDefault: current.isDefault })))
      .catch(() => undefined);
    void api<BrowserSession>(`/browser/x-session?accountId=${encodeURIComponent(accountId)}`)
      .then(setSession)
      .catch(() => undefined);
  }, [accountId]);

  async function run(scope: "delete-draft" | "generation" | "launch" | "session", action: () => Promise<void>) {
    setBusy(scope);
    setError(null);
    try {
      await action();
    } catch (caught) {
      const details = caught instanceof Error ? caught.message : "Something went wrong";
      const message = scope === "generation"
        ? "Generation test failed. Check your provider settings and try again."
        : scope === "delete-draft"
          ? "Could not delete the test draft. Try again."
          : chromeConnectionMessage;
      setError({ details, message });
    } finally {
      setBusy(null);
    }
  }

  async function checkSession() {
    const nextSession = await api<BrowserSession>(`/browser/x-session?accountId=${encodeURIComponent(accountId)}`);
    setSession(nextSession);
  }

  function launchChrome() {
    void run("launch", async () => {
      const response = await fetch(apiUrl("/browser/launch-chrome"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId })
      });
      if (response.status === 404) {
        setLaunchUnavailable(true);
        setLaunchMessage(null);
        return;
      }
      const body = await response.json().catch(() => null) as { error?: string; launched?: boolean; reason?: string } | null;
      if (!response.ok) throw new Error(body?.error ?? `Chrome launch failed: ${response.status}`);
      setLaunchUnavailable(false);
      setLaunchMessage(body?.launched ? "Chrome launched with Zyquor's dedicated profile." : body?.reason ?? "Chrome is already available.");
      await checkSession();
    });
  }

  function checkLogin() {
    void run("session", checkSession);
  }

  function testGeneration() {
    void run("generation", async () => {
      const created = await api<DraftResponse>("/drafts", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          idea: "Share a practical lesson about why explicit review makes automation safer.",
          count: 1,
          tweetType: "guide"
        })
      });
      let generated: DraftResponse;
      try {
        generated = await api<DraftResponse>(`/drafts/${created.draft.id}/generate`, { method: "POST" });
      } catch (caught) {
        await api(`/drafts/${created.draft.id}`, { method: "DELETE" }).catch(() => undefined);
        throw caught;
      }
      setTestDraftId(generated.draft.id);
      setTestCandidate(generated.candidates[0]?.text ?? "Generation completed without a candidate.");
      onDraftCreated(generated);
    });
  }

  function deleteTestDraft() {
    if (!testDraftId) return;
    void run("delete-draft", async () => {
      await api(`/drafts/${testDraftId}`, { method: "DELETE" });
      setTestDraftId(null);
      setTestCandidate(null);
      onDraftCreated(null);
    });
  }

  const cdpReachable = session?.error === null;
  const loggedIn = session?.loggedIn === true;

  return (
    <div className="onboarding-overlay">
      <div
        aria-describedby="onboarding-description"
        aria-labelledby="onboarding-title"
        aria-modal="true"
        className="onboarding-dialog"
        ref={dialogRef}
        role="dialog"
      >
        <div className="onboarding-head">
          <div>
            <span className="onboarding-eyebrow">First-run setup</span>
            <h2 id="onboarding-title">Get Zyquor ready to post</h2>
            <p id="onboarding-description">Four quick checks. You can skip any step and return from the sidebar.</p>
          </div>
          <button aria-label="Close setup" className="ghost onboarding-close" data-onboarding-focus onClick={onClose}>×</button>
        </div>

        <div aria-label="Setup progress" className="onboarding-steps">
          {steps.map((label, index) => (
            <button
              aria-current={step === index ? "step" : undefined}
              className={step === index ? "onboarding-step active" : index < step ? "onboarding-step complete" : "onboarding-step"}
              key={label}
              onClick={() => setStep(index)}
            >
              <span>{index + 1}</span>
              {label}
            </button>
          ))}
        </div>

        <div className="onboarding-body">
          {error ? (
            <div className="notice error onboarding-error" role="alert">
              <p>{error.message}</p>
              <TechnicalDetails details={error.details} />
            </div>
          ) : null}

          {step === 0 ? (
            <section className="onboarding-section">
              <div className="onboarding-section-head">
                <div>
                  <span className="onboarding-kicker">Step 1</span>
                  <h3>Open Posting Chrome</h3>
                </div>
                <span className={cdpReachable ? "onboarding-status success" : "onboarding-status pending"}>
                  {cdpReachable ? "CDP connected" : "CDP not connected"}
                </span>
              </div>
              <p>Zyquor uses a dedicated Chrome profile for X. It never touches your everyday browser profile.</p>
              <button disabled={busy !== null} onClick={launchChrome}><Busy active={busy === "launch"} />Launch Chrome</button>
              {launchMessage ? <p className="onboarding-inline success-text">{launchMessage}</p> : null}
              {session?.error ? (
                <div className="onboarding-session-error">
                  <p className="onboarding-inline">{chromeConnectionMessage}</p>
                  <TechnicalDetails details={session.error} />
                </div>
              ) : null}
              {launchUnavailable ? (
                <div className="onboarding-fallback">
                  <strong>Chrome launch is available in the desktop app.</strong>
                  <p>Run Zyquor Desktop, or start Chrome manually with CDP and a dedicated profile:</p>
                  <code>google-chrome --user-data-dir=profiles/personal-main --profile-directory=Default --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 https://x.com/home</code>
                </div>
              ) : null}
            </section>
          ) : null}

          {step === 1 ? (
            <section className="onboarding-section">
              <div className="onboarding-section-head">
                <div>
                  <span className="onboarding-kicker">Step 2</span>
                  <h3>Log in to X</h3>
                </div>
                <span className={loggedIn ? "onboarding-status success" : "onboarding-status pending"}>
                  {loggedIn ? "Logged in" : "Login needed"}
                </span>
              </div>
              <p>Log in inside the dedicated Chrome window, leave it open, then check again here.</p>
              <button disabled={busy !== null} onClick={checkLogin}><Busy active={busy === "session"} />Check login</button>
              {session?.url ? <p className="onboarding-inline">Current page: {session.url}</p> : null}
              {session?.error ? (
                <div className="onboarding-session-error">
                  <p className="onboarding-inline">{chromeConnectionMessage}</p>
                  <TechnicalDetails details={session.error} />
                </div>
              ) : session && !session.loggedIn ? <p className="onboarding-inline">{xLoginMessage}</p> : null}
            </section>
          ) : null}

          {step === 2 ? (
            <section className="onboarding-section">
              <div className="onboarding-section-head">
                <div>
                  <span className="onboarding-kicker">Step 3</span>
                  <h3>Test generation</h3>
                </div>
                <span className={generation.configured ? "onboarding-status success" : "onboarding-status error"}>
                  {generation.configured ? "Provider available" : "Setup needed"}
                </span>
              </div>
              <p className="onboarding-model">Current model: <strong>{liveModelLabel(generation)}</strong>{generation.isDefault ? " · local default" : ""}</p>
              {generation.configured ? (
                <p>The API reports this provider as available. Generate one harmless test draft to verify the full path.</p>
              ) : (
                <p>This provider is missing required credentials. Open Settings to choose a provider and model.</p>
              )}
              <div className="onboarding-actions">
                <button disabled={busy !== null} onClick={testGeneration}><Busy active={busy === "generation"} />Test generation</button>
                {!generation.configured ? <button className="secondary" onClick={() => onNavigate("settings")}>Open Settings</button> : null}
              </div>
              {testCandidate ? (
                <div className="onboarding-candidate">
                  <span>First candidate</span>
                  <p>{testCandidate}</p>
                  <div>
                    <small>This test created a draft. It will be waiting in Compose, or you can delete it now.</small>
                    <button className="ghost compact-button danger" disabled={busy !== null} onClick={deleteTestDraft}>
                      <Busy active={busy === "delete-draft"} />Delete test draft
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          ) : null}

          {step === 3 ? (
            <section className="onboarding-section">
              <div className="onboarding-section-head">
                <div>
                  <span className="onboarding-kicker">Step 4</span>
                  <h3>Ready when you are</h3>
                </div>
                <span className="onboarding-status success">Setup reviewed</span>
              </div>
              <p>Zyquor starts safe: browser posting stays disabled until you enable it in Settings, and every post action is explicit.</p>
              <div className="onboarding-recap">
                <span className={cdpReachable ? "ready" : ""}>Posting Chrome <strong>{cdpReachable ? "connected" : "skipped"}</strong></span>
                <span className={loggedIn ? "ready" : ""}>X login <strong>{loggedIn ? "confirmed" : "skipped"}</strong></span>
                <span className={testCandidate ? "ready" : ""}>Generation <strong>{testCandidate ? "tested" : generation.configured ? "available" : "skipped"}</strong></span>
              </div>
            </section>
          ) : null}
        </div>

        <div className="onboarding-footer">
          <button className="ghost dismiss-onboarding" onClick={onDismissForever}>Don’t show automatically again</button>
          <div>
            {step > 0 ? <button className="ghost" onClick={() => setStep((current) => current - 1)}>Back</button> : null}
            {step < steps.length - 1 ? (
              <button onClick={() => setStep((current) => current + 1)}>Continue</button>
            ) : (
              <button onClick={onComplete}>Start composing</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
