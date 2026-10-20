# Launch a dedicated browser instance with the extension loaded, for live verification.
# Works with both Chrome and Edge (Chromium-based, same CDP surface).
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less .ps1 files as
# ANSI (cp936), which corrupts non-ASCII comments and breaks parsing.
#
# IMPORTANT: always use a FRESH profile dir per verification round.
# Chrome caches the extension's service worker script under
# <profile>/Default/Service Worker/ScriptCache and keeps serving that CACHED
# copy after the extension is re-loaded with new code. The symptom is
# "I rebuilt but the extension still behaves like the old version" (it even
# returns the old error strings). A fresh profile avoids it entirely.
#
# Usage:
#   .\launch-browser.ps1 -Browser chrome -Fresh
#   .\launch-browser.ps1 -Browser edge -Fresh
param(
  [ValidateSet('chrome', 'edge')]
  [string]$Browser = 'chrome',
  [int]$Port = 9333,
  [string]$ProfileDir = '',
  [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$dist = "D:\coding\anti-bubble\dist"

if (-not (Test-Path $dist)) {
  Write-Host "dist missing - run npm run build first" -ForegroundColor Red
  exit 1
}

if ($Browser -eq 'edge') {
  $exe = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  if (-not (Test-Path $exe)) { $exe = "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe" }
} else {
  $exe = "C:\Program Files\Google\Chrome\Application\chrome.exe"
}

if (-not (Test-Path $exe)) {
  Write-Host "browser not found: $exe" -ForegroundColor Red
  exit 1
}

if (-not $ProfileDir) {
  if ($Fresh) {
    # timestamped dir => every round gets a brand new profile
    $ProfileDir = "$env:TEMP\anti-bubble-$Browser-p" + (Get-Date -Format 'yyyyMMdd-HHmmss')
  } else {
    $ProfileDir = "$env:TEMP\anti-bubble-$Browser-profile"
  }
}

# Reusing an existing instance makes the browser ignore the launch flags,
# so kill any previous instance that used this same profile dir.
Get-Process -Name ([System.IO.Path]::GetFileNameWithoutExtension($exe)) -ErrorAction SilentlyContinue |
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

$browserArgs = @(
  "--user-data-dir=$ProfileDir",
  "--remote-debugging-port=$Port",
  # Chrome 142+ removed the DisableLoadExtensionCommandLineSwitch feature entirely,
  # so --load-extension no longer works in stable builds.
  # The supported way to load an unpacked extension for automation is the CDP
  # Extensions.loadUnpacked command, which requires --enable-unsafe-extension-debugging.
  "--enable-unsafe-extension-debugging",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=Translate,OptimizationGuideModelDownloading",
  # Start on about:blank, NOT on bilibili.com.
  #
  # Edge treats bilibili.com as a PWA and opens it in its own app window --
  # a small 524x364 window floating on top of the main one. That is what the
  # "small window stacked on the big window" screenshots showed.
  # Starting blank keeps the harness from creating that window at all;
  # the verification scripts navigate where they need to go.
  "about:blank"
)

Write-Host "launching $Browser (CDP port $Port)..."
Start-Process -FilePath $exe -ArgumentList $browserArgs
Start-Sleep -Seconds 5

try {
  $ver = Invoke-RestMethod "http://127.0.0.1:$Port/json/version" -TimeoutSec 10
  Write-Host "CDP ready: $($ver.Browser)" -ForegroundColor Green
  Write-Host ("user-agent: " + $ver.'User-Agent')
} catch {
  Write-Host "CDP not ready: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
