#!/bin/sh
# install.sh —— Codecombo 一键安装 + 服务化（Linux/macOS）。
#
# 一键形态（终端执行，可整条丢给 AI 助手代跑）：
#   curl -fsSL https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh | sh
#
# 行为：探测平台 → 版本决策（正式版优先，无则最新 rc，再无最新 beta）→
# 从 GitHub Releases 下载对应二进制 →
# SHA256 校验 → 装入用户级目录 → 服务化（Linux systemd 系统服务需 sudo，
# 无 sudo 退化为前台说明；macOS launchd 用户代理免 sudo）。
# 安装方式决定更新方式：本脚本/手动二进制安装 → 应用内自更新（GitHub 源，
# 失败自动回滚）；npm 安装 → npm 更新（应用内自动让位）。
#
# 环境变量：
#   CODECOMBO_PREFIX   安装目录（默认 $HOME/.local/bin——在数据目录之外，
#                      安装器绝不写入/修改 ~/.codecombo 数据目录，数据只归
#                      应用自己管理：首启自建、升级零触碰）
#   CODECOMBO_PORT     服务端口（默认 9999）
#   CODECOMBO_HOST     绑定地址（默认 127.0.0.1 仅本机；0.0.0.0 = 局域网可达，
#                      请仅在可信网络使用——锁密码是唯一访问闸门）
#
# 版本决策（全自动，无参数）：有正式版装最新正式版；当前没有正式版时装
# 最新的 rc；没有 rc 才装最新的 beta。GitHub 侧栏同理只认正式版。
#
# Windows 用户请用同目录 install.ps1（PowerShell）。
set -eu

REPO="wtr20211202/codecombo"
PORT="${CODECOMBO_PORT:-9999}"
BIND_HOST="${CODECOMBO_HOST:-127.0.0.1}"

# 运行用户感知：脚本设计为「普通用户身份运行，内部 sudo 提权写系统文件」。
# 整条 sudo 跑时 $HOME/SUDO_USER 会指向 root——服务 unit 的 User= 与安装/数据
# 目录必须跟随真实用户，否则服务以 root 身份跑、数据落 /root/.codecombo
REAL_USER="${SUDO_USER:-$(id -un)}"

# root 防线（与远程部署器 useradd 非 root 语义同源）：拒绝 root 安装/服务化
# ——root 跑工作台是安全反模式（锁密码与凭据保护的资产对 root 无意义），且
# 数据落 /root 对普通用户不可达。sudo 跑的按 SUDO_USER 视角继续
if [ "$(id -u)" = "0" ] && [ "$REAL_USER" = "root" ]; then
  echo "ERROR: do not run this installer as root." >&2
  echo "  Create a normal user first, then re-run as that user:" >&2
  echo "    useradd -m -s /bin/bash codecombo && su - codecombo" >&2
  echo "    curl -fsSL https://raw.githubusercontent.com/${REPO}/main/scripts/install.sh | sh" >&2
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
DATA_DIR="$REAL_HOME/.codecombo"
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
case "$KIND" in
  stable) say "版本：$TAG（最新正式版）" ;;
  rc) say "版本：$TAG（最新 rc——尚无正式版）" ;;
  beta) say "版本：$TAG（最新 beta——尚无正式版与 rc）" ;;
esac
BASE="https://github.com/${REPO}/releases/download/${TAG}"

# ---------- 平台探测与归一 ----------
OS=$(uname -s)
case "$OS" in
  Linux) OS=linux ;;
  Darwin) OS=darwin ;;
  *) echo "不支持的系统：$OS（Windows 请用 install.ps1）" >&2; exit 1 ;;
esac
ARCH=$(uname -m)
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "不支持的架构：$ARCH（amd64/arm64）" >&2; exit 1 ;;
esac
ASSET="codecombo-${OS}-${ARCH}"
say "平台：${OS}/${ARCH} → ${ASSET}"

# ---------- 下载（指定版本资产 + 校验和清单） ----------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "下载 $BASE/$ASSET"
curl -fsSL "$BASE/$ASSET" -o "$TMP/codecombo"
curl -fsSL "$BASE/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt"

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
SERVICE_unit() {
  cat <<UNIT
[Unit]
Description=Codecombo - Lightweight Coding Platform
After=network.target

[Service]
Type=simple
User=$REAL_USER
ExecStart=$BIN --serve --port=$PORT --host $BIND_HOST
Restart=on-failure
Environment=HOME=$REAL_HOME
# tmux 持久化：只杀主进程，脱管 tmux server（含智能体进程）随重启存活
KillMode=process

[Install]
WantedBy=multi-user.target
UNIT
}

if [ "$OS" = linux ] && command -v systemctl >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    say "注册 systemd 系统服务 codecombo.service（端口 $PORT）"
    SERVICE_unit | sudo tee /etc/systemd/system/codecombo.service >/dev/null
    sudo systemctl daemon-reload
    # 数据目录保护（安装器纪律）：已有活实例在跑时只注册不启动——两个实例
    # 共写一个数据目录会互踩（pid/锁/日志）；接管时机交给用户
    if [ -f "$DATA_DIR/codecombo.pid" ] && kill -0 "$(cat "$DATA_DIR/codecombo.pid" 2>/dev/null)" 2>/dev/null; then
      say "检测到正在运行的 Codecombo 实例——服务已注册但【未启动】（避免双实例共写数据目录）"
      say "停掉旧实例后执行：sudo systemctl start codecombo"
    else
      sudo systemctl enable --now codecombo.service
      say "服务已启动：systemctl status codecombo"
    fi
    say "访问 http://localhost:$PORT（首启设置锁密码）"
    exit 0
  fi
  say "无免密 sudo——跳过系统服务，给出前台启动命令（或重跑前先 sudo -v）"
  say "手动服务化：把下方 unit 写入 /etc/systemd/system/codecombo.service 后"
  say "  sudo systemctl daemon-reload && sudo systemctl enable --now codecombo"
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
  <key>KeepAlive</key><true/>
</dict>
</plist>
PLIST
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  say "服务已启动：launchctl list | grep codecombo"
  say "访问 http://localhost:$PORT（首启设置锁密码）"
  exit 0
fi

# ---------- 兜底：前台启动说明 ----------
say "前台启动：$BIN start（后台守护形态，端口 $PORT）"
say "访问 http://localhost:$PORT（首启设置锁密码）"
say "更新方式：应用内「检查更新」（GitHub 源，失败自动回滚）"
