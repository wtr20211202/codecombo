#!/bin/bash
# install.ps1 Windows 加固门禁（P-20261113-3-S3）：ASCII-only 断言 + 无 BOM +
# 末行哨兵（与 install.sh 同串对账）+ PowerShell Parser::ParseFile 语法校验。
#
# 动机（docs/release-runbook.md #22 实锚）：PS 5.1 读盘按 ANSI 解码（zh-CN 为
# CP936）——无 BOM 文件里的非 ASCII 注释会吞掉换行、下一行代码并入注释，
# 「ParseFile 零语法错误」掩盖语义丢失（实锚事故：if ($isAdmin) 块里的
# $svcBin --data-dir 赋值整行消失，服务 binPath 为空）。全文件 ASCII-only 后
# ANSI 与 UTF-8 解码逐字节一致，是根治面；本门禁把 runbook 的人工固化步骤
# （grep -P '[^\x00-\x7F]' 须零命中）落为 wsl-verify quick 首步族自动闸，
# 与 check-install-sh.sh 同款挂法。哨兵：install.ps1 末行
# # __CODECOMBO_INSTALL_SENTINEL__ 与 install.sh 同串——入口自检（-File 执行
# 时 $PSCommandPath 回读末 5 行）拦截传输截断/代理改写的不完整下载、字符串
# 形态（iex/管道）提示即拒绝；两脚本末行哨兵由本门禁对账，防单侧漂移。
#
# 四段检查：
#   1. ASCII 扫描   全文件逐行断言可打印 ASCII + 空白。无注释豁免——注释正是
#                   runbook #22 的事故面；\t/\r 属 [:space:] 不报（CRLF 合法，
#                   PS 5.1/7 均可解析）
#   2. BOM 检查     头 3 字节 EF BB BF 即红（PS 5.1 对 BOM 另有 CommandNotFound
#                   前科；BOM 字节本身非 ASCII，段 1 也会红，此处给出专指报错）
#   3. 哨兵末行     install.ps1 与 install.sh 末行均为
#                   # __CODECOMBO_INSTALL_SENTINEL__（同串统一；install.ps1
#                   运行时 tail 5 窗口的锚，门禁按更严的「恰为末行」断言）
#   4. ParseFile    PowerShell 宿主可用时 Parser::ParseFile 须 0 error（循
#                   既有 PSParser 门禁先例）；找不到宿主显式 SKIP（段 1-3 不
#                   受影响——ASCII/哨兵是确定性内容闸，语法面由本机 Windows
#                   门禁与发版流程兜底）
#
# 已知边界（如实声明，非静默漏）：
#   - ASCII 口径用 LC_ALL=C awk 字节类 [^[:print:][:space:]]（同
#     check-install-sh.sh 的三平台可跑取舍：POSIX ERE 无 \xNN，macOS 自带 BSD
#     grep 无 -P）。与 [^\x00-\x7F] 的差集 = ASCII 控制字符（\x01-\x08\x0B
#     \x0C\x0E-\x1F\x7F）——比 runbook 口径更严：原始控制字符在 .ps1 里同样
#     不该有（方向是抓得更严不是漏抓）
#   - ParseFile 段依赖 PowerShell 宿主：Windows Git Bash 有 powershell.exe、
#     WSL 经 interop 通常可达；两者皆缺时输出 SKIP 行不判红（诚实可见，非静默）。
#     WSL interop 宿主只认 Windows 路径（wslpath -w 转换）；被解析文件必须
#     在 Windows 可读文件系统上（drvfs 的 /mnt/d → D:\ 即可）——WSL 专属
#     ext4（/tmp）对 interop 宿主的 \\wsl.localhost UNC 部分环境不可达，
#     gate_parse 以 Test-Path 护栏 fail-closed，自证夹具因此镜像进宿主自己的
#     $env:TEMP（fixture_dir）
#   - 哨兵对账锚在「末行恰为哨兵」：install.sh/install.ps1 任一侧在哨兵后
#     追加内容即红——这是有意 fail-visible（运行时 tail 5 窗口本可容忍追加，
#     门禁收紧逼改动者显式决策）
#
# 用法：
#   bash scripts/check-install-ps.sh [repo-dir]     # 默认脚本所在仓库根
#   bash scripts/check-install-ps.sh --self-test    # 夹具红绿自证（临时目录不碰仓库）
# 退出码：0 全绿；1 门禁违例；2 用法/自证失败/目标缺失。
# 平台：纯 bash + POSIX 工具（awk/od/tail/mktemp），Git Bash / WSL 双跑通用。
set -u

fail_usage() { echo "check-install-ps: $1" >&2; exit 2; }

SENTINEL_LINE='# __CODECOMBO_INSTALL_SENTINEL__'

# 全程字节级匹配：ParseFile 报错文本经 interop 宿主以系统码页（zh-CN 为 GBK）
# 出流，是非法 UTF-8——UTF-8 locale 下 GNU grep 会把这种输入按 binary 处理，
# '^PARSE_ERR' 匹配行被 "binary file matches" 吞掉（WSL grep 3.11 实测）。
# 本脚本所有判定都是 ASCII 前缀/字节类，LC_ALL=C 下任何字节序列皆合法输入，
# 中文报错文本照常透传显示；gate_ascii 处的显式 LC_ALL=C 为同口径冗余。
export LC_ALL=C

# gate_ascii <文件>：非可打印非空白字节所在行打到 stdout，行前缀 ASCII_VIOL。
# 无注释豁免（PS 5.1 连注释一起按 ANSI 解码，注释正是事故面）。
gate_ascii() {
  LC_ALL=C awk '
    $0 ~ /[^[:print:][:space:]]/ {
      printf "ASCII_VIOL %s:%d: %s\n", FILENAME, FNR, $0
    }
  ' "$1"
}

# gate_bom <文件>：头 3 字节为 EF BB BF 时输出 BOM_VIOL 行。
gate_bom() {
  magic="$(head -c 3 "$1" | od -An -tx1 | tr -d ' \n')"
  if [ "$magic" = "efbbbf" ]; then
    printf 'BOM_VIOL %s: file starts with a UTF-8 BOM (PS 5.1 chokes on it)\n' "$1"
  fi
}

# gate_sentinel <文件>：末行（去 \r 后）恰为哨兵注释时返回 0，否则 1。
gate_sentinel() {
  [ "$(tail -n 1 "$1" | tr -d '\r')" = "$SENTINEL_LINE" ]
}

# ps_path_for_host <宿主> <bash 侧路径>：按宿主类型把路径转成它能解析的形态。
# Windows 侧（Git Bash 或 WSL interop 的 powershell.exe）：cygpath -w /
# wslpath -w（/tmp/xxx → C:\...，Windows 二进制只认 Windows 路径）；
# Linux 原生 pwsh：路径原样（pwsh 原生解析 POSIX 路径，转换反而破坏它）；
# 其余环境原样返回。
ps_path_for_host() {
  if [ "$(uname -s)" = "Linux" ]; then
    if [ "$1" = "pwsh" ]; then
      printf '%s\n' "$2"
    elif command -v wslpath >/dev/null 2>&1; then
      wslpath -w "$2"
    else
      printf '%s\n' "$2"
    fi
  elif command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$2"
  else
    printf '%s\n' "$2"
  fi
}

# find_ps_host：优先 pwsh（三平台同语义），退 powershell.exe/powershell
# （Windows 自带 / WSL interop）。找不到返回 1。
find_ps_host() {
  if command -v pwsh >/dev/null 2>&1; then { echo "pwsh"; return 0; }; fi
  if command -v powershell.exe >/dev/null 2>&1; then { echo "powershell.exe"; return 0; }; fi
  if command -v powershell >/dev/null 2>&1; then { echo "powershell"; return 0; }; fi
  return 1
}

# gate_parse <宿主> <bash 侧路径>：Parser::ParseFile 0 error 返回 0，报错行以
# PARSE_ERR 前缀打到 stdout。fail-closed 三护栏：Test-Path 先验目标可读
# （WSL /tmp 夹具对 interop 宿主的 \\wsl.localhost UNC 不可达时显式红，绝不
# 静默算 0 error）、ParseFile 包 try/catch（IO 异常也报 PARSE_ERR，防
# $e 保持 $null 被 .Count 判 0 的 fail-open）、输出剥 \0\r（interop 宿主可能
# 以 UTF-16/CRLF 出流，NUL 会让 grep 退化成 binary-file 匹配）。
# 解析片段经 -Command 传入（不落盘）；MSYS_NO_PATHCONV/MSYS2_ARG_CONV_EXCL
# 防 Git Bash 对含 D:/ 的参数做路径改写。
gate_parse() {
  winp="$(ps_path_for_host "$1" "$2")"
  snippet="\$e=\$null; \$t=\$null; if (-not (Test-Path -LiteralPath '$winp')) { Write-Output ('PARSE_ERR unreadable target: $winp'); exit 1 }; try { \$t=[System.Management.Automation.Language.Parser]::ParseFile('$winp', [ref]\$null, [ref]\$e) } catch { Write-Output ('PARSE_ERR io: ' + \$_.Exception.Message); exit 1 }; if (\$e.Count -gt 0) { \$e | ForEach-Object { Write-Output ('PARSE_ERR ' + \$_.Extent.StartLineNumber + ': ' + \$_.Message) }; exit 1 } else { exit 0 }"
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "$1" -NoProfile -NonInteractive -Command "$snippet" | tr -d '\0\r'
}

# report_sections <ps1 文件> <sh 文件> <宿主或空>：跑段 1-4（sh 文件只做哨兵
# 对账），违例行打到 stdout（ASCII_VIOL/BOM_VIOL/SENTINEL_FAIL/PARSE_FAIL/
# PS_SKIP 前缀），返回值 = 违例段数（PS_SKIP 不计）。
report_sections() {
  n=0
  viol="$(gate_ascii "$1")"
  if [ -n "$viol" ]; then printf '%s\n' "$viol"; n=$((n+1)); fi
  bom="$(gate_bom "$1")"
  if [ -n "$bom" ]; then printf '%s\n' "$bom"; n=$((n+1)); fi
  if ! gate_sentinel "$1"; then
    printf 'SENTINEL_FAIL %s: last line is not "%s"\n' "$1" "$SENTINEL_LINE"
    n=$((n+1))
  fi
  if [ -z "$3" ]; then
    printf 'PS_SKIP no PowerShell host found - parse validation skipped (ASCII/BOM/sentinel still enforced)\n'
  else
    errs="$(gate_parse "$3" "$1" 2>/dev/null || true)"
    if [ -n "$(printf '%s\n' "$errs" | grep '^PARSE_ERR' || true)" ]; then
      printf 'PARSE_FAIL %s: Parser::ParseFile reported errors\n' "$1"
      printf '%s\n' "$errs" | grep '^PARSE_ERR' || true
      n=$((n+1))
    fi
  fi
  if ! gate_sentinel "$2"; then
    printf 'SENTINEL_FAIL %s: last line is not "%s" (sh side drifted from ps side)\n' "$2" "$SENTINEL_LINE"
    n=$((n+1))
  fi
  return "$n"
}

if [ "$#" -gt 1 ]; then fail_usage "用法: check-install-ps.sh [repo-dir] | --self-test"; fi

self_test=0
target_dir=""
for arg in "$@"; do
  case "$arg" in
    --self-test) self_test=1 ;;
    -h|--help) echo "用法: check-install-ps.sh [repo-dir] | --self-test"; exit 2 ;;
    *) target_dir="$arg" ;;
  esac
done

host="$(find_ps_host || true)"

# fixture_dir <宿主>：--self-test 夹具目录。Windows 宿主跑在 Linux（WSL
# interop）时，mktemp 默认的 /tmp 在 WSL 专属 ext4 上，对 powershell.exe 的
# \\wsl.localhost UNC 在部分环境不可达（实测本机 UNREADABLE）——夹具须落在
# 宿主自己可读的文件系统：问宿主要 $env:TEMP，wslpath 反映射成 /mnt/c/...，
# WSL 写、Windows 读，同一 drvfs 两面可见；Git Bash（cygpath 映射）与
# Linux 原生 pwsh 直接用默认 /tmp。仅自证用，不碰仓库。
fixture_dir() {
  if [ "$(uname -s)" = "Linux" ] && [ "$1" != "pwsh" ] && command -v wslpath >/dev/null 2>&1; then
    wtemp="$("$1" -NoProfile -NonInteractive -Command 'Write-Output $env:TEMP' 2>/dev/null | tr -d '\r\0')"
    ltemp="$(wslpath "$wtemp" 2>/dev/null || true)"
    if [ -n "$ltemp" ] && [ -d "$ltemp" ]; then
      mktemp -d "$ltemp/ccps-selftest-XXXXXX" 2>/dev/null && return 0
    fi
  fi
  mktemp -d
}

if [ "$self_test" = 1 ]; then
  # 夹具红绿自证：good 夹具（ASCII+哨兵+可解析，sh 侧夹具同哨兵）0 违例；
  # 五红各命中对应段——bad-nonascii（CJK 字符）→段 1 / bad-nosentinel（末行
  # 非哨兵）→段 3 / bad-parse（ASCII+哨兵但括号不配对）→段 4 / sh 侧无哨兵
  # →跨脚本对账红 / BOM 夹具→段 2。误改扫描口径/哨兵判定/解析段在此即红，
  # 不需污染真实仓库。宿主缺席时段 4 走 SKIP 口径——PARSE 红侧不可判，
  # 自证按降级口径通过并如实标注（宿主在场时才是完整红绿）。
  tmp="$(fixture_dir "$host")" || fail_usage "self-test: mktemp 不可用"
  trap 'rm -rf "$tmp"' EXIT
  cat > "$tmp/good.ps1" <<'EOF'
# good fixture: ASCII-only installer stub
$Port = 9999
Write-Host 'FAKE_INSTALL_RAN_OK'
# __CODECOMBO_INSTALL_SENTINEL__
EOF
  cp "$tmp/good.ps1" "$tmp/sh-good.ps1"
  cat > "$tmp/bad-nonascii.ps1" <<'EOF'
# bad fixture: a non-ASCII comment tail swallows the next line under ANSI
$Port = 9999
# 版本决策（CJK comment）
Write-Host 'never reached'
# __CODECOMBO_INSTALL_SENTINEL__
EOF
  cat > "$tmp/bad-nosentinel.ps1" <<'EOF'
# bad fixture: ASCII-only but the trailing sentinel is missing (truncated)
$Port = 9999
Write-Host 'FAKE_INSTALL_RAN_OK'
EOF
  cat > "$tmp/bad-parse.ps1" <<'EOF'
# bad fixture: ASCII-only + sentinel but unbalanced brace
if ($true {
  Write-Host 'never reached'
}
# __CODECOMBO_INSTALL_SENTINEL__
EOF
  printf 'not the sentinel\n' > "$tmp/sh-bad.ps1"
  printf '\xEF\xBB\xBF# bom fixture\n' > "$tmp/bad-bom.ps1"

  fail=0
  # 绿侧：good 0 违例
  out="$(report_sections "$tmp/good.ps1" "$tmp/sh-good.ps1" "$host")"; green=$?
  if [ "$green" = "0" ]; then :; else
    echo "SELFTEST_FAIL: good 夹具期待 0 违例，实得 $green" >&2
    printf '%s\n' "$out" >&2
    fail=$((fail+1))
  fi
  # 红侧 1：非 ASCII 命中段 1
  out1="$(report_sections "$tmp/bad-nonascii.ps1" "$tmp/sh-good.ps1" "$host")"
  if printf '%s\n' "$out1" | grep -q '^ASCII_VIOL'; then :; else
    echo "SELFTEST_FAIL: bad-nonascii 未命中 ASCII_VIOL" >&2; fail=$((fail+1))
  fi
  # 红侧 2：无哨兵命中段 3（ps 侧）
  out2="$(report_sections "$tmp/bad-nosentinel.ps1" "$tmp/sh-good.ps1" "$host")"
  if printf '%s\n' "$out2" | grep -q '^SENTINEL_FAIL .*bad-nosentinel'; then :; else
    echo "SELFTEST_FAIL: bad-nosentinel 未命中 SENTINEL_FAIL" >&2; fail=$((fail+1))
  fi
  # 红侧 3：括号不配对命中段 4（宿主在场才可判）
  out3="$(report_sections "$tmp/bad-parse.ps1" "$tmp/sh-good.ps1" "$host")"
  if printf '%s\n' "$out3" | grep -q '^PARSE_FAIL'; then :; elif [ -z "$host" ]; then :; else
    echo "SELFTEST_FAIL: bad-parse 未命中 PARSE_FAIL" >&2; fail=$((fail+1))
  fi
  # 红侧 4：sh 侧无哨兵 → 跨脚本对账红
  out4="$(report_sections "$tmp/good.ps1" "$tmp/sh-bad.ps1" "$host")"
  if printf '%s\n' "$out4" | grep -q '^SENTINEL_FAIL .*sh side drifted'; then :; else
    echo "SELFTEST_FAIL: 跨脚本哨兵对账未命中 sh-side drift" >&2; fail=$((fail+1))
  fi
  # 红侧 5：BOM 头字节
  out5="$(gate_bom "$tmp/bad-bom.ps1")"
  if printf '%s\n' "$out5" | grep -q '^BOM_VIOL'; then :; else
    echo "SELFTEST_FAIL: BOM 夹具未命中 BOM_VIOL" >&2; fail=$((fail+1))
  fi
  if [ "$fail" = "0" ]; then
    if [ -n "$host" ]; then
      echo "GATE_SELF_TEST_OK（good 0 违例；non-ascii/无哨兵/parse/跨脚本对账/BOM 五红各命中；PS 宿主=$host）"
    else
      echo "GATE_SELF_TEST_OK（good 0 违例；non-ascii/无哨兵/跨脚本对账/BOM 四红各命中；无 PowerShell 宿主，PARSE 红侧降级跳过）"
    fi
    exit 0
  fi
  echo "GATE_SELF_TEST_FAIL" >&2
  exit 2
fi

# 默认目标：脚本所在仓库根（可显式传参；wsl-verify 门禁传 $REPO）
if [ -z "$target_dir" ]; then
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  target_dir="$(cd "$script_dir/.." && pwd)"
fi
[ -d "$target_dir" ] || fail_usage "目标目录不存在: $target_dir"
PST="$target_dir/scripts/install.ps1"
SHT="$target_dir/scripts/install.sh"
[ -f "$PST" ] || fail_usage "目标缺失: $PST"
[ -f "$SHT" ] || fail_usage "目标缺失: $SHT（哨兵同串对账需要）"

echo "== check-install-ps on $target_dir =="
if [ -n "$host" ]; then
  echo "-- PowerShell host: $host --"
else
  echo "-- PowerShell host: none (ParseFile 段将 SKIP，ASCII/BOM/哨兵照常把关) --"
fi

out="$(report_sections "$PST" "$SHT" "$host")"
viol_n="$(printf '%s\n' "$out" | grep -c '^ASCII_VIOL\|^BOM_VIOL\|^SENTINEL_FAIL\|^PARSE_FAIL' || true)"

if [ "${viol_n:-0}" -gt 0 ]; then
  printf '%s\n' "$out" | grep '^ASCII_VIOL\|^BOM_VIOL\|^SENTINEL_FAIL\|^PARSE_FAIL'
  echo "INSTALL_PS_CHECK_FAILED: ${viol_n} 处违例（ASCII_VIOL=非 ASCII 注释吞行面；BOM_VIOL=头字节 EF BB BF；" >&2
  echo "  SENTINEL_FAIL=末行非哨兵（跨脚本同串对账含 install.sh）；PARSE_FAIL=ParseFile 报错）。" >&2
  exit 1
fi

if printf '%s\n' "$out" | grep -q '^PS_SKIP'; then
  echo "INSTALL_PS_CHECK_OK_SKIP_PARSE（ASCII 0 违例 + 无 BOM + 两脚本末行哨兵同串；ParseFile 因无 PowerShell 宿主 SKIP）"
  exit 0
fi

echo "INSTALL_PS_CHECK_OK（ASCII 0 违例 + 无 BOM + 两脚本末行哨兵同串 + ParseFile 0 error）"
exit 0
