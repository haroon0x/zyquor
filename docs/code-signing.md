# Windows Code Signing

Zyquor can sign Windows releases with Azure Trusted Signing, now named Microsoft Artifact Signing. The Azure account, identity validation, certificate profile, billing, and service-principal credential must be created before signing can begin. No certificate or private key is stored in this repository.

## Azure setup

1. Follow Microsoft's [Artifact Signing setup quickstart](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) to register the `Microsoft.CodeSigning` resource provider, create an account in a supported region, and complete public identity validation.
2. Create a production `Public Trust` certificate profile. `Public Trust Test` profiles are for testing and are not publicly trusted Windows release certificates.
3. [Create a Microsoft Entra app registration and service principal](https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal) for GitHub Actions, then create a client secret. Save the secret value when it is created; Azure does not show it again.
4. Assign that service principal the `Artifact Signing Certificate Profile Signer` role at the certificate-profile scope. Microsoft documents the profile-level scope in its [role assignment tutorial](https://learn.microsoft.com/en-us/azure/artifact-signing/tutorial-assign-roles).
5. Record the tenant ID, application client ID, client-secret value, regional signing endpoint, account name, and certificate profile name.

The regional signing endpoint must match the region of the account and certificate profile. Copy it from Microsoft's endpoint table in the setup quickstart; it is a `https://<region>.codesigning.azure.net` URI, not the Azure portal URL or Azure Resource Manager resource ID.

## GitHub configuration

Create these repository settings under **Settings → Secrets and variables → Actions**.

| Type | Name | Value |
| --- | --- | --- |
| Secret | `AZURE_TENANT_ID` | Microsoft Entra directory/tenant ID |
| Secret | `AZURE_CLIENT_ID` | App registration application/client ID |
| Secret | `AZURE_CLIENT_SECRET` | App registration client-secret value, not its secret ID |
| Variable | `AZURE_TRUSTED_SIGNING_ENDPOINT` | Regional Trusted Signing endpoint URI |
| Variable | `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME` | Trusted Signing/Artifact Signing account name |
| Variable | `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME` | Production certificate profile name |

All six values are required to enable signing. The endpoint, account name, and profile name are identifiers rather than credentials, so the workflow reads them from repository variables. The three Microsoft Entra credentials are repository secrets.

## CI behavior and unsigned fallback

The `dist-desktop-win` job runs for `v*` tags and manual workflow dispatches. It checks whether all six settings are non-empty without printing their values.

- When every setting exists, CI runs `dist:win:signed`. The signing overlay at `apps/desktop/electron-builder.azure.cjs` enables executable editing and supplies electron-builder's `win.azureSignOptions`. electron-builder reads the three Microsoft Entra credential environment variables directly and signs the app executable, NSIS uninstaller, and final installer.
- When any setting is absent, CI runs the existing `dist:win` command. The base `apps/desktop/electron-builder.yml` still has `signAndEditExecutable: false` and no `azureSignOptions`, so electron-builder never initializes Azure signing. The unsigned installer continues to build and publish exactly as before.

Local `pnpm --filter @zyquor/desktop dist:dir` builds always use the base configuration and remain unsigned. To request a signed Windows build explicitly, use `pnpm --filter @zyquor/desktop dist:win:signed` on Windows with all six settings in the environment.

If signing is selected but Azure authentication, role assignment, identity validation, the profile, or the endpoint is invalid, electron-builder fails the signed build instead of publishing an artifact that was expected to be signed.

## Releases and auto-update

Both Windows build paths retain electron-builder's GitHub publisher and `--publish onTagOrDraft` behavior. For a signed release, electron-builder signs the Windows executables before it creates the final update artifacts, then publishes the signed NSIS installer and its generated update metadata to the GitHub release.

Packaged Zyquor installations use `electron-updater` to read that GitHub release metadata, download the same signed installer, and install it on restart or app exit. Signing does not create a separate update channel or change update discovery. Keep the same validated identity and production certificate profile across releases so Windows presents a stable publisher identity.

After the first configured build, download the release installer and verify it in PowerShell:

```powershell
Get-AuthenticodeSignature .\Zyquor*.exe | Format-List Status, StatusMessage, SignerCertificate
```

`Status` should be `Valid`, and `SignerCertificate` should match the validated Azure identity.
