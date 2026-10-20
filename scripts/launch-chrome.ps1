# Launch a dedicated Chrome instance with the extension loaded (CDP port 9333).
# Uses an isolated user-data-dir so the user's daily browser is untouched.
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less .ps1 files as
# ANSI (cp936), which corrupts non-ASCII comments and breaks parsing.
param(
  [string]$ProfileDir = "$env:TEMP\anti-bubble-chrome-profile"
)

$ErrorActionPreference = 'Stop'
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
$dist = "D:\coding\anti-bubble\dist"

if (-not (Test-Path $dist)) {
  Write-Host "dist missing - run npm run build first" -ForegroundColor Red
  exit 1
}

# Reusing an existing instance makes Chrome ignore --load-extension,
# so kill any previous instance that used this same profile dir.
Get-Process chrome -ErrorAction SilentlyContinue |
  ForEach-Object {
    try {
      $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
      if ($cmdline -like "*$ProfileDir*") {
        Write-Host "killing old instance PID $($_.Id)"
        Stop-Process -Id $_.Id -Force
      }
    } catch { }
  }
Start-Sleep -Milliseconds 800

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$chromeArgs = @(
  "--user-data-dir=$ProfileDir",
  "--remote-debugging-port=9333",
  "--load-extension=$dist",
  "--disable-extensions-except=$dist",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=Translate,OptimizationGuideModelDownloading",
  "https://www.bilibili.com/"
)

Write-Host "launching Chrome (CDP port 9333)..."
Start-Process -FilePath $chrome -ArgumentList $chromeArgs
Start-Sleep -Seconds 5

try {
  $ver = Invoke-RestMethod "http://127.0.0.1:9333/json/version" -TimeoutSec 10
  Write-Host "CDP ready: $($ver.Browser)" -ForegroundColor Green
} catch {
  Write-Host "CDP not ready: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
