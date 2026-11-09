#!/bin/bash
# e2e 实例种子统一入口：对运行中的实例幂等预置全部金态依赖（P-20261002-48）。
# 目标：全新数据面（.e2e-data 清空）重启后无需任何手工步骤即可跑全量 e2e——
# 「金态」由本脚本确定性重建，不再依赖跨运行残留的数据目录。
# 用法：bash scripts/e2e-seed.sh [BASE_URL] [PASSWORD] [REPO_ROOT]
#   BASE_URL 默认 http://localhost:9999；PASSWORD 默认 admin；REPO_ROOT 默认脚本上级
# 域划分（各域独立幂等，新增种子按域追加）：
#   1. 锁定初始化：setup/unlock admin（未初始化实例 setup，已初始化跳过）
#   2. 锁定功能关闭：setup 后默认 enabled=true（全新数据面=锁定态），裸 goto
#      不解锁的 spec（instance-sessions-overview 等）全数挂——历史金态即「锁定
#      关闭」，此处显式关齐（lock.spec 自启用/自还原，不受影响）
#   3. 项目卡片：simple-coding（面板/布局类 spec 进项目页都点这张卡）+
#      git-test 推送夹具（push-dialog 流，本地 Gitea 可达时才种）
#      项目种子按名 seed_project：缺失建卡、路径漂移迁移修复（PUT relocate）
#   4. WSL 域（WSL 主机记录 + wsl-server 实例记录）：委托 e2e-seed-wsl.sh，
#      环境缺失（Linux/CI）自动降级跳过，对应用例按既有环境门控 skip
set -e
BASE_URL="${1:-http://localhost:9999}"
PASSWORD="${2:-admin}"
# REPO_ROOT 归一为绝对路径（调用方传相对路径时按调用 cwd 展开）：注册进实例的
# 项目路径必须绝对——claude 项目级会话的存储目录按注册路径逐字编码（服务端
# EncodePath 原样替换分隔符），相对路径会让项目级 fixture 落错目录、范围查询落空
REPO_ROOT="${3:-$(cd "$(dirname "$0")/.." && pwd)}"
REPO_ROOT="$(cd "$REPO_ROOT" 2>/dev/null && pwd || echo "$REPO_ROOT")"
PORT="${BASE_URL##*:}"

# ---- 1. 锁定初始化（全新数据面首启未设密码：先 setup admin）----

if ! curl -s -X POST "$BASE_URL/api/lock/unlock" \
    -H 'Content-Type: application/json' -d "{\"password\":\"$PASSWORD\"}" | grep -q token; then
  curl -s -X POST "$BASE_URL/api/lock/setup" \
    -H 'Content-Type: application/json' -d "{\"password\":\"$PASSWORD\"}" > /dev/null || true
fi

SEED_TOKEN=$(curl -s -X POST "$BASE_URL/api/lock/unlock" \
  -H 'Content-Type: application/json' -d "{\"password\":\"$PASSWORD\"}" \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

# ---- 2. 锁定功能关闭（幂等；autoLock 一并关闭防长套件中途自动回锁）----
# P-20261008-13：触发条件是 enabled=true **或** autoLockEnabled=true——后者在
# 「不重启只重播」路径上可由 lock 域 spec 的部分更新 PUT（只带 enabled 不带
# autoLockEnabled，服务端 partial merge 保留旧值）遗留为 true，旧条件会漏过；
# 残留的 autoLockEnabled=true 会与后续任何部分启用的 enabled=true PUT 复合成
# 「页面解锁即武装闲置定时器」的中途回锁形态。enabled 已为 false 时的归零 PUT
# 不触发 RevokeAllTokens（wasEnabled=false），SEED_TOKEN 继续有效

if [ -n "$SEED_TOKEN" ]; then
  CFG=$(curl -s "$BASE_URL/api/lock/config" -H "X-Lock-Token: $SEED_TOKEN")
  ENABLED=$(printf '%s' "$CFG" | sed -n 's/.*"enabled":\([a-z]*\).*/\1/p')
  AUTOLOCK=$(printf '%s' "$CFG" | sed -n 's/.*"autoLockEnabled":\([a-z]*\).*/\1/p')
  if [ "$ENABLED" = "true" ] || [ "$AUTOLOCK" = "true" ]; then
    curl -s -X PUT "$BASE_URL/api/lock/config" \
      -H "X-Lock-Token: $SEED_TOKEN" -H 'Content-Type: application/json' \
      -d "{\"enabled\":false,\"currentPassword\":\"$PASSWORD\",\"autoLockEnabled\":false,\"autoLockMinutes\":120,\"tokenTTLMinutes\":120}" > /dev/null || true
    echo "seeded lock config: disabled (autoLock reset)"
  fi
fi

# ---- 3. 项目卡片（按名 seed_project：缺失建卡 / 路径漂移迁移修复）----

# seed_project <name> <abs-path>：查同名项目；无则建卡，有但路径异则 relocate
# （残留注册指向已删目录会拖垮依赖它的 spec，修复语义比按名跳过更稳）
seed_project() {
  local name="$1" path="$2"
  [ -n "$SEED_TOKEN" ] || return 0
  node - "$BASE_URL" "$SEED_TOKEN" "$name" "$path" << 'EOF'
const [base, token, name, path] = process.argv.slice(2);
function api(method, p, body) {
  return fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token }, body: body ? JSON.stringify(body) : undefined })
    .then(r => r.json().catch(() => ({})));
}
(async () => {
  const list = (await api('GET', '/api/projects')).data || [];
  const existing = list.find(x => x.name === name);
  if (!existing) {
    await api('POST', '/api/projects', { name, path });
    console.log(`seeded project: ${name}`);
  } else if (existing.path !== path) {
    const r = await fetch(`${base}/api/projects/${existing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token }, body: JSON.stringify({ path }) });
    console.log(`${r.ok ? 'relocated' : 'relocate failed'}: ${name} -> ${path}`);
  }
})().catch(e => { console.error(`seed_project ${name}: ${e.message}`); });
EOF
}

seed_project "simple-coding" "$REPO_ROOT"

# git-test 推送夹具：仓库按名向 Gitea 搜索发现（不写死 owner）；Gitea 不可达
# （多数机器）→ 跳过，push-dialog 自带可达性门控会同型 skip。夹具目录在
# .e2e-data/fixtures 下（随清空重建，目录存在性即克隆幂等键）
GITEA_URL="${E2E_GITEA_URL:-http://localhost:3000}"
if command -v git > /dev/null 2>&1 && curl -s -o /dev/null --max-time 3 "$GITEA_URL/"; then
  FIXTURE_DIR="$REPO_ROOT/.e2e-data/fixtures/git-test"
  if [ ! -d "$FIXTURE_DIR/.git" ]; then
    CLONE_URL=$(curl -s --max-time 5 "$GITEA_URL/api/v1/repos/search?q=git-test&limit=5" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);const r=(j.data||[]).find(x=>x.name==='git-test');console.log(r?r.clone_url:'')}catch(e){console.log('')}})")
    if [ -n "$CLONE_URL" ]; then
      mkdir -p "$(dirname "$FIXTURE_DIR")"
      git clone --quiet "$CLONE_URL" "$FIXTURE_DIR" 2>/dev/null || true
    fi
  fi
  if [ -d "$FIXTURE_DIR/.git" ]; then
    FIXTURE_JSON=${FIXTURE_DIR//\\//}
    seed_project "git-test" "$FIXTURE_JSON"
  fi
fi

# ---- 4. WSL 域种子（主机记录 + 实例记录；环境缺失自动降级）----
# SC_E2E_SEED_SKIP_WSL=1 显式跳过（P-20261005-187）：服务实例跑在 WSL 内的形态
# （wsl-e2e.sh）从 Linux 侧调本脚本时，经 interop 触达 wsl.exe 播种 sshd/实例记录
# 会把本应按环境门控 skip 的 remote-*/instance-* 用例误激活——该形态由调用方显式
# 跳过本域，金态语义与「Windows 实例有 WSL 记录、WSL 实例无」的既有门控基线一致
if [ "${SC_E2E_SEED_SKIP_WSL:-0}" = "1" ]; then
  echo "WSL domain seed skipped (SC_E2E_SEED_SKIP_WSL=1)"
else
  bash "$REPO_ROOT/scripts/e2e-seed-wsl.sh" "$BASE_URL" "$PASSWORD" || true
fi

echo "E2E_SEED_DONE port=$PORT"
