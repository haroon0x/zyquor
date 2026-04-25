import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

interface Account {
  id: string;
  displayName: string;
  handle: string;
  postingMode: string;
  profileDir: string;
  enabled: boolean;
  dailyPostLimit: number | null;
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
  draftId: string;
  status: string;
  mode: string;
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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
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
  const [accountDraft, setAccountDraft] = useState<Account | null>(null);
  const [idea, setIdea] = useState("");
  const [draft, setDraft] = useState<DraftResponse | null>(null);
  const [editedText, setEditedText] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);
  const [attemptsByJob, setAttemptsByJob] = useState<Record<string, Attempt[]>>({});
  const [generation, setGeneration] = useState<GenerationConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh().catch((caught) => {
      setError(caught instanceof Error ? caught.message : "API unavailable");
    });
  }, []);

  async function refresh() {
    const [{ accounts: loadedAccounts }, { jobs: loadedJobs }, { generation: loadedGeneration }] = await Promise.all([
      api<{ accounts: Account[] }>("/accounts"),
      api<{ jobs: Job[] }>("/jobs"),
      api<{ generation: GenerationConfig }>("/generation")
    ]);
    const attemptsEntries = await Promise.all(
      loadedJobs.map(async (job) => {
        const { attempts } = await api<{ attempts: Attempt[] }>(`/jobs/${job.id}/attempts`);
        return [job.id, attempts] as const;
      })
    );

    setAccounts(loadedAccounts);
    setJobs(loadedJobs);
    setGeneration(loadedGeneration);
    setAttemptsByJob(Object.fromEntries(attemptsEntries));
    const nextActiveAccount = loadedAccounts.find((account) => account.id === activeAccountId) ?? loadedAccounts[0] ?? null;
    if (nextActiveAccount) {
      setActiveAccountId(nextActiveAccount.id);
      setAccountDraft(nextActiveAccount);
    }
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
      const response = await api<DraftResponse>("/drafts", {
        method: "POST",
        body: JSON.stringify({ accountId: activeAccountId, idea, count: 3 })
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
        body: JSON.stringify({ editedText })
      });
      setDraft({ ...draft, draft: response.draft });
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

  function saveAccount() {
    if (!accountDraft) {
      return;
    }

    run(async () => {
      const { account } = await api<{ account: Account }>(`/accounts/${accountDraft.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: accountDraft.displayName,
          handle: accountDraft.handle,
          profileDir: accountDraft.profileDir,
          postingMode: accountDraft.postingMode,
          enabled: accountDraft.enabled,
          dailyPostLimit: accountDraft.dailyPostLimit
        })
      });
      setAccountDraft(account);
      await refresh();
    });
  }

  const activeAccount = accounts.find((account) => account.id === activeAccountId);

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
            setAccountDraft(account ?? null);
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
          <span>{activeAccount.postingMode}</span>
          <span>{activeAccount.profileDir}</span>
          {generation ? (
            <span className={generation.configured ? "provider-pill" : "provider-pill failed"}>
              {generation.provider}:{generation.model}
            </span>
          ) : null}
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
            placeholder="Write rough idea..."
            rows={8}
          />
          <button disabled={!idea.trim() || busy}>Generate drafts</button>
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
            <span>{editedText.length}/4000</span>
          </div>
          <textarea aria-label="Edited draft" value={editedText} onChange={(event) => setEditedText(event.target.value)} rows={12} />
          <button disabled={!draft || !editedText.trim() || draft.draft.status === "approved" || busy} onClick={approveDraft}>
            Approve job
          </button>
        </section>
      </section>

      {accountDraft ? (
        <section className="panel settings">
          <div className="panel-head">
            <h2>Account</h2>
            <span>{accountDraft.enabled ? "enabled" : "disabled"}</span>
          </div>
          <div className="settings-grid">
            <label>
              Display
              <input
                value={accountDraft.displayName}
                onChange={(event) => setAccountDraft({ ...accountDraft, displayName: event.target.value })}
              />
            </label>
            <label>
              Handle
              <input
                value={accountDraft.handle}
                onChange={(event) => setAccountDraft({ ...accountDraft, handle: event.target.value })}
              />
            </label>
            <label>
              Profile
              <input
                value={accountDraft.profileDir}
                onChange={(event) => setAccountDraft({ ...accountDraft, profileDir: event.target.value })}
              />
            </label>
            <label>
              Mode
              <select
                value={accountDraft.postingMode}
                onChange={(event) => setAccountDraft({ ...accountDraft, postingMode: event.target.value })}
              >
                <option value="draft_only">draft_only</option>
                <option value="prepare_only">prepare_only</option>
                <option value="review_required">review_required</option>
              </select>
            </label>
            <label>
              Daily limit
              <input
                min="1"
                type="number"
                value={accountDraft.dailyPostLimit ?? ""}
                onChange={(event) =>
                  setAccountDraft({
                    ...accountDraft,
                    dailyPostLimit: event.target.value ? Number(event.target.value) : null
                  })
                }
              />
            </label>
            <label className="checkbox-row">
              <input
                checked={accountDraft.enabled}
                type="checkbox"
                onChange={(event) => setAccountDraft({ ...accountDraft, enabled: event.target.checked })}
              />
              Enabled
            </label>
          </div>
          <button disabled={busy} onClick={saveAccount}>
            Save account
          </button>
        </section>
      ) : null}

      <section className="panel queue">
        <div className="panel-head">
          <h2>Jobs</h2>
          <span>{jobs.length}</span>
        </div>
        {jobs.length ? (
          <div className="job-list">
            {jobs.map((job) => (
              <article className="job" key={job.id}>
                <div>
                  <strong>{job.id}</strong>
                  <span>{job.mode}</span>
                </div>
                <span className={`status ${job.status}`}>{job.status}</span>
                <div className="job-actions">
                  <button className="secondary" disabled={job.status !== "approved" || busy} onClick={() => prepareJob(job)}>
                    Prepare
                  </button>
                  <button
                    className="secondary"
                    disabled={(job.status !== "approved" && job.status !== "prepared") || busy}
                    onClick={() => postJob(job)}
                  >
                    Post
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
          <p className="empty">Approved jobs appear here.</p>
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
