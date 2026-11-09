#!/bin/bash
# 重启 e2e 服务实例：stop -> [清空数据面] -> [npm ci] -> [前端构建] -> go build -> start -> 播种 -> 等就绪
# 用法：bash scripts/e2e-restart.sh [web] [port] [repo-dir]
#   web      = 前端源码有改动需重新构建嵌入（默认不构建，仅 Go 侧改动）
#   port     = 实例端口（默认 9999；worktree 并行场景传各槽位端口，
#              分享/回环等附属端口为主端口 +2/+1 自动派生，互不冲突）
#   repo-dir = 仓库根目录（默认本仓库；worktree 场景传 worktree 路径，
#              .e2e-data 相对仓库根，天然按实例隔离）
#   SC_E2E_DATA_DIR = 数据面目录覆盖（默认 .e2e-data；P-20261002-66 全量
#              分片并行时同一仓库起多实例，各实例传独立子目录
#              .e2e-data/full-<port>，避免 FRESH 清空互删数据面；
#              仓库级 keys/（WSL 机器级密钥）与 fixtures/（Gitea 推送夹具）
#              保持在 .e2e-data 根，不受分片子目录影响）
# 数据面清空（P-20261002-48）：默认每次重启清空 .e2e-data（槽位+主实例）——
# 槽位复用/主实例历史的残留状态（uiState/实例注册/通知等）不再跨运行串扰，
# 金态由 scripts/e2e-seed.sh 确定性重建（SC_E2E_FRESH=0 保留数据面调试用）。
# keys/ 除外：WSL e2e 密钥对是机器级身份（公钥已装进 WSL authorized_keys），
# 清掉会导致每次重启换钥重装授权，保留则播种器走幂等 kept 路径
set -e
BUILD="${1:-}"
PORT="${2:-9999}"
# REPO 归一为绝对路径（调用方传相对路径时按调用 cwd 展开）：它既是构建/播种的
# cd 目标，也会经 e2e-seed.sh 注册进实例成为项目路径——相对路径会让按注册路径
# 逐字推导的下游（claude 项目级会话编码目录等）整体落空
REPO="${3:-$(cd "$(dirname "$0")/.." && pwd)}"
REPO="$(cd "$REPO" 2>/dev/null && pwd || echo "$REPO")"
FRESH="${SC_E2E_FRESH:-1}"
DATA="${SC_E2E_DATA_DIR:-.e2e-data}"
SKIP_SEED="${SC_E2E_SKIP_SEED:-0}"

# 外部数据面安全阀（2026-10-18）：DATA 为绝对路径且不在本仓库内 → 用户真实数据目录
# （如 ~/.codecombo，19999 长期实例）。绝不 FRESH 清空、绝不 e2e-seed 播种——
# 只允许最新二进制以该目录启动（服务自身正常运行期写入除外）。
case "$DATA" in
  /*|[A-Za-z]:/*)
    case "$DATA" in
      "$REPO"/*|"$REPO") ;;
      *) FRESH=0; SKIP_SEED=1; echo "external data dir detected: fresh/seed disabled ($DATA)" ;;
    esac
    ;;
esac

# 槽位专用 sshd 端口派生（P-20261004-115）：实例端口命中 slots.json 槽位时，
# 导出 SC_E2E_SSH_PORT=2300+槽位号给 e2e-seed.sh→e2e-seed-wsl.sh（每槽独立
# sshd 实例，并行门禁不再互踩共享 :23 的 authorized_keys/端口/连接节流；不用
# 提案原文的 2222+槽位号——2222 被本机 netsh portproxy→WSL:22 惯例占用）。
# 显式 SC_E2E_SSH_PORT 优先（编排器可覆盖）；未命中槽位（9999 主实例、全量
# 分片 10971+ 等）或 slots.json 不在/异形时保持未设 → 播种器回落共享 :23 行为，
# 在途门禁与用户手动预置不受影响。脚本自身位置定位主仓库（worktree 调用方
# 传 REPO 指向 worktree，slots.json 恒在主仓库 .goal-enhance/）
if [ -z "${SC_E2E_SSH_PORT:-}" ]; then
  MAIN_REPO="$(cd "$(dirname "$0")/.." && pwd)"
  SLOT_JSON="$MAIN_REPO/.goal-enhance/slots.json"
  if [ -f "$SLOT_JSON" ]; then
    DERIVED="$(node - "$SLOT_JSON" "$PORT" << 'EOF'
const [file, port] = process.argv.slice(2);
try {
  const j = JSON.parse(require('fs').readFileSync(file, 'utf8'));
  const s = (j.slots || []).find(s => String(s.port) === String(port));
  if (s && Number.isInteger(s.id)) console.log(2300 + Number(s.id));
} catch { /* 异形 slots.json：回落共享行为 */ }
EOF
)"
    if [ -n "$DERIVED" ]; then
      SC_E2E_SSH_PORT="$DERIVED"
      export SC_E2E_SSH_PORT
      echo "slot sshd port derived: $SC_E2E_SSH_PORT (slot instance :$PORT)"
    fi
  fi
fi

cd "$REPO"

BIN=".sc-tmp/polish-e2e-$PORT.exe"
# 复用同 HEAD 二进制（2026-10-18）：9999 与 19999 同源构建——编排器为真实实例刷新时
# 可传 SC_E2E_REUSE_BIN 指向刚以当前 HEAD 构建好的二进制，跳过 npm install/build 与 go build。
SKIP_BUILD=0
if [ -n "${SC_E2E_REUSE_BIN:-}" ] && [ -f "${SC_E2E_REUSE_BIN}" ]; then
  cp -f "${SC_E2E_REUSE_BIN}" "$BIN"
  SKIP_BUILD=1
  echo "E2E_BIN_REUSED port=$PORT from=$SC_E2E_REUSE_BIN"
fi
# stop 必须显式 -p：PID 文件缺失时的端口兜底扫描若不带端口会按默认 9999
# 找进程，并行槽位场景会误杀主实例（实测踩坑）；显式端口后兜底只认本槽位
./"$BIN" stop -p "$PORT" -d "$DATA" 2>/dev/null || true
sleep 1

if [ "$FRESH" = "1" ] && [ -d "$DATA" ]; then
  find "$DATA" -mindepth 1 -maxdepth 1 ! -name keys -exec rm -rf {} +
  echo "E2E_DATA_CLEARED port=$PORT data=$DATA (keys/ preserved)"
fi

if [ "$SKIP_BUILD" != "1" ]; then
  # worktree 复用槽位的依赖漂移检测：node_modules 缺失、或 package-lock.json
  # 比上次安装标记新（新提案改过依赖）时重装——只查目录存在性会让旧依赖
  # 静默沿用，check/e2e 阶段莫名挂掉。--prefer-offline 命中本地缓存秒级完成
  STAMP="web/node_modules/.sc-installed-at"
  if [ ! -d web/node_modules ] || [ web/package-lock.json -nt "$STAMP" ]; then
    (cd web && npm ci --prefer-offline && touch node_modules/.sc-installed-at)
  fi

  # 前端构建：显式传 web 参数，或 dist 缺失（worktree 首次 go:embed 需要它）
  if [ ! -f web/dist/index.html ] || [ "$BUILD" = "web" ]; then
    (cd web && npm run build)
  fi

  # 构建期注入 HEAD（P-20261004-50）：/api/meta 的 commit 是 playwright 全局对账
  # 的事实源（打错实例套件前 fail-fast）——此前此脚本是裸 go build，commit 落
  # main.go 默认 'none'，对账守卫会因「未注入」恒跳过成死代码；build.sh 主链路同法
  COMMIT="$(git rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$COMMIT" ]; then
    go build -ldflags "-X main.commit=$COMMIT" -o "$BIN" .
  else
    go build -o "$BIN" .
  fi
fi
./"$BIN" start -d "$DATA" --no-tls -p "$PORT"

for i in $(seq 1 90); do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/"; then
    if [ "$SKIP_SEED" != "1" ]; then
      # 金态种子统一入口（幂等）：admin 初始化 + simple-coding 项目 + WSL 域
      # （主机记录/实例记录，环境缺失自动降级）——全新数据面重启后无需手工步骤
      # 即可跑全量 e2e，金态由种子脚本确定性重建（P-20261002-48）
      bash "$REPO/scripts/e2e-seed.sh" "http://127.0.0.1:$PORT" admin "$REPO" || true
    else
      echo "E2E_SEED_SKIPPED port=$PORT (external data dir)"
    fi
    echo "E2E_SERVER_READY port=$PORT"
    # 保鲜标记：记录本次构建的 HEAD——编排器据此判定 9999 主实例是否落后于
    # 最新合并代码并强制刷新（用户随时查看、其他会话依赖 9999）；槽位实例
    # 同写无害。构建自工作树快照，WIP 场景由调用方（编排器 1d）守卫
    git rev-parse HEAD > ".sc-tmp/inst-$PORT-built-head" 2>/dev/null || true
    exit 0
  fi
  sleep 1
done
echo "E2E_SERVER_NOT_READY port=$PORT" >&2
exit 1
