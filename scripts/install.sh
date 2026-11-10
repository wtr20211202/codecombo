#!/bin/sh
# install.sh —— Codecombo 一键安装 + 服务化（Linux/macOS）。
#
# 一键形态（终端执行，可整条丢给 AI 助手代跑）：
#   curl -fsSL https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh | sh
# 带参数（见下「环境变量」；变量须放在管道 sh 一侧——写在 curl 前只对 curl
# 生效，脚本读不到、回落默认值）：
#   curl -fsSL https://raw.githubusercontent.com/wtr20211202/codecombo/main/scripts/install.sh | CODECOMBO_PORT=11000 CODECOMBO_DATA_DIR=$HOME/.codecombo-test sh
#
# 行为：探测平台 → 版本决策（正式版优先，无则最新 rc，再无最新 beta）→
# 从 GitHub Releases 下载对应二进制 →
# SHA256 校验 → 装入用户级目录 → 服务化（Linux systemd 系统服务需 sudo，
# 无 sudo 退化为手动启动说明；macOS launchd 用户代理免 sudo）→ Linux systemd
# 路径同装 polkit 放行规则（应用内自更新收尾与「重启应用」按钮以服务用户
# 身份 systemctl restart codecombo.service，系统服务默认策略要求鉴权，无规则
# 必被拒——与远程部署器 server/deploy/codecombo.go 同款）。
# 适用面：只适用于「脚本装」实例（二进制在 $PREFIX，默认 ~/.local/bin）的
# 首装与升级重跑——升级首选应用内自更新（GitHub 源，失败自动回滚），重跑
# 本脚本是次选。远程部署器装的实例（二进制在 ~/.codecombo/bin，其 unit 多
# PATH/WorkingDirectory 与默认开启的 NoNewPrivileges）【禁止】重跑：unit 被
# 本脚本模板覆写丢掉这几行、缺省绑定缩回 127.0.0.1，服务一重启远程访问即断。
# npm 安装的更新归 npm 管（应用内自动让位）。数据目录零触碰（见下 PREFIX 注）。
# Linux 上服务在跑时重跑只换盘上二进制（有免密 sudo 时连带重写 unit）、
# 不重启——需 sudo systemctl restart codecombo 才生效（macOS 由脚本
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
if [ -n "${CODECOMBO_DATA_DIR:-}" ]; then
  say "数据目录：$DATA_DIR（CODECOMBO_DATA_DIR；首启由应用自建，安装器不写入）"
fi

# ---------- 下载（指定版本资产 + 校验和清单） ----------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
say "下载 $BASE/$ASSET（约 50MB，进度条见下；慢网络需数分钟）"
# -# 进度条（静默模式像卡死）；--connect-timeout/--max-time 防死连接挂起
# -C - 断点续传（BASE 固定 GitHub Releases 下载端点，支持 Range）：有续传条件
# 时按已收字节数发 Range 接着下，慢网大包不再每次重试从零重来。curl 行为随版
# 本分化（本机双二进制实测）：新版 curl（上游 2025-10 修复 retry 续传，
# Windows 自带 8.21.0 实测重连即 Range 续传）；老版（Ubuntu 24.04 自带 8.5.0
# 实测）重试仍从零重下（无害——输出被重写，SHA256 兜底）；传输被掐断
# （error 18）各版都不重试，直接报错走下方失败提示。$TMP 由 mktemp 本次运行
# 新建，无旧版本残留文件被误续拼接的可能。SHA256SUMS 小文件不加 -C -：整文
# 件重试代价可忽略，不为它引入续传语义变量
curl -# -fSL -C - --retry 3 --connect-timeout 30 --max-time 1800 "$BASE/$ASSET" -o "$TMP/codecombo"
curl -fsSL --retry 3 --connect-timeout 30 "$BASE/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt"

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
Description=Codecombo - Lightweight Coding Platform
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
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    say "注册 systemd 系统服务 codecombo.service（端口 $PORT）"
    SERVICE_unit | sudo tee /etc/systemd/system/codecombo.service >/dev/null
    sudo systemctl daemon-reload
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
    if sudo mkdir -p /etc/polkit-1/rules.d /etc/polkit-1/localauthority/50-local.d \
      && printf '%s\n' "$POLKIT_RULE" | sudo tee /etc/polkit-1/rules.d/10-codecombo-restart.rules >/dev/null \
      && printf '%s\n' "$POLKIT_PKLA" | sudo tee /etc/polkit-1/localauthority/50-local.d/10-codecombo-restart.pkla >/dev/null; then
      say "已装 polkit 放行规则（允许服务用户自重启 codecombo.service——应用内自更新收尾与重启按钮依赖）"
    else
      say "警告：polkit 规则安装失败——应用内自更新收尾与「重启应用」按钮将被拒（修复后重跑本脚本即可）"
    fi
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
  say "  （完整规则见本脚本 systemd 分支——有免密 sudo 的机器重跑本脚本自动补装）"
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
  say "访问 http://localhost:$PORT（首启设置锁密码）"
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
say "手动启动：$BIN start$START_ARGS（不注册系统服务，后台守护运行；排障看实时报错加 --serve 换前台形态）"
say "访问 http://localhost:$PORT（首启设置锁密码）"
say "更新方式：应用内「检查更新」（GitHub 源，失败自动回滚）"
