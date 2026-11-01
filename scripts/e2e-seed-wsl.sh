#!/bin/bash
# 预置 e2e 所需的 WSL 域种子到目标实例（幂等，可重复执行；环境缺失时降级跳过不报错）：
#   1. WSL 主机记录（remote-* 渲染/分组/实流用例依赖，SFTP root@127.0.0.1 pem 认证，
#      端口随播种形态：legacy 共享 sshd 恒 :23；SC_E2E_SSH_PORT 槽位专用实例为派生端口）。
#      legacy 形态额外做 Windows 侧可达探测：:23 依赖机器上的 netsh portproxy→WSL:23
#      转发，缺失时回落到既有惯例转发口（默认 2222→WSL:22，可用
#      E2E_WSL_HOST_PORT_FALLBACKS 覆盖）并以该口落记录——记录端口与实际认证目标
#      必须一致，否则 spec 探针按记录拨号必拒（open tunnel 502）。:22/:23 共用
#      root authorized_keys，下方 legacy 装钥同时覆盖两者
#      密钥自供给（spec 自带凭据，与用户真实凭据无关）：.e2e-data/keys/wsl-e2e 缺失时
#      ssh-keygen 生成 e2e 专用 ed25519（注释 sc-e2e-seed）。legacy 路径把公钥装入
#      「sshd 监听 :23 的运行中发行版」root authorized_keys（纯追加去重，不动用户
#      已有授权键）；槽位路径（SC_E2E_SSH_PORT，P-20261004-115）改为起每发行版
#      专用 sshd 实例 + 独立授权键文件，不碰共享 authorized_keys（并行门禁隔离）
#   2. wsl-server 远程实例记录（instance-* 切换/总览用例依赖，指向 WSL 内 9998 服务）：
#      经 wsl.exe 取 WSL IP 并探测可达后按名 upsert（E2E_WSL_INSTANCE_URL 可覆盖地址）
# 用法：bash scripts/e2e-seed-wsl.sh [BASE_URL] [PASSWORD]
#   BASE_URL 默认 http://localhost:9999；PASSWORD 默认 admin
# 环境探测全部容错：无 wsl.exe（Linux/CI）或发行版未运行时对应种子跳过，
# 对应用例按既有环境门控 skip（与「真实凭据属用户域」约束一致，不在本脚本强行造环境）
set -e
BASE="${1:-http://localhost:9999}"
PASSWORD="${2:-admin}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_DIR="$REPO_ROOT/.e2e-data/keys"
KEY_FILE="$KEY_DIR/wsl-e2e"
# 注入 authorized_keys 的行注释。默认维持历史共享标记；多 worktree 槽位并行
# 跑 remote-* 门禁时请各自传 SC_E2E_KEY_COMMENT=<唯一标记>——共享标记下
# install_pubkey 的「删同标记行再追加」是 last-writer-wins，实测并行槽位互相
# 顶掉对方密钥（auth rejected 间歇失败，sc-wt-2/sc-wt-4 双双踩中）
KEY_COMMENT="${SC_E2E_KEY_COMMENT:-sc-e2e-seed}"
# 槽位专用 sshd 端口（P-20261004-115）：空 = legacy 共享 :23 行为（在途门禁兼容回落，
# 见任务书编排器注——改动合并前其他槽位仍走旧路径）；非空 = 槽位隔离路径。端口由
# e2e-restart.sh 按槽位派生（2300+槽位号，slots.json 稳定映射；不取提案原文的
# 2222+槽位号——2222 被本机 netsh portproxy→WSL:22 惯例占用，remote-git-compare
# spec 的 FALLBACK_PORT 同源），编排器也可显式设 SC_E2E_SSH_PORT 覆盖
SSH_PORT="${SC_E2E_SSH_PORT:-}"
INSTANCE_NAME="wsl-server"
INSTANCE_URL_OVERRIDE="${E2E_WSL_INSTANCE_URL:-}"

# ---------- 工具函数 ----------

# 是否存在可用的 wsl.exe 且有运行中发行版（Linux/CI 无）
# wsl.exe 列表输出为 UTF-16LE：去 \0 与行尾 \r，保留 \n 供逐行分词
have_wsl() {
  command -v wsl.exe > /dev/null 2>&1 || return 1
  wsl.exe -l -q --running 2>/dev/null | tr -d '\0\r' | grep -q .
}

# 列出「sshd 正在监听 :23」的运行中发行版（e2e 主机记录的认证目标）
distros_with_sshd_23() {
  for d in $(wsl.exe -l -q --running 2>/dev/null | tr -d '\0\r'); do
    [ -n "$d" ] || continue
    # -e 直连执行避免 MSYS 对绝对路径参数改写；ss -tln 判 :23 监听（任何地址）
    if wsl.exe -d "$d" -e sh -c 'ss -tln 2>/dev/null | grep -q ":23 "' 2>/dev/null; then
      echo "$d"
    fi
  done
}

# 把公钥装入指定发行版 root authorized_keys（幂等）：已含该键则跳过（kept）；
# 否则直接追加（installed）——不做「删同标记行」：并行槽位各自持钥共存，
# 删他槽标记行会把对方门禁打回 auth rejected（实测踩坑）；遗留多行由各槽
# 自键幂等去重（grep -qF 全串比对），总量以槽位数收敛。用户已有授权键不受影响。
# 仅 installed 时打日志：kept 高频出现（每次 restart 都播种），刷屏无益
install_pubkey() {
  local distro="$1" verdict
  verdict=$(wsl.exe -d "$distro" -e sh -c 'p=$(cat); f=/root/.ssh/authorized_keys; mkdir -p /root/.ssh; touch "$f"; chmod 600 "$f"; if grep -qF "$p" "$f"; then echo kept; else printf "%s\n" "$p" >> "$f"; echo installed; fi' < "$KEY_FILE.pub" 2>/dev/null | tr -d '\0\r\n')
  [ "$verdict" = "installed" ] && echo "pubkey installed into $distro (root@:23)"
  return 0
}

# Windows 侧 TCP 可达探测（Git Bash/MSYS 支持 /dev/tcp；Linux CI 无 wsl 不走此路）
port_open() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

# ---------- 1. 密钥自供给 ----------

if ! command -v ssh-keygen > /dev/null 2>&1; then
  echo "ssh-keygen unavailable, skip WSL domain seed" >&2
  exit 0
fi

if [ ! -f "$KEY_FILE" ]; then
  mkdir -p "$KEY_DIR"
  ssh-keygen -t ed25519 -N '' -C "$KEY_COMMENT" -f "$KEY_FILE" -q
  echo "e2e key generated: $KEY_FILE"
fi

# 槽位专用 sshd 实例（SSH_PORT 隔离路径，P-20261004-115）。并行门禁共享 :23 sshd
# 的两处根因在此一并消除：①共享 authorized_keys 互顶（专用实例 AuthorizedKeysFile
# 按端口独立，实例互不见他槽钥匙）；②:23 端口漂移与 MaxStartups 连接风暴互踩
# （专用端口 + 节流放宽）。要点：
#   - 幂等：配置内容只依赖端口、重写恒等价；公钥 grep -qF 全串去重；端口已监听不重复起
#   - 每个「运行中」发行版都补装钥：WSL2 各发行版共享网络命名空间，:PORT 监听态
#     全局可见，但授权键文件在各自 mount ns、持有者发行版不可辨——全量补装幂等收敛
#   - 不碰共享 authorized_keys（根因消除，而非纯追加缓解）
#   - Windows 侧端口被机器惯例占用（netsh portproxy 等）会截走 localhost 转发，
#     仅告警不阻塞——实流用例按既有环境门控 skip
seed_slot_sshd() {
  local port="$1" d verdict ready=0
  for d in $(wsl.exe -l -q --running 2>/dev/null | tr -d '\0\r'); do
    [ -n "$d" ] || continue
    # -e 直连执行免 MSYS 对绝对路径参数改写；公钥经 stdin 传入免引号转义。
    # 端口占用探测用 bash 内建 /dev/tcp（发行版可不装 iproute2 的 ss）
    verdict=$(wsl.exe -d "$d" -e bash -c '
      port="$1"
      command -v sshd >/dev/null 2>&1 || { echo NO_SSHD; exit 0; }
      dir=/root/.ssh; cfg="$dir/sshd-e2e-$port.conf"; keys="$dir/authorized_keys-e2e-$port"
      mkdir -p "$dir" /run/sshd
      ssh-keygen -A >/dev/null 2>&1   # 主机钥缺席时生成（幂等，已齐则零操作）
      cat > "$cfg" <<CONF
# sc-e2e per-slot sshd (P-20261004-115) - regenerated idempotently by e2e-seed-wsl.sh
Port $port
ListenAddress 0.0.0.0
AuthorizedKeysFile $keys
PidFile $dir/sshd-e2e-$port.pid
MaxStartups 30
Subsystem sftp internal-sftp
CONF
      chmod 600 "$cfg"
      p=$(cat)
      touch "$keys"; chmod 600 "$keys"
      grep -qF "$p" "$keys" || printf "%s\n" "$p" >> "$keys"
      if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then
        echo LISTENING
      elif "$(command -v sshd)" -f "$cfg" 2>/dev/null; then
        echo STARTED
      else
        echo START_FAILED
      fi
    ' _ "$port" < "$KEY_FILE.pub" 2>/dev/null | tr -d '\0\r\n')
    case "$verdict" in
      STARTED|LISTENING) ready=1 ;;
      NO_SSHD) echo "  $d: sshd binary absent, skip" ;;
      START_FAILED) echo "  $d: per-slot sshd start failed, skip" ;;
    esac
  done
  if [ "$ready" = 1 ]; then
    echo "per-slot sshd ready on :$port (root, dedicated authorized_keys)"
  elif netstat.exe -ano 2>/dev/null | grep -q ":$port .*LISTENING"; then
    # Windows 侧端口占用核对放在失败分支：ready=0 且 Windows 有监听 → 大概率被
    # netsh portproxy 等机器惯例截走 localhost 转发（自身 WSL 中继的监听不会走
    # 到这——发行版内在监听会先给出 ready=1）
    echo "no running distro hosts per-slot sshd on :$port, Windows side already listening there (portproxy?) — forward shadowed (remote-* 实流用例将按环境门控 skip)"
  else
    echo "no running distro could host per-slot sshd on :$port (remote-* 实流用例将按环境门控 skip)"
  fi
}

if have_wsl; then
  if [ -n "$SSH_PORT" ]; then
    seed_slot_sshd "$SSH_PORT"
  else
    MATCHED=0
    for d in $(distros_with_sshd_23); do
      install_pubkey "$d" && MATCHED=1
    done
    [ "$MATCHED" = "1" ] || echo "no running distro with sshd on :23, skip pubkey install"
  fi
else
  echo "wsl.exe unavailable, skip pubkey install (remote-* 实流用例将按环境门控 skip)"
fi

# ---------- 2. 解析 wsl-server 实例地址 ----------

# 默认指向 WSL 默认发行版内 9998 systemd 服务；IP 随 WSL 重启漂移，
# 故每次播种时解析（而非固化在记录里）。WSL 不可用/服务不可达 → 置空跳过
INSTANCE_URL=""
if [ -n "$INSTANCE_URL_OVERRIDE" ]; then
  INSTANCE_URL="$INSTANCE_URL_OVERRIDE"
elif have_wsl; then
  WSL_IP="$(wsl.exe -e sh -c 'hostname -I' 2>/dev/null | tr -d '\0\r\n' | awk '{print $1}')"
  if [ -n "$WSL_IP" ] && curl -s -o /dev/null --max-time 3 "http://$WSL_IP:9998/"; then
    INSTANCE_URL="http://$WSL_IP:9998"
  else
    echo "WSL instance :9998 unreachable (ip=$WSL_IP), skip wsl-server instance seed"
  fi
fi

# ---------- 2.5 主机记录端口：legacy :23 不可达时回落机器既有转发 ----------
# legacy 形态的记录端口恒 :23，前提是 Windows 侧存在 netsh portproxy→WSL:23
# （或等价转发）。该转发缺失时 127.0.0.1:23 直接 ECONNREFUSED，remote-tunnel-*
# 的 open tunnel 一律 502（run24 实测：本机只有 2222→WSL:22 惯例转发，
# CLAUDE.md 同记）。:22/:23 共用 root authorized_keys（上方 legacy 装钥同时
# 覆盖两者），故 legacy 下探测 :23 不通时回落到可用的惯例转发口，且记录端口
# 与实际认证目标保持一致；显式 SC_E2E_SSH_PORT（槽位隔离路径）不参与回落。
# 候选可用 E2E_WSL_HOST_PORT_FALLBACKS（空白分隔）覆盖，默认 2222。
HOST_PORT="${SSH_PORT:-23}"
if [ -z "$SSH_PORT" ] && have_wsl && ! port_open 23; then
  for p in ${E2E_WSL_HOST_PORT_FALLBACKS:-2222}; do
    if port_open "$p"; then
      HOST_PORT="$p"
      echo "legacy :23 unreachable from Windows, use existing WSL forward :$p for host record"
      break
    fi
  done
fi

# ---------- 3. WSL 主机记录 + wsl-server 实例记录（node 走 API） ----------

node - "$BASE" "$PASSWORD" "$KEY_FILE" "$INSTANCE_NAME" "$INSTANCE_URL" "$HOST_PORT" << 'EOF'
const fs = require('fs'), http = require('http');
const [base, password, keyFile, instanceName, instanceUrl, hostPort] = process.argv.slice(2);
function api(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: new URL(base).hostname, port: new URL(base).port || 80, path, method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers, data ? { 'Content-Length': Buffer.byteLength(data) } : {}) }, res => {
      let s = ''; res.on('data', d => s += d); res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
(async () => {
  const unlock = await api('POST', '/api/lock/unlock', { password });
  const token = JSON.parse(unlock.body).token;
  const headers = { 'X-Lock-Token': token };

  // WSL 主机记录：按名查找；存在且为 e2e 规范形态（root@127.0.0.1 pem）时刷新
  // pem 与当前密钥保持同步（数据面换钥自愈）；端口同属 e2e 域随播种形态刷新
  // （legacy 共享路径恒 23，槽位专用实例为派生端口——记录端口是 spec 探针的
  // 事实源，必须与实际认证目标一致；PUT 端口级联清 TOFU 钉扎，e2e 无感）。
  // 用户自定义形态（同名但配置异）视为用户域配置不动。不存在则按规范形态创建
  // 记录端口 = 实际认证目标：显式槽位端口优先；legacy 由 bash 侧探测结果
  // （:23 或可用回落口）传入，二者都不可达时保持历史 :23
  const slotPort = Number(process.env.SC_E2E_SSH_PORT) || Number(hostPort) || 23;
  const pem = fs.readFileSync(keyFile, 'utf8');
  const canonical = h => h && h.user === 'root' && h.host === '127.0.0.1' && h.authType === 'pem';
  const hosts = JSON.parse((await api('GET', '/api/remotehosts', null, headers)).body).data || [];
  const wslHost = hosts.find(h => h.name === 'WSL');
  if (!wslHost) {
    const created = await api('POST', '/api/remotehosts', {
      name: 'WSL', host: '127.0.0.1', port: slotPort, user: 'root', authType: 'pem', protocol: 'sftp', pemContent: pem,
    }, headers);
    if (created.status !== 200) { console.error('WSL host seed failed:', created.body); process.exit(1); }
    console.log('WSL host provisioned');
  } else if (canonical(wslHost)) {
    const patch = { pemContent: pem };
    if (Number(wslHost.port) !== slotPort) patch.port = slotPort;
    await api('PUT', `/api/remotehosts/${wslHost.id}`, patch, headers);
    console.log(Number(wslHost.port) !== slotPort
      ? `WSL host port -> ${slotPort} (pem refreshed)`
      : 'WSL host already provisioned (pem refreshed)');
  } else {
    console.log('WSL host exists with custom config, left untouched');
  }

  // wsl-server 实例记录：地址为空（WSL 未运行/Linux）则跳过，
  // instance-* 用例按既有环境门控 skip
  if (!instanceUrl) { console.log('wsl-server instance skipped (no URL resolved)'); return; }
  const instances = JSON.parse((await api('GET', '/api/instances', null, headers)).body).data || [];
  const existing = instances.find(i => i.name === instanceName);
  if (existing && existing.url === instanceUrl) { console.log('wsl-server instance already provisioned'); return; }
  if (existing) {
    await api('PUT', `/api/instances/${existing.id}`, { url: instanceUrl }, headers);
    console.log(`wsl-server instance updated -> ${instanceUrl}`);
  } else {
    const created = await api('POST', '/api/instances', { name: instanceName, url: instanceUrl }, headers);
    if (created.status !== 200) { console.error('wsl-server instance seed failed:', created.body); process.exit(1); }
    console.log(`wsl-server instance provisioned -> ${instanceUrl}`);
  }
})().catch(e => { console.error(e.message); process.exit(1); });
EOF
