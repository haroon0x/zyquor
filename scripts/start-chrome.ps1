$ErrorActionPreference = "Stop"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$userData = "C:\Users\asus\zyquor-cdp-profile"
if (-not (Test-Path $userData)) {
  Write-Output "Profile missing"
  exit 1
}
$env:CHROME_REMOTE_DEBUGGING_ADDRESS = "0.0.0.0"
$env:CHROME_REMOTE_DEBUGGING_PORT = "9222"
$argList = "--remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --user-data-dir=`"$userData`" --no-first-run --no-default-browser-check --disable-gpu --no-sandbox"
Write-Output "Launching: $chrome $argList"
$proc = Start-Process -FilePath $chrome -ArgumentList $argList -PassThru -RedirectStandardError "C:\Users\asus\chrome-stderr.log"
Write-Output "PID: $($proc.Id)"
Start-Sleep -Seconds 5
$running = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
if ($running) {
  Write-Output "Still running"
} else {
  Write-Output "Process exited"
  Write-Output "ExitCode: $($proc.ExitCode)"
  if (Test-Path "C:\Users\asus\chrome-stderr.log") {
    Get-Content "C:\Users\asus\chrome-stderr.log" | Select-Object -First 20
  }
}
