#!/bin/bash
# 由 simple-coding 远程部署功能通过 sshclient 上传并执行的 setup_claude.sh
# 由 ExecOptions.Env 注入：
#   ANTHROPIC_TOKEN（必填）
#   ANTHROPIC_BASE_URL（无默认值，部署前已由 Trigger 校验非空）
#   MODEL（远程 Claude Code 的 opus/sonnet/haiku/subagent 槽位统一使用此模型）
# 位置参数 $1 为目标用户名（默认 cld）
set -e

USER_NAME="${1:-cld}"

if [ -z "$ANTHROPIC_TOKEN" ]; then
  echo "[FAIL] ANTHROPIC_TOKEN is required" >&2
  exit 1
fi

# 默认值（仅在 env 未注入时生效）
: "${MODEL:=glm-5.3[1m]}"

echo "[1/6] checking root..."
if [ "$(id -u)" -ne 0 ]; then
  echo "[FAIL] must run as root" >&2
  exit 1
fi
echo "[OK] root confirmed"

echo "[2/6] ensuring user $USER_NAME..."
if ! id "$USER_NAME" &>/dev/null; then
  useradd -m -G wheel -s /bin/bash "$USER_NAME"
  echo "[OK] user created"
else
  echo "[OK] user already exists"
fi

echo "[3/6] creating /usr/bin/cld.sh..."
cat > /usr/bin/cld.sh <<'CLD_EOF'
#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
export CLAUDE_CODE_ALLOW_ALL=true
claude --dangerously-skip-permissions "$@"
CLD_EOF
chmod 755 /usr/bin/cld.sh
echo "[OK] cld.sh created"

# 非交互式 bash -lc 不会执行 .bashrc 里的 nvm 初始化
# （.bashrc 顶部通常有 non-interactive return 守卫），必须显式 source nvm.sh
echo "[4/6] ensuring Node.js via NVM..."

# Node 18+ 在较老 Linux 上依赖 libatomic.so.1，先确保系统已装（与 nvm 是否已装无关）
echo "[4/6.0] ensuring libatomic.so.1..."
if ! ldconfig -p 2>/dev/null | grep -q 'libatomic.so.1'; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y libatomic1
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y libatomic
  elif command -v yum >/dev/null 2>&1; then
    yum install -y libatomic
  else
    echo "[FAIL] no apt/yum/dnf to install libatomic" >&2
    exit 2
  fi
fi
echo "[OK] libatomic ready"

# 用 node -v 实际执行判断（而非 command -v npm）——npm 可能存在但 node 缺 libatomic 跑不起来
if ! sudo -u "$USER_NAME" bash -lc '. "$HOME/.nvm/nvm.sh" && node -v' &>/dev/null; then
  # 国内访问 GitHub 不稳定，nvm 仓库走 gitee 镜像，Node 二进制走 npmmirror 镜像
  echo "[4/6.1] downloading nvm install script (gitee mirror)..."
  sudo -u "$USER_NAME" bash -lc '
    export NVM_SOURCE=https://gitee.com/mirrors/nvm.git
    export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
    curl -fsSL https://gitee.com/mirrors/nvm/raw/v0.39.7/install.sh | bash
  ' || { echo "[FAIL] nvm install failed" >&2; exit 2; }
  echo "[4/6.2] installing Node.js 25 (npmmirror)..."
  sudo -u "$USER_NAME" bash -lc '
    export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node
    . "$HOME/.nvm/nvm.sh"
    nvm install 25
    nvm alias default 25
  ' || { echo "[FAIL] nvm install 25 failed" >&2; exit 2; }
fi
NODE_VERSION=$(sudo -u "$USER_NAME" bash -lc '. "$HOME/.nvm/nvm.sh" && node -v' 2>/dev/null || echo "unknown")
if [ "$NODE_VERSION" = "unknown" ]; then
  echo "[FAIL] node -v still fails after install" >&2
  exit 2
fi
echo "[OK] Node.js $NODE_VERSION"

echo "[5/6] installing Claude Code..."
if ! sudo -u "$USER_NAME" bash -lc '. "$HOME/.nvm/nvm.sh" && command -v claude' &>/dev/null; then
  echo "[5/6.1] configuring npm registry (npmmirror)..."
  sudo -u "$USER_NAME" bash -lc '. "$HOME/.nvm/nvm.sh" && npm config set registry https://registry.npmmirror.com'
  echo "[5/6.2] installing @anthropic-ai/claude-code..."
  sudo -u "$USER_NAME" bash -lc '. "$HOME/.nvm/nvm.sh" && npm install -g --no-progress @anthropic-ai/claude-code' \
    || { echo "[FAIL] npm install claude-code failed" >&2; exit 3; }
fi
CLAUDE_VERSION=$(sudo -u "$USER_NAME" bash -lc '. "$HOME/.nvm/nvm.sh" && claude --version' 2>/dev/null || echo "unknown")
echo "[OK] Claude Code $CLAUDE_VERSION"

echo "[6/6] configuring settings.json..."
sudo -u "$USER_NAME" \
  ANTHROPIC_TOKEN="$ANTHROPIC_TOKEN" \
  ANTHROPIC_BASE_URL="$ANTHROPIC_BASE_URL" \
  MODEL="$MODEL" \
  bash -lc '
    . "$HOME/.nvm/nvm.sh"
    set -e
    mkdir -p "$HOME/.claude"
    node -e "
      const fs=require(\"fs\"),os=require(\"os\"),path=require(\"path\");
      const file=path.join(os.homedir(),\".claude\",\"settings.json\");
      let cfg={};
      try{cfg=JSON.parse(fs.readFileSync(file,\"utf8\"))}catch(e){}
      cfg.env={
        ANTHROPIC_AUTH_TOKEN:process.env.ANTHROPIC_TOKEN,
        ANTHROPIC_BASE_URL:process.env.ANTHROPIC_BASE_URL, // 已由 Trigger 校验非空
        ANTHROPIC_DEFAULT_OPUS_MODEL:process.env.MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL:process.env.MODEL,
        ANTHROPIC_DEFAULT_HAIKU_MODEL:process.env.MODEL,
        CLAUDE_CODE_SUBAGENT_MODEL:process.env.MODEL,
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:\"1\",
        ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTS_THINKING:\"true\",
        API_TIMEOUT_MS:\"3000000\",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:\"1\"
      };
      fs.writeFileSync(file,JSON.stringify(cfg,null,2));
    "
    node -e "
      const fs=require(\"fs\"),os=require(\"os\"),path=require(\"path\");
      const file=path.join(os.homedir(),\".claude.json\");
      let cfg={};
      try{cfg=JSON.parse(fs.readFileSync(file,\"utf8\"))}catch(e){}
      cfg.hasCompletedOnboarding=true;
      fs.writeFileSync(file,JSON.stringify(cfg,null,2));
    "
  '
echo "[OK] settings.json configured"

echo "[DONE] all steps completed"
