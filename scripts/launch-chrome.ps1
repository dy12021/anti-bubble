# Launch a dedicated Chrome instance with the extension loaded (CDP port 9333).
# Uses an isolated user-data-dir so the user's daily browser is untouched.
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads BOM-less .ps1 files as
# ANSI (cp936), which corrupts non-ASCII comments and breaks parsing.
param(
  [string]$ProfileDir = "$env:TEMP\anti-bubble-chrome-profile"
)

$ErrorActionPreference = 'Stop'

# Repo root is derived from this script's own location, so the script works
# no matter where the repo is cloned or which drive letter it lives on.
$repoRoot = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $repoRoot 'dist'

if (-not (Test-Path $dist)) {
  Write-Host "dist missing - run npm run build first" -ForegroundColor Red
  exit 1
}

# Chrome executable is resolved from environment variables (never a hard
# coded drive letter), trying every known install location in turn.
$baseDirs = @()
foreach ($v in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if ($v) { $baseDirs += $v }
}
$candidates = @()
foreach ($base in $baseDirs) {
  $candidates += (Join-Path $base 'Google\Chrome\Application\chrome.exe')
}
$chrome = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) {
  Write-Host "chrome not found - looked in:" -ForegroundColor Red
  foreach ($c in $candidates) { Write-Host "  $c" }
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
