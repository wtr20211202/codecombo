# install.ps1 - Codecombo one-line installer (Windows).
#
# One-line form (paste this to your AI assistant or run directly):
#   irm https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.ps1 | iex
#
# Behavior: detect architecture -> pick version (latest stable; newest rc;
# newest beta when no rc/stable) -> download from GitHub Releases -> verify
# SHA256 -> install to a user-level directory -> register a Windows service
# when elevated. The installer NEVER touches the data directory
# (~/.codecombo) - data is owned by the app itself (created on first start,
# untouched by upgrades, reused as-is).
#
# Install method decides update method: binary installs (this script or a
# manual download) update in-app from GitHub releases with automatic rollback;
# npm installs update through npm (the in-app updater steps aside).
#
# Env vars: CODECOMBO_PREFIX (default $env:LOCALAPPDATA\Programs\codecombo),
#           CODECOMBO_PORT (default 9999),
#           CODECOMBO_HOST (default 127.0.0.1; 0.0.0.0 = LAN reachable)
#
# NOTE: keep this file ASCII-only, no BOM. It is consumed via `irm | iex`,
# where Windows PowerShell 5.1 decodes the payload with console encoding and
# splits it for execution - non-ASCII comments/output break parsing there
# (real incident: Chinese comments + BOM caused CommandNotFound at line 1).
$ErrorActionPreference = 'Stop'

$Repo = 'wtr20211202/codecombo'
$Port = if ($env:CODECOMBO_PORT) { $env:CODECOMBO_PORT } else { '9999' }
$BindHost = if ($env:CODECOMBO_HOST) { $env:CODECOMBO_HOST } else { '127.0.0.1' }
$Prefix = if ($env:CODECOMBO_PREFIX) { $env:CODECOMBO_PREFIX } else { "$env:LOCALAPPDATA\Programs\codecombo" }
$DataDir = "$env:USERPROFILE\.codecombo"

# ---------- version pick: latest stable > newest rc > newest beta ----------
$releases = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=30"
$stable = $rc = $beta = $null
foreach ($r in $releases) {
  if ($r.draft) { continue }
  if (-not $r.prerelease -and -not $stable) { $stable = $r }
  if ($r.prerelease -and $r.tag_name -match 'rc' -and -not $rc) { $rc = $r }
  if ($r.prerelease -and $r.tag_name -match 'beta' -and -not $beta) { $beta = $r }
}
$chosen = if ($stable) { $stable } elseif ($rc) { $rc } elseif ($beta) { $beta } else { $null }
if (-not $chosen) { throw 'No usable release found (no stable/rc/beta tag)' }
$kind = if ($stable) { 'latest stable' } elseif ($rc) { 'newest rc (no stable yet)' } else { 'newest beta (no stable/rc yet)' }
Write-Host "==> Version: $($chosen.tag_name) ($kind)"
$Base = "https://github.com/$Repo/releases/download/$($chosen.tag_name)"

# ---------- architecture ----------
switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { $Arch = 'amd64' }
  'ARM64' { $Arch = 'arm64' }
  default { Write-Error "Unsupported architecture: $env:PROCESSOR_ARCHITECTURE (amd64/arm64 only)" }
}
$Asset = "codecombo-windows-$Arch.exe"
Write-Host "==> Platform: windows/$Arch -> $Asset"

# ---------- download + SHA256 verify ----------
# curl.exe first (bundled with Windows 10 1803+): verified-reliable binary
# downloads. Invoke-WebRequest on PS 5.1 has produced corrupted/corrupted-hash
# large downloads in the field (real incident: SHA256 mismatch on a 50MB
# binary while curl fetched the same URL clean) - kept only as fallback.
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString()))
$curlExe = "$env:SystemRoot\System32\curl.exe"
$useCurl = Test-Path $curlExe
try {
  if ($useCurl) {
    & $curlExe -fsSL -o "$tmp/codecombo.exe" "$Base/$Asset"
    & $curlExe -fsSL -o "$tmp/SHA256SUMS.txt" "$Base/SHA256SUMS.txt"
  } else {
    Invoke-WebRequest "$Base/$Asset" -OutFile "$tmp/codecombo.exe"
    Invoke-WebRequest "$Base/SHA256SUMS.txt" -OutFile "$tmp/SHA256SUMS.txt"
  }
  $expect = (Select-String -Path "$tmp/SHA256SUMS.txt" -Pattern ('\s' + [regex]::Escape($Asset) + '$')).Line -split '\s+' | Select-Object -First 1
  if (-not $expect) { throw "Checksum list has no entry for $Asset" }
  $actual = (Get-FileHash "$tmp/codecombo.exe" -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expect) { throw "SHA256 mismatch! expected $expect got $actual" }
  Write-Host '==> SHA256 verified'

  # ---------- install ----------
  New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
  $Bin = Join-Path $Prefix 'codecombo.exe'
  Move-Item -Force "$tmp/codecombo.exe" $Bin
  Write-Host "==> Installed: $Bin"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# ---------- service (elevated only) ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::Current).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$svcExists = (sc.exe query Codecombo 2>$null | Select-String 'STATE') -ne $null
if ($isAdmin) {
  if ($svcExists) {
    Write-Host '==> Service Codecombo already registered - updating binary only (data dir untouched)'
    sc.exe stop Codecombo | Out-Null
    sc.exe start Codecombo | Out-Null
    Write-Host '==> Service restarted: sc query Codecombo'
  } else {
    Write-Host "==> Registering Windows service Codecombo (port $Port, auto-restart on failure)"
    sc.exe create Codecombo binPath= "`"$Bin`" --serve --port=$Port --host $BindHost" start= auto DisplayName= 'Codecombo dev workbench' | Out-Null
    sc.exe failure Codecombo reset= 86400 actions= restart/5000 | Out-Null
    sc.exe start Codecombo | Out-Null
    Write-Host '==> Service started: sc query Codecombo'
  }
} else {
  Write-Host '==> Not elevated: skipped service registration. Run in foreground:'
  Write-Host "     $Bin start"
  Write-Host '  (re-run in an elevated PowerShell to register the Windows service)'
}
Write-Host "==> Open http://localhost:$Port (set your lock password on first start)"
Write-Host '==> Updates: in-app "check update" (GitHub releases, automatic rollback)'
