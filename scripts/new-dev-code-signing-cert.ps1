# Create a self-signed code-signing certificate for LOCAL pipeline testing.
#
# This certificate is NOT trusted by Windows SmartScreen or any other machine.
# Use it only to dry-run the Authenticode plumbing described in
# docs/code-signing.md (import -> build with certificateThumbprint -> verify).
# Never use it for a release: Get-AuthenticodeSignature will report the
# signature as untrusted even when the signing step itself worked.
#
# Usage (Windows, PowerShell):
#   pwsh -File scripts/new-dev-code-signing-cert.ps1
#   pwsh -File scripts/new-dev-code-signing-cert.ps1 -OutDir C:\temp\zyquor-signing
#
# It prints the base64 PFX + password to feed into the same environment
# variables the CI job expects:
#   WINDOWS_CERTIFICATE          = <base64 PFX>
#   WINDOWS_CERTIFICATE_PASSWORD = <generated password>

[CmdletBinding()]
param(
    [string]$Subject = "CN=Zyquor Dev (UNTRUSTED)",
    [string]$OutDir = (Join-Path $PSScriptRoot "..\..\.tmp\dev-signing"),
    [int]$ValidDays = 365
)

$ErrorActionPreference = "Stop"

Write-Warning "Creating a SELF-SIGNED, UNTRUSTED development certificate. Do not use for releases."

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -CertStoreLocation "Cert:\CurrentUser\My" `
    -NotAfter (Get-Date).AddDays($ValidDays)

$alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
$password = -join (1..32 | ForEach-Object { $alphabet[(Get-Random -Maximum $alphabet.Length)] })
$securePassword = ConvertTo-SecureString -String $password -Force -AsPlainText

$pfxPath = Join-Path $OutDir "zyquor-dev-code-signing.pfx"
Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePassword | Out-Null

$base64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfxPath))
$base64Path = Join-Path $OutDir "zyquor-dev-code-signing.pfx.base64"
[IO.File]::WriteAllText($base64Path, $base64)
$passwordPath = Join-Path $OutDir "zyquor-dev-code-signing.password"
[IO.File]::WriteAllText($passwordPath, $password)

Write-Host ""
Write-Host "Self-signed certificate ready (untrusted, local testing only)."
Write-Host "  thumbprint: $($cert.Thumbprint)"
Write-Host "  PFX:        $pfxPath"
Write-Host "  base64 PFX: $base64Path"
Write-Host "  password:   $passwordPath"
Write-Host ""
Write-Host "To dry-run the CI signing path locally:"
Write-Host "  `$env:WINDOWS_CERTIFICATE = Get-Content '$base64Path' -Raw"
Write-Host "  `$env:WINDOWS_CERTIFICATE_PASSWORD = Get-Content '$passwordPath' -Raw"
Write-Host "  cargo tauri build --config apps/desktop/tauri.signing.local.conf.json"
Write-Host ""
Write-Host "Windows will report the result as untrusted (expected). To verify the"
Write-Host "signature was APPLIED (not trusted), use:"
Write-Host "  Get-AuthenticodeSignature .\target\release\bundle\nsis\*.exe | Format-List"
Write-Host "Expected status: UnknownError (untrusted root), signature present."
Write-Host ""
Write-Host "Cleanup when done:"
Write-Host "  Remove-Item -LiteralPath 'Cert:\CurrentUser\My\$($cert.Thumbprint)'"
