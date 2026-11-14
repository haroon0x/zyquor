# Windows Code Signing

**Status: nothing is signed today.** `cargo tauri build` produces unsigned NSIS
(`.exe`) and MSI (`.msi`) installers, and the `desktop-win` CI job uploads those
unsigned bundles. Downloads therefore show the usual Windows SmartScreen
"unknown publisher" warning. Everything below is the wiring and the procedure
for changing that; none of it makes the current builds signed.

The retired desktop implementation's packaging/signing procedure no longer
applies to this tree. Only the Tauri v2 procedure in this file applies.

What this doc is checked against: `apps/desktop/tauri.conf.json` (no
`bundle.windows` block today, `bundle.targets: "all"`), `.github/workflows/ci.yml`
(the `desktop-win` job), and Tauri CLI 2.x. See the upstream pages for details:
[Tauri v2 Windows code signing](https://v2.tauri.app/distribute/sign/windows/) and
[Tauri v2 updater](https://v2.tauri.app/plugin/updater/).

## What Windows signing covers

There are **two independent signature mechanisms**. Neither implies the other:

| Mechanism | What it signs | What verifies it | Needed for |
| --- | --- | --- | --- |
| **Authenticode** | The app `.exe`, bundled sidecar/resource binaries, the NSIS installer + uninstaller, and the MSI | Windows (`Get-AuthenticodeSignature`, SmartScreen, `signtool verify`) | Removing the "unknown publisher" warning, Smart App Control, Microsoft Store |
| **Tauri updater signature** | Detached `.sig` files for the bundles the updater downloads | The Tauri updater plugin in an installed app, using the configured public key | Auto-update |

A signed auto-updating release needs **both**. Authenticode is what Windows
shows the user; the updater signature is what the running app trusts. Signing
one does not satisfy the other.

## Authenticode with Tauri v2

Tauri's bundler reads the `bundle.windows` block in `apps/desktop/tauri.conf.json`
(currently absent) or a config overlay passed with `cargo tauri build --config`.
Relevant fields:

| Field | Meaning |
| --- | --- |
| `certificateThumbprint` | SHA-1 thumbprint of a code-signing certificate that is installed in the Windows certificate store (default store: `Cert:\CurrentUser\My`). The bundler calls `signtool sign /fd <digest> /sha1 <thumbprint> ...`. |
| `digestAlgorithm` | File digest for `signtool /fd`; `sha256` is the recommended value. Defaults to `sha256` when unset. |
| `timestampUrl` | Timestamp server URL. Without one, signatures stop being valid when the certificate expires; with one, the signature stays verifiable. Use the URL your CA provides. |
| `tsp` | Set `true` when `timestampUrl` is an RFC 3161 (TSP) server; otherwise the bundler uses the older `/t` style. |
| `signCommand` | Alternative signer: a command string (or `{ "cmd": ..., "args": [...] }`) with `%1` replaced by the file path. Use this for a cloud signing service or for signing from a non-Windows host. |

`cargo tauri build --no-sign` skips both Authenticode and updater signing. On
Windows both the NSIS installer and the MSI are signed, because
`bundle.targets` is `"all"`.

The default `signtool.exe` is located in the Windows SDK through the Windows
Kits registry key; set `TAURI_WINDOWS_SIGNTOOL_PATH` to use a specific
`signtool.exe`. Default signing only works on Windows hosts. Cross-compiling
from Linux/macOS requires `signCommand`.

Two example shapes (placeholders — these are **not** real values):

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "<CERTIFICATE_SHA1_THUMBPRINT_PLACEHOLDER>",
      "digestAlgorithm": "sha256",
      "timestampUrl": "<YOUR_CA_TIMESTAMP_URL_PLACEHOLDER>"
    }
  }
}
```

```json
{
  "bundle": {
    "windows": {
      "signCommand": "<SIGNING_CLI> --file %1"
    }
  }
}
```

A cloud-signing path (Azure Artifact Signing, formerly Azure Trusted Signing)
is a `signCommand` variant, for example `artifact-signing-cli -e <endpoint>
-a <account> -c <certificate-profile> -d Zyquor %1` with
`AZURE_TENANT_ID` / `AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` in the
environment. That path is **not wired in this repository today**; see
[Open decisions](#open-decisions-todo). The upstream Tauri guide documents the
service-specific steps.

## CI wiring (`.github/workflows/ci.yml`, `desktop-win`)

The `desktop-win` job runs on `windows-latest` for `v*` tags and manual
`workflow_dispatch` runs. It has an optional Authenticode step, guarded on
repository secrets, so the job still builds and uploads unsigned bundles when
signing is not configured.

**Signing configuration** — repository settings under
**Settings → Secrets and variables → Actions**:

| Type | Name | Contents |
| --- | --- | --- |
| Secret | `WINDOWS_CERTIFICATE` | The `.pfx` code-signing certificate. Base64 (one line) or PEM-armored base64 (what `certutil -encode file.pfx out.txt` produces). Placeholder only — never commit it. |
| Secret | `WINDOWS_CERTIFICATE_PASSWORD` | The `.pfx` export password. Placeholder only — never commit it. |
| Variable | `WINDOWS_TIMESTAMP_URL` | Optional. The timestamp server URL from your certificate authority. Recommended; without it signatures expire with the certificate. |

The certificate thumbprint is **derived by CI** from the imported certificate,
so there is no thumbprint secret to maintain. No certificate, password, or
key material is stored anywhere in this repository.

Behavior:

- Neither secret set → job logs that signing is not configured and builds with
  plain `cargo tauri build`. Bundles are unsigned, as today.
- Only one of the two secrets set → the job fails with a clear error instead of
  silently producing unsigned installers (a partially configured secret pair is
  almost certainly a mistake).
- Both set → the job decodes the PFX into `$RUNNER_TEMP`, imports it into
  `Cert:\CurrentUser\My`, writes a temporary merge config in `$RUNNER_TEMP`
  with the derived thumbprint, `digestAlgorithm: sha256`, and the timestamp URL
  when `WINDOWS_TIMESTAMP_URL` is set, deletes the PFX, then builds with
  `cargo tauri build --config <that config>`. After bundling it verifies every
  NSIS `.exe` and MSI with `Get-AuthenticodeSignature` and fails the job unless
  each signature is `Valid`. The temporary merge config is never committed.

The signed CI path has **not been exercised with a real certificate yet**; the
first tag build with the secrets set is its acceptance test. Until then, treat
signing as unimplemented, not as working.

CI does **not** publish a GitHub release, does **not** produce updater
artifacts, and does **not** verify timestamps. Those remain maintainer steps.

## Signing locally on Windows

Run this from a native Windows checkout (never WSL), after building the
renderer (`build.frontendDist` is `../web/dist`):

```powershell
pnpm --dir apps/web build
```

1. Get a **code-signing** certificate (OV or EV) from a CA. An SSL/TLS
   certificate will not work. Export it as a password-protected `.pfx`.
2. Import it into the current user's personal store and read its thumbprint:

   ```powershell
   $password = ConvertTo-SecureString -String "<PFX_PASSWORD_PLACEHOLDER>" -Force -AsPlainText
   Import-PfxCertificate -FilePath "<PATH_TO_CERTIFICATE_PFX>" `
     -CertStoreLocation Cert:\CurrentUser\My -Password $password
   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
     Format-Table Subject, Thumbprint, NotAfter
   ```

3. Write a temporary merge config (keep it out of git) with the thumbprint from
   step 2 and the timestamp URL your CA provides. Use the JSON shape shown in
   [Authenticode with Tauri v2](#authenticode-with-tauri-v2), replacing the
   placeholders.
4. Build with the overlay:

   ```powershell
   cargo tauri build --config "<PATH_TO_LOCAL_SIGNING_CONFIG>.json"
   ```

   Passing `bundle.windows` in `tauri.conf.json` itself works too, but the
   thumbprint/CA details are machine- and certificate-specific, so a local
   overlay is easier to keep out of the shared config.

5. Verify the output:

   ```powershell
   Get-AuthenticodeSignature "target\release\bundle\nsis\<INSTALLER_NAME>.exe" |
     Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
   signtool verify /pa /v "target\release\bundle\nsis\<INSTALLER_NAME>.exe"
   ```

`Status` must be `Valid`, `SignerCertificate.Subject` must be the expected
publisher identity, and `TimeStamperCertificate` should be present when the
signature was timestamped. Sysinternals `sigcheck -a -h <file>` shows the same
information.

## Updater signing (separate from Authenticode)

The Tauri updater signs update artifacts with its own key pair. This key is
**not** the Authenticode certificate and is not trusted by Windows; it is only
trusted by the updater plugin inside installed Zyquor apps.

- Enable the updater: add the `tauri-plugin-updater` dependency, configure
  `plugins.updater` (including the `pubkey` for the updater public key), and
  set `"bundle": { "createUpdaterArtifacts": true }`. Building without a
  `plugins.updater` block while `createUpdaterArtifacts` is enabled is a
  configuration error.
- Generate the key pair once with
  `cargo tauri signer generate -w "<PATH_TO_UPDATER_KEY>"` and keep the private
  key file out of git.
- At build time the CLI reads `TAURI_SIGNING_PRIVATE_KEY` (the key itself or a
  path to it) and optionally `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (when the key
  has a password), and writes a detached `.sig` file next to each updater
  bundle. The private key must match the `plugins.updater.pubkey` value.
- CI would store both as repository secrets. `cargo tauri build --no-sign`
  skips updater signing as well.

Today this tree has **no updater wiring**: `apps/desktop/Cargo.toml` does not
depend on `tauri-plugin-updater`, `tauri.conf.json` has no `plugins.updater`
block and no `createUpdaterArtifacts`, and the desktop app's update polling is a
stub. There are therefore no updater artifacts or `.sig` files to produce yet.
Enabling the updater is a separate change (see below).

## Open decisions (TODO)

1. **Signing provider.** CI implements the "certificate in the Windows store +
   `signtool`" path, which works with any CA-issued code-signing certificate
   (OV or EV). The alternative is a cloud signing service wired through
   `bundle.windows.signCommand` (Azure Artifact Signing via
   `artifact-signing-cli`, Azure Key Vault via `relic`, or a similar service),
   which needs its own secrets and a different CI step. Decide before shipping
   a signed release; CI is currently generic + local-cert only.
2. **Certificate identity and custodian.** Which legal publisher name, which CA,
   certificate lifetime, who holds the PFX/password, and the renewal/rotation
   plan. Keep the same identity across releases so SmartScreen reputation
   carries over.
3. **Timestamp server.** Set `WINDOWS_TIMESTAMP_URL` (CA-provided). If the CA
   serves RFC 3161 timestamps, the config also needs `"tsp": true`.
4. **Enforcement.** Once a certificate exists, make `desktop-win` fail when the
   signing secrets are missing on `v*` tags, so an unsigned installer cannot be
   published as a release by accident.
5. **Updater key pair.** Generate it, add the plugin/config, store
   `TAURI_SIGNING_PRIVATE_KEY` (+ password if any) as CI secrets, and back the
   private key up off-CI: losing it means installed clients can no longer
   verify updates.
6. **Release publishing.** `desktop-win` only uploads build artifacts; a
   maintainer still creates the GitHub release and attaches the (signed)
   installers.

## Security notes

- This repository is **AGPL-3.0-only** (see [LICENSE](../LICENSE)). Certificate
  material, PFX passwords, and updater private keys are not source and must
  never be committed, attached to issues, pasted into logs, or shipped in
  builds.
- Treat `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD`,
  `TAURI_SIGNING_PRIVATE_KEY`, and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as
  production secrets: repository secrets, limited to trusted maintainers, and
  rotated immediately if exposed. The CI script never prints secret values; the
  certificate thumbprint it does print is public certificate metadata.
- The PFX is written to the ephemeral runner's `$RUNNER_TEMP`, imported, and
  deleted in a `finally` block. Runners are disposable; do not expect the store
  to survive between jobs.
- Signing only proves publisher identity; it does not make the app safe and it
  does not by itself remove SmartScreen warnings. Reputation accrues per
  certificate and per file over time, and a new certificate starts over.
- Report vulnerabilities as described in [SECURITY.md](../SECURITY.md).
