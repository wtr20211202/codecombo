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
# -# = progress bar (the binary is ~50MB; silent mode looks like a hang),
# --connect-timeout/--max-time guard against a truly dead connection.
# $ProgressPreference silent: PS 5.1 Invoke-WebRequest's progress bar slows
# downloads ~10x in the fallback path.
$ProgressPreference = 'SilentlyContinue'
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString()))
$curlExe = "$env:SystemRoot\System32\curl.exe"
$useCurl = Test-Path $curlExe
Write-Host "==> Downloading ~50 MB from GitHub Releases (progress below; slow networks may take a few minutes)"
try {
  if ($useCurl) {
    & $curlExe -# -fSL --retry 3 --connect-timeout 30 --max-time 1800 -o "$tmp/codecombo.exe" "$Base/$Asset"
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

  # ---------- install ----------
  New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
  $Bin = Join-Path $Prefix 'codecombo.exe'
  Move-Item -Force "$tmp/codecombo.exe" $Bin
  Write-Host "==> Installed: $Bin"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# ---------- service (elevated only) ----------
# Admin detection hardened: ::Current can return null in restricted contexts
# and this script may be executed line-by-line (irm | iex array semantics on
# PS 5.1) - any null/exception degrades to the non-admin branch (foreground
# instructions) instead of crashing after a successful install.
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
$svcExists = (sc.exe query Codecombo 2>$null | Select-String 'STATE') -ne $null
if ($isAdmin) {
  $svcBin = "`"$Bin`" --serve --port=$Port --host $BindHost"
  if ($svcExists) {
    Write-Host '==> Service exists - updating binPath + data-dir pin, then restarting'
    sc.exe stop Codecombo | Out-Null
    sc.exe config Codecombo binPath= $svcBin start= auto | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "    sc config failed (exit $LASTEXITCODE)" }
  } else {
    Write-Host "==> Registering Windows service Codecombo (port $Port, host $BindHost, auto-restart on failure)"
    sc.exe create Codecombo binPath= $svcBin start= auto DisplayName= 'Codecombo dev workbench' | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Host "    sc create failed (exit $LASTEXITCODE)" }
    sc.exe failure Codecombo reset= 86400 actions= restart/5000 | Out-Null
  }
  # 服务以 LocalSystem 跑（其 HOME 指向系统 profile）——钉 CC_DATA_DIR 到
  # 安装者用户的数据目录，保证「服务跑的数据 = 交互运行的数据」同份可复用。
  # Environment 值规范为 REG_MULTI_SZ
  New-Item -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\Codecombo' -Name Environment -Force | Out-Null
  New-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Services\Codecombo\Environment' -Name CC_DATA_DIR -Value "CC_DATA_DIR=$DataDir" -PropertyType MultiString -Force | Out-Null
  sc.exe start Codecombo 2>&1 | Select-String -Pattern '.' | ForEach-Object { Write-Host "    $_" }
  # 轮询确认 RUNNING（start 报成功≠真的起来了）
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
    Write-Host "    & '$Bin' start                    # foreground run shows the real error"
    Write-Host '    Get-EventLog -LogName Application -Newest 10 -Source Codecombo'
  }
} else {
  Write-Host '==> Not elevated: skipped service registration. Run in foreground:'
  Write-Host "     $Bin start"
  Write-Host '  (re-run in an elevated PowerShell to register the Windows service)'
}
Write-Host "==> Open http://localhost:$Port (set your lock password on first start)"
Write-Host '==> Updates: in-app "check update" (GitHub releases, automatic rollback)'
