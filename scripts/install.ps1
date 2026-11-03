# install.ps1 —— Codecombo 一键安装（Windows）。
#
# 一键形态（管理员或普通 PowerShell 均可，可整条丢给 AI 助手代跑）：
#   irm https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.ps1 | iex
#
# 行为：探测架构 → 版本决策（正式版优先，无则最新 rc，再无最新 beta）→
# 从 GitHub Releases 下载对应二进制 →
# SHA256 校验 → 装入用户级目录 → 有管理员权限时注册 Windows 服务
# （sc.exe + 失败自动重启），否则给出前台启动说明。
# 安装方式决定更新方式：本脚本/手动二进制安装 → 应用内自更新（GitHub 源，
# 失败自动回滚）；npm 安装 → npm 更新（应用内自动让位）。
#
# 环境变量：CODECOMBO_PREFIX（默认 $env:USERPROFILE\.codecombo\bin）、
#           CODECOMBO_PORT（默认 9999）
#
# 版本决策（全自动，无参数）：有正式版装最新正式版；当前没有正式版时装
# 最新的 rc；没有 rc 才装最新的 beta。GitHub 侧栏同理只认正式版。
$ErrorActionPreference = 'Stop'

$Repo = 'wtr20211202/codecombo'
$Port = if ($env:CODECOMBO_PORT) { $env:CODECOMBO_PORT } else { '9999' }
$Prefix = if ($env:CODECOMBO_PREFIX) { $env:CODECOMBO_PREFIX } else { "$env:USERPROFILE\.codecombo\bin" }

# ---------- 版本决策：stable > 最新 rc > 最新 beta（列表按创建时间倒序） ----------
$releases = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases?per_page=30"
$stable = $rc = $beta = $null
foreach ($r in $releases) {
  if ($r.draft) { continue }
  if (-not $r.prerelease -and -not $stable) { $stable = $r }
  if ($r.prerelease -and $r.tag_name -match 'rc' -and -not $rc) { $rc = $r }
  if ($r.prerelease -and $r.tag_name -match 'beta' -and -not $beta) { $beta = $r }
}
$chosen = if ($stable) { $stable } elseif ($rc) { $rc } elseif ($beta) { $beta } else { $null }
if (-not $chosen) { throw '仓库中没有任何可用 release（stable/rc/beta 均无）' }
$kind = if ($stable) { '最新正式版' } elseif ($rc) { '最新 rc——尚无正式版' } else { '最新 beta——尚无正式版与 rc' }
Write-Host "==> 版本：$($chosen.tag_name)（$kind）"
$Base = "https://github.com/$Repo/releases/download/$($chosen.tag_name)"

# ---------- 架构探测 ----------
switch ($env:PROCESSOR_ARCHITECTURE) {
  'AMD64' { $Arch = 'amd64' }
  'ARM64' { $Arch = 'arm64' }
  default { Write-Error "不支持的架构：$env:PROCESSOR_ARCHITECTURE（amd64/arm64）" }
}
$Asset = "codecombo-windows-$Arch.exe"
Write-Host "==> 平台：windows/$Arch -> $Asset"

# ---------- 下载 + SHA256 校验 ----------
$tmp = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ([guid]::NewGuid().ToString()))
try {
  Invoke-WebRequest "$Base/$Asset" -OutFile "$tmp/codecombo.exe"
  Invoke-WebRequest "$Base/SHA256SUMS.txt" -OutFile "$tmp/SHA256SUMS.txt"
  $expect = (Select-String -Path "$tmp/SHA256SUMS.txt" -Pattern ('\s' + [regex]::Escape($Asset) + '$')).Line -split '\s+' | Select-Object -First 1
  if (-not $expect) { throw "校验和清单中未找到 $Asset" }
  $actual = (Get-FileHash "$tmp/codecombo.exe" -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expect) { throw "SHA256 不匹配！期望 $expect 实际 $actual" }
  Write-Host '==> SHA256 校验通过'

  # ---------- 安装 ----------
  New-Item -ItemType Directory -Force -Path $Prefix | Out-Null
  $Bin = Join-Path $Prefix 'codecombo.exe'
  Move-Item -Force "$tmp/codecombo.exe" $Bin
  Write-Host "==> 已安装：$Bin"
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}

# ---------- 服务化（管理员才有权限写服务库） ----------
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::Current()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  Write-Host "==> 注册 Windows 服务 Codecombo（端口 $Port，失败自动重启）"
  sc.exe create Codecombo binPath= "`"$Bin`" --serve --port=$Port --host 127.0.0.1" start= auto DisplayName= 'Codecombo dev workbench' | Out-Null
  sc.exe failure Codecombo reset= 86400 actions= restart/5000 | Out-Null
  sc.exe start Codecombo | Out-Null
  Write-Host '==> 服务已启动：sc query Codecombo'
} else {
  Write-Host '==> 非管理员：跳过服务注册。前台启动：'
  Write-Host "     $Bin start"
  Write-Host '  （管理员 PowerShell 重跑本脚本可注册 Windows 服务）'
}
Write-Host "==> 访问 http://localhost:$Port（首启设置锁密码）"
Write-Host '==> 更新方式：应用内「检查更新」（GitHub 源，失败自动回滚）'
