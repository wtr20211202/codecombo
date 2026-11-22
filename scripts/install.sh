#!/bin/sh
# install.sh —— Codecombo 一键安装 + 服务化（Linux/macOS）。
#
# 一键形态（落盘执行，可整条丢给 AI 助手代跑）：
#   p=$(mktemp) && curl -fsSL --retry 3 https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh -o "$p" && sh "$p"; rm -f "$p"
# 带参数（见下「环境变量」；变量须前缀在末段 sh "$p" 上——写在 curl 前只对
# curl 生效，脚本读不到、回落默认值）：
#   p=$(mktemp) && curl -fsSL --retry 3 https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh -o "$p" && CODECOMBO_PORT=11000 CODECOMBO_DATA_DIR=$HOME/.codecombo-test sh "$p"; rm -f "$p"
# 为什么落盘不直灌管道：传输中断/代理改写会把不完整脚本丢给 sh 执行（截断
# 多报 unexpected EOF，改写可致任意行为），落盘后入口有尾行哨兵自检（见下
# 「哨兵自检」）拦不完整脚本；mktemp 临时名替代固定 /tmp 名（消除碰撞/
# 符号链接面，且自带清理）；--retry 3 兼容底线 curl 7.12+（--retry-all-errors
# 需 curl ≥7.71，老系统遇未知选项直接硬失败，不进默认命令——README 有注记）
#
# 行为：探测平台 → 版本决策（正式版优先，无则最新 rc，再无最新 beta）→
# 从 GitHub Releases 下载对应二进制 →
# SHA256 校验 → 装入用户级目录 → 服务化（Linux systemd 系统服务需免密 sudo
# 或 root 身份直写——root 会话免 sudo；两者皆无退化为手动启动说明；macOS
# launchd 用户代理免 sudo）→ Linux systemd
# 路径同装 polkit 放行规则（应用内自更新收尾与「重启应用」按钮以服务用户
# 身份 systemctl restart codecombo.service，系统服务默认策略要求鉴权，无规则
# 必被拒——与远程部署器 server/deploy/codecombo.go 同款）。
# 适用面：只适用于「脚本装」实例（二进制在 $PREFIX，默认 ~/.local/bin）的
# 首装与升级重跑——升级首选应用内自更新（GitHub 源，失败自动回滚），重跑
# 本脚本是次选。远程部署器装的实例（二进制在 ~/.codecombo/bin，其 unit 多
# PATH/WorkingDirectory 与默认开启的 NoNewPrivileges）【禁止】重跑：unit 被
# 本脚本模板覆写丢掉这几行、缺省绑定缩回 127.0.0.1，服务一重启远程访问即断。
# npm 安装的更新归 npm 管（应用内自动让位）。数据目录零触碰（见下 PREFIX 注）。
# Linux 上服务在跑时重跑只换盘上二进制（有免密 sudo 或 root 身份时连带重写
# unit）、不重启——需 sudo systemctl restart codecombo 才生效（macOS 由脚本
# launchctl unload/load 即时生效）。
#
# 环境变量：
#   CODECOMBO_PREFIX   安装目录（默认 $HOME/.local/bin——在数据目录之外，
#                      安装器绝不写入/修改 ~/.codecombo 数据目录，数据只归
#                      应用自己管理：首启自建、升级零触碰）
#   CODECOMBO_PORT     服务端口（默认 9999）
#   CODECOMBO_HOST     绑定地址（默认 127.0.0.1 仅本机；0.0.0.0 = 局域网可达，
#                      请仅在可信网络使用——锁密码是唯一访问闸门）
#   CODECOMBO_DATA_DIR 数据目录（默认 ~/.codecombo；须为绝对路径，~/ 开头按
#                      安装用户家目录展开）。安装器只把路径交给服务——systemd
#                      unit / launchd plist 的 CC_DATA_DIR 环境变量、手动启动
#                      命令的 --data-dir——仍不创建/写入该目录（首启由应用自
#                      建）；未设置时 unit/plist 不写该变量，与旧版逐字一致
#   CODECOMBO_MIRROR  镜像前缀（默认 https://ghproxy.net/；下载官方直连失败时
#                      自动以「前缀+完整 URL」形态重试一轮）。置空禁用镜像回落；
#                      也可覆盖为其他 ghproxy 型前缀——此类服务历史上换域名/
#                      易主频发，失效时改环境变量即可，不必改脚本
#
# 并存第二套实例：服务名固定（codecombo.service / com.codecombo），一台机器
# 只有一个脚本托管的服务——已有该服务的实例（脚本装或远程部署装）时，带新
# 端口/数据目录重跑会改写那个服务（接管原实例）而非新增一个；此时第二套
# 不走服务注册，用已装二进制手动起（后台守护运行）：
# <bin> start --port 11000 --data-dir <dir>。
# 装时指定过 CODECOMBO_DATA_DIR 的，重跑升级须带同值，否则改写后的服务下次
# 重启回落默认数据目录（数据仍在原目录，只是实例不再读它）。
#
# 版本决策（全自动，无参数）：有正式版装最新正式版；当前没有正式版时装
# 最新的 rc；没有 rc 才装最新的 beta。GitHub 侧栏同理只认正式版。
#
# Windows 用户请用同目录 install.ps1（PowerShell）。
set -eu

REPO="wtr20211202/codecombo"
PORT="${CODECOMBO_PORT:-9999}"
BIND_HOST="${CODECOMBO_HOST:-127.0.0.1}"

# 运行用户感知：脚本设计为「普通用户身份运行，内部 sudo 提权写系统文件」；
# root 直跑同样支持（免 sudo 直写系统文件，见下方服务化判定分支）。整条
# sudo 跑时 $HOME/SUDO_USER 会指向 root——服务 unit 的 User= 与安装/数据
# 目录必须跟随真实用户，否则服务以 root 身份跑、数据落 /root/.codecombo
REAL_USER="${SUDO_USER:-$(id -un)}"

# root 防线（与远程部署器 useradd 非 root 语义同源）：拒绝 root 安装/服务化
# ——root 跑工作台是安全反模式（锁密码与凭据保护的资产对 root 无意义），且
# 数据落 /root 对普通用户不可达。sudo 跑的按 SUDO_USER 视角继续
if [ "$(id -u)" = "0" ] && [ "$REAL_USER" = "root" ]; then
  echo "ERROR: do not run this installer as root." >&2
  echo "  Create a normal user first, then re-run as that user:" >&2
  echo "    useradd -m -s /bin/bash codecombo && su - codecombo" >&2
  # printf 而非 echo：命令模板含引号/反斜杠语义，echo 在 dash 下会吃转义序列
  printf '    p=$(mktemp) && curl -fsSL --retry 3 https://raw.githubusercontent.com/%s/main/scripts/install.sh -o "$p" && sh "$p"; rm -f "$p"\n' "$REPO" >&2
  exit 1
fi

# ---------- 哨兵自检：脚本自身完整性（S2 落盘形态硬化） ----------
# 一键形态已改「curl 落盘 → sh 执行」（见头注）：本文件最后一行是哨兵注释，
# 执行前回读校验——传输截断/代理改写丢尾即拒装（fail-closed），不再把不完整
# 脚本直接跑起来（浅截断保留哨兵前的可解析正文时由本检查拦；深截断由 sh 解
# 析器 unexpected EOF 拦）。放在 set -eu/变量定义/root 防线之后、任何网络与
# 安装动作之前
case "$0" in
  */*) SELF="$0" ;;    # 落盘形态（mktemp 一行式、./install.sh、绝对路径）
  sh)  SELF="" ;;      # 管道形态（curl … | sh）：$0 即 sh，stdin 已被消费读不回
  *)   SELF="./$0" ;;  # sh install.sh 裸名形态：按 cwd 相对路径回读同一文件
esac
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  # tail -n 5：哨兵须在文件尾（窗口内才算完整——内容被追加时哨兵仍在窗内，
  # 被截断时哨兵必丢）；tail/grep 任一失效都走 else——环境异常时宁可不装
  if tail -n 5 "$SELF" | grep -q '__CODECOMBO_INSTALL_SENTINEL__'; then
    : # 哨兵在位——脚本完整，继续安装
  else
    echo "ERROR: 安装脚本下载不完整——网络中断或代理改写（尾部哨兵缺失）。" >&2
    echo "  请重试下载安装，或改用 npm 渠道：npm i -g codecombo@next" >&2
    # 镜像回退指引（P-20261116-2-S1）：CN 网络官方直连不可达是失败常态——给可整条
    # 粘贴的镜像前缀命令（循上方 root 防线 printf 全命令先例）；脚本内自动重试归 S2
    printf '  官方直连不可达可走镜像前缀重试：p=$(mktemp) && curl -fsSL --retry 3 https://ghproxy.net/https://raw.githubusercontent.com/%s/main/scripts/install.sh -o "$p" && sh "$p"; rm -f "$p"\n' "$REPO" >&2
    exit 1
  fi
else
  # 管道形态（$0=sh）与进程替换/管道 fd（/dev/fd/N 非常规文件）无法回读校验
  # ——不误报「下载不完整」，提示即拒绝：无法校验完整性的执行形态不装
  echo "ERROR: 本脚本正以管道形态执行（curl … | sh），无法校验下载完整性。" >&2
  echo "  请改用落盘一行式命令（见 README / 官网）：" >&2
  printf '  p=$(mktemp) && curl -fsSL --retry 3 https://raw.githubusercontent.com/%s/main/scripts/install.sh -o "$p" && sh "$p"; rm -f "$p"\n' "$REPO" >&2
  exit 1
fi

if command -v getent >/dev/null 2>&1; then
  REAL_HOME=$(getent passwd "$REAL_USER" | cut -d: -f6)
else
  REAL_HOME="$HOME"
fi
[ -n "$REAL_HOME" ] || REAL_HOME="$HOME"

PREFIX="${CODECOMBO_PREFIX:-$REAL_HOME/.local/bin}"
BIN="$PREFIX/codecombo"
# 数据目录（CODECOMBO_DATA_DIR 可覆盖）：只用于交给服务与本脚本的活实例探测，
# 安装器不创建/不写入它。显式值在下载前校验（失败不留半装态）：服务工作
# 目录是 /，相对路径会落错地方；引号/反斜杠/% 等会破坏 unit（systemd 对
# Environment= 做 C 转义与 % 说明符展开）与 plist（XML），$/` 会让打印的
# 手动启动命令在复制执行时被 shell 展开
DATA_DIR="${CODECOMBO_DATA_DIR:-$REAL_HOME/.codecombo}"
if [ -n "${CODECOMBO_DATA_DIR:-}" ]; then
  case "$DATA_DIR" in
    "~/"*) DATA_DIR="$REAL_HOME/${DATA_DIR#??}" ;;
  esac
  case "$DATA_DIR" in
    /*) ;;
    *) printf 'ERROR: CODECOMBO_DATA_DIR 须为绝对路径（当前值：%s）\n' "$DATA_DIR" >&2; exit 1 ;;
  esac
  case "$DATA_DIR" in
    *[\"%\&\<\>\$\`]*|*\\*)
      printf 'ERROR: CODECOMBO_DATA_DIR 含不支持的字符（" \\ %% & < > $ `）：%s\n' "$DATA_DIR" >&2; exit 1 ;;
  esac
fi
API="https://api.github.com/repos/${REPO}/releases?per_page=30"

say() { printf '\n==> %s\n' "$*"; }

# ---------- 版本决策：stable > 最新 rc > 最新 beta（列表按创建时间倒序） ----------
# 纯 sh 解析：按 "tag_name" 分段，段内找 draft/prerelease 标志与分类。
# 预发布期（首次正式版发布前）脚本自动落在 rc/beta 上，正式版发布后自动切换。
pick_version() {
  curl -fsSL "$API" | awk '
    BEGIN { RS = "\"tag_name\": \"" }
    NR > 1 {
      tag = substr($0, 1, index($0, "\"") - 1)
      pre  = ($0 ~ /"prerelease": *true/)
      draft = ($0 ~ /"draft": *true/)
      if (draft) next
      if (!pre && stable == "") stable = tag
      if (pre && rc == "" && tag ~ /rc/) rc = tag
      if (pre && beta == "" && tag ~ /beta/) beta = tag
    }
    END {
      if (stable != "") print "stable\n" stable
      else if (rc != "") print "rc\n" rc
      else if (beta != "") print "beta\n" beta
      else print "none\n"
    }'
}

PICKED=$(pick_version)
KIND=$(printf '%s\n' "$PICKED" | sed -n 1p)
TAG=$(printf '%s\n' "$PICKED" | sed -n 2p)
if [ -z "$TAG" ]; then
  echo "仓库中没有任何可用 release（stable/rc/beta 均无）" >&2
  exit 1
fi
# 本文件 $VAR 一律 ${VAR} 花括号收口（尤其紧邻全角字符处）：macOS /bin/sh（bash
# 3.2，2007 年）解析 $VAR 后紧跟多字节字符时把首字节吞进变量名（实测报
# TAG? unbound——0xEF 残 ?），set -eu 即中止安装；${} 的 } 确定性终结名字解析，
# POSIX 各 sh（dash/busybox ash/bash 各版）全兼容、零行为变化。门禁
# scripts/check-install-sh.sh（挂 wsl-verify quick 首步）防回潮——代码行命中
# 即红，注释行豁免（注释不经变量解析，无此雷）
case "$KIND" in
  stable) say "版本：${TAG}（最新正式版）" ;;
  rc) say "版本：${TAG}（最新 rc——尚无正式版）" ;;
  beta) say "版本：${TAG}（最新 beta——尚无正式版与 rc）" ;;
esac
BASE="https://github.com/${REPO}/releases/download/${TAG}"

# ---------- 平台探测与归一 ----------
OS=$(uname -s)
case "$OS" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "不支持的系统：${OS}（Windows 请用 install.ps1）" >&2; exit 1 ;;
esac
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "不支持的架构：${ARCH}（amd64/arm64）" >&2; exit 1 ;;
esac
ASSET="codecombo-${OS}-${ARCH}"
say "平台：${OS}/${ARCH} → ${ASSET}"
if [ -n "${CODECOMBO_DATA_DIR:-}" ]; then
  say "数据目录：${DATA_DIR}（CODECOMBO_DATA_DIR；首启由应用自建，安装器不写入）"
fi

# ---------- 下载（指定版本资产 + 校验和清单；官方直连失败自动镜像重试） ----------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 镜像回退（P-20261116-2-S2）：CODECOMBO_MIRROR 覆盖镜像前缀，默认 ghproxy.net
# 示例——ghproxy 型服务历史上换域名/易主频发，硬编码无逃生口则失效即白付一轮
# 超时（评审修订点③）；置空禁用镜像回落。形态与 README/官网示例同款=完整 URL
# 前加前缀，尾斜杠缺失自动补；非 http(s) 值视为误配、下载前即报（fail fast 省
# 一轮必然失败的超时，循上方 CODECOMBO_DATA_DIR 校验先例）。`${VAR-默认}` 无冒
# 号形态是刻意的：`:-` 会把显式置空也回落默认，「置空=禁用」就没了
MIRROR="${CODECOMBO_MIRROR-https://ghproxy.net/}"
if [ -n "${MIRROR}" ]; then
  case "${MIRROR}" in
    http://*|https://*) ;;
    *) printf 'ERROR: CODECOMBO_MIRROR 须为 http(s):// 形态的镜像前缀（当前值：%s）\n' "${MIRROR}" >&2; exit 1 ;;
  esac
  case "${MIRROR}" in
    */) ;;
    *) MIRROR="${MIRROR}/" ;;
  esac
fi

# dl <回落提示> <URL> <输出文件> <curl 选项...>：官方直连优先（选项由调用方传，
# 资产与清单各自的进度/续传/超时形态原样保留）；curl 非零退出且启用镜像时清掉
# 半成品（-C - 续传跨源会把两个来源拼进同一文件，镜像轮整文件重下、SHA256 对
# 单源结果兜底）、say 回落提示后以镜像前缀重试一轮。两轮均败（或镜像置空）返
# 回非零交调用方 dl_fail 报错。调用方一律置于 if ! 测试语境——函数体内 set -e
# 挂起，curl 失败不再像裸两条 curl 那样静默退出（本函数即 S2 新建的下载失败分支）
dl() {
  _dl_note="$1"; _dl_url="$2"; _dl_out="$3"; shift 3
  if curl "$@" "${_dl_url}" -o "${_dl_out}"; then
    return 0
  fi
  [ -n "${MIRROR}" ] || return 1
  rm -f "${_dl_out}"
  if [ -n "${_dl_note}" ]; then say "${_dl_note}"; fi
  curl "$@" "${MIRROR}${_dl_url}" -o "${_dl_out}"
}

# 两轮均败的统一出口：npm 渠道 + 镜像手动指引（前缀可覆盖，失效换值即可，
# 不硬编码单点镜像）
dl_fail() {
  echo "ERROR: 下载失败：官方直连不可达，镜像回落未启用（CODECOMBO_MIRROR 置空）或同样失败。" >&2
  echo "  改用 npm 渠道：npm i -g codecombo@next（registry 自带完整性机制）" >&2
  echo "  或稍后重试官方直连；镜像前缀可用 CODECOMBO_MIRROR 覆盖（ghproxy 型服务换域名/易主时改值即可）" >&2
  exit 1
}

say "下载 $BASE/${ASSET}（约 50MB，进度条见下；慢网络需数分钟）"
# -# 进度条（静默模式像卡死）；--connect-timeout/--max-time 防死连接挂起
# -C - 断点续传（BASE 固定 GitHub Releases 下载端点，支持 Range）：有续传条件
# 时按已收字节数发 Range 接着下，慢网大包不再每次重试从零重来。curl 行为随版
# 本分化（本机双二进制实测）：新版 curl（上游 2025-10 修复 retry 续传，
# Windows 自带 8.21.0 实测重连即 Range 续传）；老版（Ubuntu 24.04 自带 8.5.0
# 实测）重试仍从零重下（无害——输出被重写，SHA256 兜底）；传输被掐断
# （error 18）各版都不重试——非零退出即进下方 dl 的镜像回退。$TMP 由 mktemp
# 本次运行新建，无旧版本残留文件被误续拼接的可能（镜像轮的半成品由 dl 清掉）。
# SHA256SUMS 小文件不加 -C -：整文件重试代价可忽略，不为它引入续传语义变量
if ! dl "官方直连失败，改走镜像重试（CODECOMBO_MIRROR=${MIRROR}）" \
     "${BASE}/${ASSET}" "${TMP}/codecombo" \
     -# -fSL -C - --retry 3 --connect-timeout 30 --max-time 1800; then
  dl_fail
fi
# SHA256SUMS 清单：官方源优先、镜像回落——回落提示附信任边界残余风险注记
# （清单与二进制同走镜像时校验基准可被一并调包——与 README「信任边界如实说」
# 措辞同源：防损坏有防线/防恶意改写无防线的边界不因回落而含糊）；清单缺行
# fail-closed 现状保持（下方 expect 守卫零改动）
if ! dl "官方直连失败，SHA256SUMS 清单改走镜像下载（CODECOMBO_MIRROR=${MIRROR}）。注意：清单与二进制同走镜像时，校验基准可被一并调包（防损坏不防恶意改写）——完整性敏感场景请改官方直连或 npm 渠道" \
     "${BASE}/SHA256SUMS.txt" "${TMP}/SHA256SUMS.txt" \
     -fsSL --retry 3 --connect-timeout 30; then
  dl_fail
fi

# ---------- SHA256 校验（GNU sha256sum 与 macOS shasum 双兼容） ----------
expect=$(grep " ${ASSET}\$" "$TMP/SHA256SUMS.txt" | awk '{print $1}')
[ -n "$expect" ] || { echo "校验和清单中未找到 $ASSET" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$TMP/codecombo" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$TMP/codecombo" | awk '{print $1}')
else
  echo "无 sha256sum/shasum，跳过校验（不推荐）" >&2
  actual="$expect"
fi
[ "$actual" = "$expect" ] || { echo "SHA256 不匹配！期望 $expect 实际 $actual" >&2; exit 1; }
say "SHA256 校验通过"

# ---------- 安装 ----------
mkdir -p "$PREFIX"
mv "$TMP/codecombo" "$BIN"
chmod +x "$BIN"
say "已安装：$BIN"

# ---------- 服务化（与远程部署器同语义：Restart=on-failure + KillMode=process） ----------
# 数据目录下发（仅显式 CODECOMBO_DATA_DIR 时）：缺省不写 = 应用按 ~/.codecombo
# 默认解析——与旧版 unit/plist 逐字一致，也同远程部署器「unit 不下发数据目录
# env」口径。变量名取 CC_DATA_DIR 正名（服务端 CC_ 优先、SC_DATA_DIR 旧名回落
# 每次启动都打兼容告警且兼容层下一版本移除，故不写旧名）。以「接在模板既有行
# 尾的换行串」拼入：缺省为空串时模板输出逐字节不变
UNIT_DATA_ENV=""
PLIST_DATA_ENV=""
if [ -n "${CODECOMBO_DATA_DIR:-}" ]; then
  UNIT_DATA_ENV="
Environment=\"CC_DATA_DIR=$DATA_DIR\""
  PLIST_DATA_ENV="
  <key>EnvironmentVariables</key>
  <dict><key>CC_DATA_DIR</key><string>$DATA_DIR</string></dict>"
fi

SERVICE_unit() {
  cat <<UNIT
[Unit]
Description=Codecombo - self-hosted single-binary workbench (Git, terminals, AI agents, remote machines)
After=network.target

[Service]
Type=simple
User=$REAL_USER
ExecStart=$BIN --serve --port=$PORT --host $BIND_HOST
Restart=on-failure
Environment=HOME=$REAL_HOME$UNIT_DATA_ENV
# tmux 持久化：只杀主进程，脱管 tmux server（含智能体进程）随重启存活
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
}

if [ "$OS" = linux ] && command -v systemctl >/dev/null 2>&1; then
  # 服务化判定（P-20261116-3）：root 身份免 sudo 直注册——sudo 未装/免密探测
  # 失败的 root 会话此前被漏判只落手动指引（用户实测：事故机 root 直跑装完
  # 二进制却不注册不拉起，而机器上 enabled 旧 unit 恰与新二进制 ExecStart 同
  # 路径，只差一条 systemctl start）；真全新 root 机器仍被上方 root 防线拦截，
  # 本判定只放行 SUDO_USER 在场的 root 会话
  if [ "$(id -u)" = "0" ] || { command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; }; then
    # 特权前缀单一变量：root 置空、非 root 统一 sudo——本分支全部特权命令走
    # ${SUDO} 单代码路径，不复制 root/sudo 两分支（root 直写与 sudo tee 产物
    # 等价：sudo tee 本以 root 身份执行，root:root 同权限同 SELinux 语境）
    if [ "$(id -u)" = "0" ]; then SUDO=""; else SUDO="sudo"; fi
    say "注册 systemd 系统服务 codecombo.service（端口 ${PORT}）"
    # unit 原子写（评审修订点②「写失败不破坏现有注册」）：先写同目录临时名
    # 再 mv——同目录 mv 走 rename(2) 原子替换；tee/重定向先截断后写，中写失败
    # 会留残缺 unit 破坏既有注册，本形态写失败只丢临时件（临时名非 .service
    # 后缀，systemd 单元扫描不认，残留无副作用），原 unit 分毫不动。$$ 防并发
    # 重跑互踩
    UNIT_TMP="/etc/systemd/system/.codecombo.service.new.$$"
    SERVICE_unit | ${SUDO} tee "$UNIT_TMP" >/dev/null
    ${SUDO} mv -f "$UNIT_TMP" /etc/systemd/system/codecombo.service
    ${SUDO} systemctl daemon-reload
    # 自更新/页面重启配套（与远程部署器 server/deploy/codecombo.go 同款规则）：
    # 更新收尾与「重启应用」钩子以服务用户身份执行 `systemctl restart`，系统
    # 服务默认 polkit 策略为 auth_admin（manage-units implicit any）——无放行
    # 规则必被拒（Ubuntu 24.04/polkit 124 实测「Interactive authentication
    # required」；且 --serve 优雅退出码 0 不触发 Restart=on-failure 兜底，服务
    # 停在 inactive）。同时安装两代机制的放行规则（均只放行本单元重启）：
    #   rules.d/*.rules          → polkit ≥ 0.106 的 JS 规则（RHEL7+/Fedora/
    #                              SUSE/Debian 12+/Ubuntu 23.10+ 等）
    #   localauthority/50-local.d/*.pkla → 旧版 ≤ 0.105 的 pkla 规则
    #                              （Debian 11 / Ubuntu 22.04 等仍在用）
    # 失败仅告警不阻断安装：rule 缺失只影响应用内更新收尾/重启按钮，服务
    # 本身照常可用（systemctl 手动重启为 root/sudo 能力，不受影响）
    POLKIT_RULE=$(cat <<RULE
polkit.addRule(function(action, subject) {
    if (action.id == "org.freedesktop.systemd1.manage-units" &&
        subject.user == "$REAL_USER" &&
        action.lookup("unit") == "codecombo.service") {
        return polkit.Result.YES;
    }
});
RULE
)
    POLKIT_PKLA=$(cat <<PKLA
[Allow codecombo self-update restart]
Identity=unix-user:$REAL_USER
Action=org.freedesktop.systemd1.manage-units
ResultAny=yes
PKLA
)
    if ${SUDO} mkdir -p /etc/polkit-1/rules.d /etc/polkit-1/localauthority/50-local.d \
      && printf '%s\n' "$POLKIT_RULE" | ${SUDO} tee /etc/polkit-1/rules.d/10-codecombo-restart.rules >/dev/null \
      && printf '%s\n' "$POLKIT_PKLA" | ${SUDO} tee /etc/polkit-1/localauthority/50-local.d/10-codecombo-restart.pkla >/dev/null; then
      say "已装 polkit 放行规则（允许服务用户自重启 codecombo.service——应用内自更新收尾与重启按钮依赖）"
    else
      say "警告：polkit 规则安装失败——应用内自更新收尾与「重启应用」按钮将被拒（修复后重跑本脚本即可）"
    fi
    # 数据目录保护（安装器纪律）：已有活实例在跑时只注册不启动——两个实例
    # 共写一个数据目录会互踩（pid/锁/日志）；接管时机交给用户。守卫置于
    # enable --now 之前（评审修订点①）：运行中实例重装只换盘上二进制+重写
    # unit（app.go 启动即写 pid 文件，systemd 在跑的重装必命中守卫），跳过
    # 拉起防双实例共写；failed/未在跑态守卫不命中照常拉起——既有 enabled
    # unit 只差一条 start 的重装修复场景由此闭环
    if [ -f "$DATA_DIR/codecombo.pid" ] && kill -0 "$(cat "$DATA_DIR/codecombo.pid" 2>/dev/null)" 2>/dev/null; then
      say "检测到正在运行的 Codecombo 实例——服务已注册但【未启动】（避免双实例共写数据目录）"
      # 提示去 sudo 前缀（评审修订点③）：root 免 sudo 环境（${SUDO} 已空）
      # 打印「sudo systemctl start」不可执行
      say "停掉旧实例后执行：${SUDO:+sudo }systemctl start codecombo"
    else
      ${SUDO} systemctl enable --now codecombo.service
      say "服务已启动：systemctl status codecombo"
    fi
    say "访问 http://localhost:${PORT}（首启设置锁密码）"
    exit 0
  fi
  say "无免密 sudo——跳过系统服务，给出手动启动命令（不注册系统服务，后台守护运行；或重跑前先 sudo -v）"
  say "手动服务化：把下方 unit 写入 /etc/systemd/system/codecombo.service 后"
  say "  sudo systemctl daemon-reload && sudo systemctl enable --now codecombo"
  # 「下方 unit」须真的打印出来（初版起只有提示没有 unit）；含 CC_DATA_DIR
  # 等全部参数，手工服务化与自动注册同一份模板
  echo
  SERVICE_unit
  # 手动服务化同样缺 polkit 放行规则（09-3）：服务用户自重启被拒，应用内
  # 自更新收尾与重启按钮同病——完整规则见本脚本 systemd 分支，此处给出落位
  # 指引（免密 sudo 缺席时无法代装）
  say "并同装 polkit 放行规则（服务用户自重启授权，应用内自更新收尾与重启按钮依赖）："
  say "  /etc/polkit-1/rules.d/10-codecombo-restart.rules 放行 subject.user=unit 的 User= 重启 codecombo.service"
  say "  （完整规则见本脚本 systemd 分支——有免密 sudo 或 root 身份的机器重跑本脚本自动补装）"
fi

if [ "$OS" = darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/com.codecombo.plist"
  say "注册 launchd 用户代理 com.codecombo（免 sudo）"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.codecombo</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>--serve</string>
    <string>--port=$PORT</string>
    <string>--host</string>
    <string>$BIND_HOST</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>$PLIST_DATA_ENV
</dict>
</plist>
PLIST
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  say "服务已启动：launchctl list | grep codecombo"
  say "访问 http://localhost:${PORT}（首启设置锁密码）"
  exit 0
fi

# ---------- 兜底：手动启动说明（不注册系统服务） ----------
# 手动启动命令只携带显式指定的参数：未指定 = 与旧版输出逐字一致（二进制按
# 自身默认/config.json 取值）；指定了却不携带，并存的第二套实例会撞上默认
# 实例的端口与数据目录。start 本身即后台守护（输出走日志文件），要看实时
# 报错须 --serve 前台形态——命令模板见 systemd 分支的 ExecStart
START_ARGS=""
if [ -n "${CODECOMBO_PORT:-}" ]; then START_ARGS="$START_ARGS --port $PORT"; fi
if [ -n "${CODECOMBO_HOST:-}" ]; then START_ARGS="$START_ARGS --host $BIND_HOST"; fi
if [ -n "${CODECOMBO_DATA_DIR:-}" ]; then START_ARGS="$START_ARGS --data-dir \"$DATA_DIR\""; fi
say "手动启动：$BIN start${START_ARGS}（不注册系统服务，后台守护运行；排障看实时报错加 --serve 换前台形态）"
say "访问 http://localhost:${PORT}（首启设置锁密码）"
say "更新方式：应用内「检查更新」（GitHub 源，失败自动回滚）"
# 落盘完整性哨兵（须始终为本文件最后一行）：入口「哨兵自检」回读文件尾判定
# 脚本是否完整——后续维护在本行之后不得再追加内容；纯 ASCII 大写下划线注释
# 行、无 CJK 邻接变量，不触发 check-install-sh.sh 的扫描
# __CODECOMBO_INSTALL_SENTINEL__
