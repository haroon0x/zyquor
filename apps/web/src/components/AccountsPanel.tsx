import { api } from "../api.js";
import type { Account, PanelProps } from "../types.js";
import { Busy, PanelIcon } from "./Feedback.js";

export function AccountsPanel({ accounts, panel }: { accounts: Account[]; panel: PanelProps }) {
  const { busy, refresh, run } = panel;

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
              <button className="ghost danger compact-button" disabled={busy} onClick={() => deleteAccount(account)}>
                <Busy active={busy} />Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
