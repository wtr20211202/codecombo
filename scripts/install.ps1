# install.ps1 - Codecombo one-line installer (Windows).
#
# One-line form (paste this to your AI assistant or run directly):
#   irm https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.ps1 | iex
#
# Behavior: detect architecture -> pick version (latest stable; newest rc;
# newest beta when no rc/stable) -> download from GitHub Releases -> verify
# SHA256 -> stop the registered Windows service when it runs the binary being
# replaced (a running exe is file-locked and cannot be overwritten) ->
# install to a user-level directory -> register a Windows service
# when elevated. The installer NEVER touches the data directory
# (~/.codecombo) - data is owned by the app itself (created on first start,
# untouched by upgrades, reused as-is).
#
# Install method decides update method: binary installs (this script or a
# manual download) update in-app from GitHub releases with automatic rollback;
# npm installs update through npm (the in-app updater steps aside).
# Re-run = upgrade; data dir untouched.
#
# Env vars: CODECOMBO_PREFIX (default $env:LOCALAPPDATA\Programs\codecombo),
#           CODECOMBO_PORT (default 9999),
#           CODECOMBO_HOST (default 127.0.0.1; 0.0.0.0 = LAN reachable),
#           CODECOMBO_DATA_DIR (default ~/.codecombo; only handed on - as
#           --data-dir in the service command line / printed manual-start
#           command - the installer still never creates or writes it)
# Set them before the one-liner ($env: values stay set for the rest of that
# PowerShell session), e.g.
#   $env:CODECOMBO_PORT='11000'; $env:CODECOMBO_DATA_DIR="$HOME\.codecombo-test"; iex ((New-Object System.Net.WebClient).DownloadString('https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.ps1'))
#
# Side-by-side instances: the service name is fixed (Codecombo) - one
# installer-managed service per machine. With that service already present,
# an elevated run with other settings re-points it (takes the existing
# instance over) instead of adding one; run the second instance from a
# non-elevated session instead (binary only + a manual start command that
# carries these settings; `start` runs the app as a background daemon),
# with its own CODECOMBO_PREFIX.
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
# CODECOMBO_DATA_DIR override (unset = the default above, unchanged). Resolved
# to an absolute path against the current PowerShell location: the service
# runs as LocalSystem with System32 as its working directory, so a relative
# path would land there. Trailing separators are trimmed - a trailing
# backslash would escape the closing quote of --data-dir "..." in the service
# command line. Only the path is handed on; the installer never creates it.
if ($env:CODECOMBO_DATA_DIR) {
  $DataDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($env:CODECOMBO_DATA_DIR).TrimEnd('\', '/')
  if ($DataDir -match '^[A-Za-z]:$') { throw "CODECOMBO_DATA_DIR cannot be a drive root: $env:CODECOMBO_DATA_DIR" }
}

# ---------- root/builtin-admin guard (same semantics as the remote deployer's
# non-root useradd): running the workbench as root/SYSTEM is a security
# anti-pattern - the lock password protects nothing against the account itself,
# and data under /root or the SYSTEM profile is unreachable by normal users.
# Regular *named* administrator accounts are fine (they are real user
# profiles); only root (Unix) and the built-in Administrator/SYSTEM (Windows,
# no real profile semantics for workbench data) are rejected.
if ($env:USERNAME -in @('root', 'SYSTEM', 'Administrator') -and $env:USERPROFILE -like '*\Windows\*') {
  Write-Error @"
Do not run this installer under a system/built-in account (found USERPROFILE=$env:USERPROFILE).
Create a normal user account and run the installer from that user's session.
"@
}

# ---------- preflight: admin + existing service state (before any download) ----------
# Admin detection hardened: ::Current can return null in restricted contexts
# and this script may be executed line-by-line (irm | iex array semantics on
# PS 5.1) - any null/exception degrades to the non-admin branch (manual-start
# instructions) instead of crashing after a successful install. Probed up
# front so a locked running service fails fast with an actionable message
# instead of after a ~50 MB download.
$isAdmin = $false
try {
  $wid = [Security.Principal.WindowsIdentity]::Current
  if ($null -ne $wid) {
    $isAdmin = ([Security.Principal.WindowsPrincipal]$wid).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
} catch { $isAdmin = $false }
if (-not $isAdmin) {
  # fallback probe: `net session` succeeds only for elevated tokens
  try {
    $null = net session 2>$null
    if ($LASTEXITCODE -eq 0) { $isAdmin = $true }
  } catch { }
}
$Bin = Join-Path $Prefix 'codecombo.exe'
$svcExists = (sc.exe query Codecombo 2>$null | Select-String 'STATE') -ne $null
$svcRunning = $false
if ($svcExists) {
  $svcRunning = (sc.exe query Codecombo 2>$null | Select-String 'RUNNING') -ne $null
}
# Does the registered service actually run the binary this installer is about
# to replace? Conservative default ($true) when the query cannot be parsed:
# stopping a service that points elsewhere is harmless (the service section
# starts it again), while missing the stop would fail the file replace below
# (Windows locks the exe image of a running process).
$svcRunsOurBin = $true
try {
  $qcLine = (sc.exe qc Codecombo 2>$null | Select-String 'BINARY_PATH_NAME')
  if ($qcLine) {
    $svcBinPath = (($qcLine.Line -split ':', 2)[1]).Trim()
    if ($svcBinPath -and ($svcBinPath -notlike "*$Bin*")) { $svcRunsOurBin = $false }
  }
} catch { }
# Set by the stop-before-replace step; read by the replace-failure rollback.
$svcStoppedHere = $false
if ($svcExists -and $svcRunning -and $svcRunsOurBin -and -not $isAdmin) {
  throw @"
Windows service Codecombo is running the binary this installer replaces ($Bin).
The running exe is file-locked and stopping the service needs elevation.
Re-run from an elevated PowerShell, or stop the service first: sc.exe stop Codecombo
"@
}

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
if ($env:CODECOMBO_DATA_DIR) {
  Write-Host "==> Data directory: $DataDir (CODECOMBO_DATA_DIR; created by the app on first start, never written by the installer)"
}

# ---------- download + SHA256 verify ----------
# curl.exe first (bundled with Windows 10 1803+): verified-reliable binary
# downloads. Invoke-WebRequest on PS 5.1 has produced corrupted/corrupted-hash
# large downloads in the field (real incident: SHA256 mismatch on a 50MB
# binary while curl fetched the same URL clean) - kept only as fallback.
# -# = progress bar (the binary is ~50MB; silent mode looks like a hang),
# --connect-timeout/--max-time guard against a truly dead connection.
# -C - = resume (GitHub Releases serves Range requests): when a resume is
# possible curl asks for the bytes it already has instead of restarting the
# ~50MB download from zero. Verified behavior split by curl version: current
# curls resume a --retry reconnect via Range (upstream fixed retry
# auto-resume 2025-10; the bundled curl.exe 8.21.0 verified resuming here),
# older builds (e.g. 8.5.0) still restart a retried transfer from zero -
# harmless, the output is rewritten and the SHA256 check below gates the
# result. Hard mid-transfer drops (curl error 18) are not retried by any
# tested version: the script exits with the re-run hint below. The temp dir
# is a fresh GUID per run, so a stale file from an older version can never
# be resumed-into. SHA256SUMS.txt (a few hundred bytes) stays without -C -
# (retrying it whole is free). The Invoke-WebRequest fallback below cannot
# resume and stays a full download; SHA256 remains its integrity gate.
# $ProgressPreference silent: PS 5.1 Invoke-WebRequest's progress bar slows
# downloads ~10x in the fallback path.
$ProgressPreference = 'SilentlyContinue'
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString()))
$curlExe = "$env:SystemRoot\System32\curl.exe"
$useCurl = Test-Path $curlExe
Write-Host "==> Downloading ~50 MB from GitHub Releases (progress below; slow networks may take a few minutes)"
try {
  if ($useCurl) {
    & $curlExe -# -fSL -C - --retry 3 --connect-timeout 30 --max-time 1800 -o "$tmp/codecombo.exe" "$Base/$Asset"
    if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE): $Asset - check network and re-run" }
    & $curlExe -fsSL --retry 3 --connect-timeout 30 -o "$tmp/SHA256SUMS.txt" "$Base/SHA256SUMS.txt"
    if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE): SHA256SUMS.txt - check network and re-run" }
  } else {
    Invoke-WebRequest "$Base/$Asset" -OutFile "$tmp/codecombo.exe"
    Invoke-WebRequest "$Base/SHA256SUMS.txt" -OutFile "$tmp/SHA256SUMS.txt"
  }
  $expect = (Select-String -Path "$tmp/SHA256SUMS.txt" -Pattern ('\s' + [regex]::Escape($Asset) + '$')).Line -split '\s+' | Select-Object -First 1
  if (-not $expect) { throw "Checksum list has no entry for $Asset" }
  $actual = (Get-FileHash "$tmp/codecombo.exe" -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expect) { throw "SHA256 mismatch! expected $expect got $actual" }
  Write-Host '==> SHA256 verified'

  # ---------- stop service before binary replace ----------
  # A running process's exe image is file-locked on Windows: Move-Item -Force
  # over the service's running binary always fails with a sharing violation
  # (P-20261109-4: the old order replaced the binary first and stopped the
  # service only afterwards, so re-running the installer with the service up
  # could never succeed). The stop lands here - after download+SHA256, so
  # service downtime never overlaps a failed download - and only when the
  # registered binPath points at the binary being replaced. The stop is
  # issued even when the probe said stopped (it may have started since; a
  # stop on a stopped service is a harmless no-op). sc.exe stop returns at
  # once (STOP_PENDING); the exe file handle is released only when the
  # process actually exits (the app's SCM stop path allows a 10s grace,
  # hence the 20s poll ceiling).
  if ($isAdmin -and $svcExists -and $svcRunsOurBin) {
    $wasRunning = (sc.exe query Codecombo 2>$null | Select-String 'RUNNING') -ne $null
    if ($wasRunning) { Write-Host '==> Stopping running service Codecombo before binary replace' }
    sc.exe stop Codecombo | Out-Null
    $stopped = $false
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      if ((sc.exe query Codecombo | Select-String 'STOPPED') -ne $null) { $stopped = $true; break }
    }
    if (-not $stopped) {
      throw "Service Codecombo did not reach STOPPED within 20s - stop it manually (sc.exe stop Codecombo) and re-run this installer"
    }
    # Flag only a stop this run actually performed (was running): the
    # replace-failure rollback then restarts exactly what it stopped instead
    # of starting a service the user had deliberately stopped.
    $svcStoppedHere = $wasRunning
  }

  # ---------- install ----------
  New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
  try {
    Move-Item -Force "$tmp/codecombo.exe" $Bin
  } catch {
    # Replace-failure rollback (mirrors the in-app updater semantics in
    # server/update/do_update.go: restore prior state before failing).
    # Move-Item -Force failing leaves the old binary intact, but this run may
    # have stopped the service for the replace - bring it back up on the old
    # binary first (a manually started exe - daemon or foreground --serve -
    # can hold the lock even though the service is down), then surface a
    # clear error.
    if ($svcStoppedHere) {
      Write-Host '==> Binary replace failed - restarting service Codecombo on the old binary'
      sc.exe start Codecombo | Out-Null
    }
    throw "could not replace $Bin (locked by a running process?): $($_.Exception.Message)"
  }
  Write-Host "==> Installed: $Bin"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# ---------- service (elevated only) ----------
# Admin detection and the existing-service probe ran in the preflight above
# (before any download): a running service is stopped before the binary
# replace, and a non-elevated re-run against a running service fails fast.
if ($isAdmin) {
  # Data dir goes straight into the service command line (--data-dir flag,
  # native in main.go): the service runs as LocalSystem (its HOME is the
  # system profile), so without it the data would land in
  # systemprofile\.codecombo, split from interactive runs (real incident).
  # binPath is visible at a glance and does not depend on SCM registry
  # Environment injection (which had compatibility quirks and once did not
  # take effect). Comments here MUST stay ASCII: with non-ASCII text, a
  # BOM-less file decoded as ANSI (PS 5.1 reading it from disk, e.g. on a
  # zh-CN system) swallowed the next line - this very assignment - into the
  # comment with zero parse errors.
  $svcBin = "`"$Bin`" --serve --data-dir `"$DataDir`" --port=$Port --host $BindHost"
  if ($svcExists) {
    Write-Host '==> Service exists - updating binPath (incl. --data-dir pin), then restarting'
    sc.exe stop Codecombo | Out-Null
    sc.exe config Codecombo binPath= $svcBin start= auto | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "    sc config failed (exit $LASTEXITCODE)" }
    # Re-apply failure recovery (legacy services registered before the
    # failure-actions line lack it; the in-app restart chain relies on it:
    # graceful exit with code 1 -> SCM restarts in 5s)
    sc.exe failure Codecombo reset= 86400 actions= restart/5000 | Out-Null
  } else {
    Write-Host "==> Registering Windows service Codecombo (port $Port, host $BindHost, auto-restart on failure)"
    sc.exe create Codecombo binPath= $svcBin start= auto DisplayName= 'Codecombo dev workbench' | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "    sc create failed (exit $LASTEXITCODE)" }
    sc.exe failure Codecombo reset= 86400 actions= restart/5000 | Out-Null
  }
  sc.exe start Codecombo 2>&1 | Select-String -Pattern '.' | ForEach-Object { Write-Host "    $_" }
  # Poll until RUNNING (a successful "start" reply does not mean it came up)
  $running = $false
  for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 400
    $q = (sc.exe query Codecombo | Select-String 'RUNNING') -ne $null
    if ($q) { $running = $true; break }
    if ((sc.exe query Codecombo | Select-String 'STOPPED') -ne $null) { break }
  }
  if ($running) {
    Write-Host '==> Service RUNNING (auto-start on boot, auto-restart on failure)'
  } else {
    Write-Host '==> Service NOT running - diagnose:'
    Write-Host '    sc query Codecombo                # state'
    # --serve = true foreground (full output in this console; Ctrl+C stops it).
    # `start` would daemonize and DISCARD output (the daemon's stdout/stderr
    # go to the log files), so it shows no real error. Same flags as the
    # service binPath above to reproduce the service's environment.
    Write-Host "    & '$Bin' --serve --data-dir `"$DataDir`" --port=$Port --host $BindHost"
    Write-Host '    (foreground run shows the real error; Ctrl+C stops it)'
    Write-Host '    Get-EventLog -LogName Application -Newest 10 -Source Codecombo'
  }
} else {
  # Carry only explicitly set options (none set = the exact command as
  # before): a side-by-side instance started from here must not fall back to
  # the default port / data dir of the existing one
  $fgArgs = ''
  if ($env:CODECOMBO_PORT) { $fgArgs += " --port $Port" }
  if ($env:CODECOMBO_HOST) { $fgArgs += " --host $BindHost" }
  if ($env:CODECOMBO_DATA_DIR) { $fgArgs += " --data-dir `"$DataDir`"" }
  Write-Host '==> Not elevated: skipped service registration. Start it manually (background daemon, survives terminal close):'
  Write-Host "     $Bin start$fgArgs"
  Write-Host '  (re-run in an elevated PowerShell to register the Windows service)'
}
Write-Host "==> Open http://localhost:$Port (set your lock password on first start)"
Write-Host '==> Updates: in-app "check update" (GitHub releases, automatic rollback)'
