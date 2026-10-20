# Launch a dedicated browser instance with the extension loaded, for live verification.
# Works with both Chrome and Edge (Chromium-based, same CDP surface).
#
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less .ps1 files as
# ANSI (cp936), which corrupts non-ASCII comments and breaks parsing.
#
# Usage:
#   .\launch-browser.ps1 -Browser chrome
#   .\launch-browser.ps1 -Browser edge
param(
  [ValidateSet('chrome', 'edge')]
  [string]$Browser = 'chrome',
  [int]$Port = 9333,
  [string]$ProfileDir = ''
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
  $ProfileDir = "$env:TEMP\anti-bubble-$Browser-profile"
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
  "https://www.bilibili.com/"
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
