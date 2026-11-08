import { useState } from "react";
import { api } from "../api.js";
import type { Account, PanelProps } from "../types.js";
import { Busy, PanelIcon } from "./Feedback.js";

const POSTING_MODES = ["prepare_only", "scheduled", "autopost", "draft_only", "review_required"] as const;

type PostingMode = (typeof POSTING_MODES)[number];

const TIME_PATTERN = /^\d{2}:\d{2}$/;

function isValidTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

interface EditState {
  displayName: string;
  profileDir: string;
  postingMode: PostingMode;
  dailyPostLimit: string;
  quietHoursStart: string;
  quietHoursEnd: string;
}

function editStateFor(account: Account): EditState {
  return {
    displayName: account.displayName,
    profileDir: account.profileDir,
    postingMode: account.postingMode as PostingMode,
    dailyPostLimit: account.dailyPostLimit == null ? "" : String(account.dailyPostLimit),
    quietHoursStart: account.quietHoursStart ?? "",
    quietHoursEnd: account.quietHoursEnd ?? ""
  };
}

export function AccountsPanel({ accounts, panel }: { accounts: Account[]; panel: PanelProps }) {
  const { busy, refresh, run } = panel;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<EditState | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  function setEnabled(account: Account, enabled: boolean) {
    run(async () => {
      await api(`/accounts/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({ enabled })
      });
      await refresh();
    });
  }

  function deleteAccount(account: Account) {
    if (!window.confirm(`Delete ${account.displayName} (@${account.handle})?`)) return;
    run(async () => {
      await api(`/accounts/${account.id}`, { method: "DELETE" });
      await refresh();
    });
  }

  function startEditing(account: Account) {
    setEditingId(account.id);
    setForm(editStateFor(account));
    setFormError(null);
  }

  function cancelEditing() {
    setEditingId(null);
    setForm(null);
    setFormError(null);
  }

  function saveEditing(account: Account) {
    if (!form) return;
    if (!form.displayName.trim()) {
      setFormError("Display name is required (1–120 characters).");
      return;
    }
    if (form.displayName.length > 120) {
      setFormError("Display name is too long (max 120 characters).");
      return;
    }
    if (!form.profileDir.trim()) {
      setFormError("Profile directory is required (must live under profiles/).");
      return;
    }
    let dailyPostLimit: number | null = null;
    if (form.dailyPostLimit.trim() !== "") {
      dailyPostLimit = Number(form.dailyPostLimit);
      if (!Number.isInteger(dailyPostLimit) || dailyPostLimit < 0) {
        setFormError("Daily post limit must be a whole number of 0 or more, or blank to clear.");
        return;
      }
    }
    if (form.quietHoursStart && !isValidTime(form.quietHoursStart)) {
      setFormError("Quiet hours start must be HH:MM (00:00–23:59), or blank to clear.");
      return;
    }
    if (form.quietHoursEnd && !isValidTime(form.quietHoursEnd)) {
      setFormError("Quiet hours end must be HH:MM (00:00–23:59), or blank to clear.");
      return;
    }
    if ((form.quietHoursStart && !form.quietHoursEnd) || (!form.quietHoursStart && form.quietHoursEnd)) {
      setFormError("Set both quiet hours start and end, or blank both to clear.");
      return;
    }
    run(async () => {
      await api(`/accounts/${account.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          displayName: form.displayName.trim(),
          profileDir: form.profileDir.trim(),
          postingMode: form.postingMode,
          dailyPostLimit,
          quietHoursStart: form.quietHoursStart || null,
          quietHoursEnd: form.quietHoursEnd || null
        })
      });
      cancelEditing();
      await refresh();
    });
  }

  return (
    <section className="panel settings accounts-settings">
      <div className="panel-head">
        <h2 className="panel-title"><PanelIcon name="layers" />Accounts</h2>
        <span className="pill">{accounts.length} total</span>
      </div>
      <div className="account-settings-list">
        {accounts.map((account) => (
          <div className="account-settings-row" key={account.id}>
            <div className="account-settings-identity">
              <strong>{account.displayName}</strong>
              <span>@{account.handle}</span>
              <small>{account.profileDir}</small>
            </div>
            {editingId === account.id && form ? (
              <form
                className="account-edit-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  saveEditing(account);
                }}
              >
                {formError ? <p className="form-error">{formError}</p> : null}
                <label>
                  <span>Display name</span>
                  <input
                    aria-label="Display name"
                    maxLength={120}
                    value={form.displayName}
                    onChange={(event) => setForm({ ...form, displayName: event.target.value })}
                  />
                </label>
                <label>
                  <span>Profile directory</span>
                  <input
                    aria-label="Profile directory"
                    value={form.profileDir}
                    onChange={(event) => setForm({ ...form, profileDir: event.target.value })}
                  />
                </label>
                <label>
                  <span>Posting mode</span>
                  <select
                    aria-label="Posting mode"
                    value={form.postingMode}
                    onChange={(event) => setForm({ ...form, postingMode: event.target.value as PostingMode })}
                  >
                    {POSTING_MODES.map((mode) => (
                      <option key={mode} value={mode}>{mode}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Daily post limit</span>
                  <input
                    aria-label="Daily post limit"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    type="number"
                    placeholder="Unlimited"
                    value={form.dailyPostLimit}
                    onChange={(event) => setForm({ ...form, dailyPostLimit: event.target.value })}
                  />
                </label>
                <label>
                  <span>Quiet hours start</span>
                  <input
                    aria-label="Quiet hours start"
                    placeholder="HH:MM"
                    value={form.quietHoursStart}
                    onChange={(event) => setForm({ ...form, quietHoursStart: event.target.value })}
                  />
                </label>
                <label>
                  <span>Quiet hours end</span>
                  <input
                    aria-label="Quiet hours end"
                    placeholder="HH:MM"
                    value={form.quietHoursEnd}
                    onChange={(event) => setForm({ ...form, quietHoursEnd: event.target.value })}
                  />
                </label>
                <div className="account-edit-actions">
                  <button className="compact-button" disabled={busy} type="submit">
                    <Busy active={busy} />Save
                  </button>
                  <button className="ghost compact-button" disabled={busy} type="button" onClick={cancelEditing}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <div className="account-settings-actions">
                <label className="checkbox-row switch-row">
                  <input
                    aria-label={`${account.enabled ? "Disable" : "Enable"} ${account.displayName}`}
                    checked={account.enabled}
                    disabled={busy}
                    type="checkbox"
                    onChange={(event) => setEnabled(account, event.target.checked)}
                  />
                  <span aria-hidden="true" className="switch" />
                  {account.enabled ? "Enabled" : "Disabled"}
                </label>
                <button className="ghost compact-button" disabled={busy} onClick={() => startEditing(account)}>
                  Edit
                </button>
                <button className="ghost danger compact-button" disabled={busy} onClick={() => deleteAccount(account)}>
                  <Busy active={busy} />Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
