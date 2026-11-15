#!/bin/bash
# install.sh POSIX 加固门禁（P-20261113-3-S1）：CJK 邻接变量花括号收口防回潮
# + sh -n 语法检查 + 版本决策段 KIND 注入回归。
#
# 动机：用户 macOS 实测一键安装报 `sh: line 139: TAG?: unbound variable`——macOS
# /bin/sh（bash 3.2，2007 年）解析 $VAR 紧跟多字节字符时把首字节吞进变量名
# （错误显示单 ? 恰与只吞首字节 0xEF 吻合），变量名变 TAG? 未定义，set -eu
# （install.sh 顶部）即中止安装。与 locale 无关（UTF-8 locale 同样吞，「设
# locale 绕过」类自救不可靠），唯一正解 = ${VAR} 花括号收口（} 确定性终结
# 名字解析；POSIX 各 sh——Debian/Ubuntu dash、Alpine busybox ash、RHEL/Fedora
# bash sh-mode、macOS bash 3.2 本身——全兼容，零行为变化）。本脚本把该审计
# 固化为门禁防回潮，与 check-sensitive-logs.sh 同款挂法（wsl-verify quick 首步族）。
#
# 三段检查：
#   1. 门禁扫描   install.sh 代码行出现 $VAR 紧邻非 ASCII/控制字符即违例
#                 （与任务口径 grep -nP '\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]'
#                 等价实现，见下「已知边界」；行首 # 注释行豁免——注释不经
#                 变量解析，无此雷）
#   2. sh -n      整文件语法检查（POSIX sh 语法错误在此暴露）
#   3. KIND 注入  从 install.sh 抽取版本决策段（KIND=… 行 → BASE=… 行，含
#                 stable/rc/beta case 分支与空 TAG 守卫），PICKED 注入
#                 stable/rc/beta/none 四态跑 set -eu 回归——断言退出码与
#                 say 输出（stable/rc/beta 出「版本：」行；none 出 exit 1），
#                 并断言无 unbound 字样。注意：Linux/现代 shell 本就正确解析
#                 $TAG（（Git Bash bash 5.2 实测），此段是行为回归（花括号化
#                 不改行为、分支路由不坏）；macOS 3.2 失败形态由段 1 门禁抓
#                 ——CI 无 macOS 面，真机复验待用户回验
#
# 已知边界（如实声明，非静默漏）：
#   - 扫描口径用 LC_ALL=C awk 字节类 [^[:print:][:space:]] 实现非 ASCII 判定
#     （POSIX ERE 无 \xNN，grep -P 在 macOS 自带 BSD grep 不存在；GNU/Git Bash
#     grep 有 -P 但为保三平台可跑不用）。与 [^\x00-\x7F] 的差集 = ASCII 控制
#     字符（\x01-\x08\x0B\x0C\x0E-\x1F\x7F）——比任务口径更严：$VAR 后跟控制
#     字符（含 CRLF 的 \r）也报。install.sh 是 shell 脚本本不该有控制字符/CRLF，
#     误报方向是「抓得更严」不是漏抓；现 HEAD 零存量
#   - 注释行按行首 # 豁免：unquoted heredoc 内以 # 开头的行（unit/plist 模板
#     注释）同被豁免——heredoc 正文 $VAR+CJK 理论上有 macOS 3.2 展开风险，当前
#     零存量，靠评审兜底
#   - 版本决策段抽取靠 ^KIND=/^BASE= 行锚与 case "$KIND" 结构锚：install.sh
#     重构改名会让抽取落空——fail-closed 报锚漂移（exit 2），人工同步本脚本
#
# 用法：
#   bash scripts/check-install-sh.sh [repo-dir]     # 默认脚本所在仓库根
#   bash scripts/check-install-sh.sh --self-test    # 夹具红绿自证（临时目录不碰仓库）
# 退出码：0 全绿；1 门禁/回归违例；2 用法/自证失败/锚漂移/目标缺失。
# 平台：纯 bash + POSIX 工具（awk/sed/mktemp），Git Bash / WSL 双跑通用
# （Git Bash bash 5.2 与 WSL dash + mawk 双实测）。
set -u

fail_usage() { echo "check-install-sh: $1" >&2; exit 2; }

# gate_scan <install.sh 路径>：违例行打到 stdout，行前缀 GATE_VIOL 供计数。
# 口径：跳过行首 # 注释行；\$[A-Za-z_][A-Za-z0-9_]* 后紧跟非可打印非空白字节
# （LC_ALL=C 下即 \x80-\xFF 与控制字符——见头部「已知边界」差集说明）
gate_scan() {
  LC_ALL=C awk '
    /^[[:space:]]*#/ { next }
    $0 ~ /\$[A-Za-z_][A-Za-z0-9_]*[^[:print:][:space:]]/ {
      printf "GATE_VIOL %s:%d: %s\n", FILENAME, FNR, $0
    }
  ' "$1"
}

count_mark() { printf '%s\n' "$1" | grep -c "^$2" || true; }

# extract_segment <install.sh 路径> <输出文件>：抽取版本决策段（KIND= 起，
# BASE= 止）。段不触网（pick_version 的 curl 在段前，天然不进抽取窗口）。
# 抽空或缺结构锚返回非零（fail-closed）
extract_segment() {
  LC_ALL=C awk '
    /^KIND=/ { f = 1 }
    f { print }
    /^BASE=/ { exit }
  ' "$1" > "$2"
  [ -s "$2" ] || return 1
  grep -q 'case "$KIND"' "$2" || return 1
  grep -q '^BASE=' "$2" || return 1
}

if [ "$#" -gt 1 ]; then fail_usage "用法: check-install-sh.sh [repo-dir] | --self-test"; fi

self_test=0
target_dir=""
for arg in "$@"; do
  case "$arg" in
    --self-test) self_test=1 ;;
    -h|--help) echo "用法: check-install-sh.sh [repo-dir] | --self-test"; exit 2 ;;
    *) target_dir="$arg" ;;
  esac
done

if [ "$self_test" = 1 ]; then
  # 夹具红绿自证：断言精确计数——好夹具 0 违例（花括号收口/注释豁免/纯 ASCII
  # 邻接皆不报），坏夹具 3 违例（$TAG（/$PORT）/$START_ARGS（ 三形态逐一对应
  # 12 处存量同型）。误改扫描口径/注释豁免在此即红，不需污染真实仓库
  tmp="$(mktemp -d)" || fail_usage "self-test: mktemp 不可用"
  trap 'rm -rf "$tmp"' EXIT
  cat > "$tmp/good.sh" <<'EOF'
#!/bin/sh
set -eu
TAG=v9.9.9-beta.2
# 注释行 $TAG（豁免——注释不经变量解析
beta) say "版本：${TAG}（最新 beta）" ;;
*) echo "不支持的系统：${OS}（Windows 请用 install.ps1）" >&2 ;;
say "下载 $BASE/${ASSET}（花括号收口不报）"
say "下载 $HOME/.local（纯 ASCII 邻接不报）"
EOF
  # 红侧标本（违例形态有意留存——本文件若被纳入未来扩大的扫描面，这三行 heredoc
  # 夹具命中属预期，勿「修复」；与 check-sensitive-logs.sh 夹具同款处置）
  cat > "$tmp/bad.sh" <<'EOF'
#!/bin/sh
set -eu
beta) say "版本：$TAG（最新 beta）" ;;
echo "端口 $PORT）"
say "手动启动：$BIN start$START_ARGS（后台守护）"
EOF
  good="$(gate_scan "$tmp/good.sh")"
  bad="$(gate_scan "$tmp/bad.sh")"
  good_n=$(count_mark "$good" 'GATE_VIOL')
  bad_n=$(count_mark "$bad" 'GATE_VIOL')
  if [ "${good_n:-0}" = "0" ] && [ "${bad_n:-0}" = "3" ]; then
    echo "GATE_SELF_TEST_OK（好夹具 0 违例 / 坏夹具 3 违例，红绿自证通过）"
    exit 0
  fi
  echo "GATE_SELF_TEST_FAIL：期待 good=0 bad=3，实得 good=$good_n bad=$bad_n" >&2
  printf '%s\n' "$good" "$bad"
  exit 2
fi

# 默认目标：脚本所在仓库根（可显式传参；wsl-verify 门禁传 $REPO）
if [ -z "$target_dir" ]; then
  script_dir="$(cd "$(dirname "$0")" && pwd)"
  target_dir="$(cd "$script_dir/.." && pwd)"
fi
[ -d "$target_dir" ] || fail_usage "目标目录不存在: $target_dir"
INST="$target_dir/scripts/install.sh"
[ -f "$INST" ] || fail_usage "目标缺失: $INST"

echo "== check-install-sh on $target_dir =="

# ---- 段 1：门禁扫描（代码行 $VAR 紧邻非 ASCII 即违例） ----
all="$(gate_scan "$INST")"
viol=$(count_mark "$all" 'GATE_VIOL')
printf '%s\n' "$all" | grep '^GATE_VIOL' || true
if [ "${viol:-0}" -gt 0 ]; then
  echo "INSTALL_SH_CHECK_FAILED: ${viol} 处违例——代码行 \$VAR 紧邻非 ASCII 字符。" >&2
  echo "  macOS /bin/sh（bash 3.2）会把多字节首字节吞进变量名报 unbound variable；" >&2
  echo "  一律改写为 \${VAR} 花括号收口（零行为变化），注释行豁免。" >&2
  exit 1
fi
echo "-- gate: 0 违例（代码行 \$VAR 均花括号收口或纯 ASCII 邻接） --"

# ---- 段 2：sh -n 语法检查 ----
if ! sh -n "$INST"; then
  echo "INSTALL_SH_CHECK_FAILED: sh -n 语法检查不过（POSIX sh 视角）。" >&2
  exit 1
fi
echo "-- sh -n: 语法过 --"

# ---- 段 3：KIND 注入回归（stable/rc/beta/none 四态走版本决策段） ----
tmp="$(mktemp -d)" || fail_usage "mktemp 不可用"
trap 'rm -rf "$tmp"' EXIT
SEG="$tmp/segment.sh"
if ! extract_segment "$INST" "$SEG"; then
  echo "INSTALL_SH_CHECK_ANCHOR_DRIFT: 版本决策段抽取落空（^KIND=/^BASE= 行锚或" >&2
  echo "  case \"\$KIND\" 结构锚漂移）——install.sh 结构已变，请同步本脚本锚。" >&2
  exit 2
fi
# 一次性拼装 runfile（引号 heredoc 落 say 桩防转义层级漂移 + 段本体），四态
# 注入只换 PICKED 环境值；say 桩与 install.sh 同形态（\n==> 前缀），REPO 只被
# 段尾 BASE= 引用，桩值即可
RUN="$tmp/run.sh"
{
  printf 'set -eu\n'
  printf 'REPO="wtr20211202/codecombo"\n'
  cat <<'PRE'
say() { printf '\n==> %s\n' "$*"; }
PRE
  cat "$SEG"
} > "$RUN"

fail=0
for spec in "stable|v9.9.9|（最新正式版）" "rc|v9.9.9-rc.1|（最新 rc" "beta|v9.9.9-beta.2|（最新 beta"; do
  kind="${spec%%|*}"; rest="${spec#*|}"
  tag="${rest%%|*}"; expect="${rest#*|}"
  out="$(PICKED="$(printf '%s\n%s' "$kind" "$tag")" sh "$RUN" 2>&1)" && rc=0 || rc=$?
  if [ "$rc" -ne 0 ]; then
    echo "KIND_FAIL($kind): 段退出码 ${rc}（期待 0）" >&2
    printf '%s\n' "$out" >&2
    fail=1
  elif ! printf '%s\n' "$out" | grep -qF "版本：$tag$expect"; then
    echo "KIND_FAIL($kind): say 输出缺「版本：$tag${expect}」" >&2
    printf '%s\n' "$out" >&2
    fail=1
  elif printf '%s\n' "$out" | grep -qi 'unbound'; then
    echo "KIND_FAIL($kind): 输出含 unbound（set -eu 下有未定义变量）" >&2
    printf '%s\n' "$out" >&2
    fail=1
  fi
done
# none 态：TAG 为空须 exit 1（「没有任何可用 release」守卫）
out="$(PICKED="none" sh "$RUN" 2>&1)" && rc=0 || rc=$?
if [ "$rc" -ne 1 ]; then
  echo "KIND_FAIL(none): 空 TAG 段退出码 ${rc}（期待 1）" >&2
  printf '%s\n' "$out" >&2
  fail=1
elif ! printf '%s\n' "$out" | grep -q '没有任何可用 release'; then
  echo "KIND_FAIL(none): 缺「没有任何可用 release」守卫输出" >&2
  printf '%s\n' "$out" >&2
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "INSTALL_SH_CHECK_FAILED: KIND 注入回归红（见上 KIND_FAIL 行）。" >&2
  exit 1
fi

echo "INSTALL_SH_CHECK_OK（门禁零违例；sh -n 过；KIND stable/rc/beta/none 四态注入回归过）"
exit 0
