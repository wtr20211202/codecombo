#!/bin/bash
# release-export.sh —— 对外 GitHub 发布拷贝包导出器（P-20261025-2）。
#
# 协作模式：内网 Gitea 是唯一开发地；GitHub 仓是发布镜像。本脚本把「当前 git
# 追踪面」快照成一个干净、可构建、可直接整体拷入用户自建 GitHub 检出目录的
# 文件树（默认 release/public/），幂等可重跑——每次导出都是最新代码的完整快照，
# 不携带 git 历史（.goal-enhance/ 等数据面靠「只导追踪面」物理隔离）。
#
# 导出机制 = git ls-files 白名单 × 显式剔除过滤器（评审修正：目录黑名单裸拷必漏，
# 白名单制杜绝 licensegen.exe 等被追踪二进制与根目录散落物混入）。
# 剔除清单即「显式纳入/剔除决策清单」，每条注明缘由；新增内部文件默认不导出
# （白名单外的未追踪物本就不导），新增「想公开但被剔除家族命中」的文件时改本清单。
#
# 确定性后处理（导出树内的最小手术，随清单一起评审）：
#   web/package.json —— 摘除引用被剔除门禁脚本的 npm script 与 check 链挂载点
#   （check:duplicates / check:giant-files / check:doc-paths / check:proposal-format）。
#   只动 scripts 段不动 dependencies——lockfile 完整性零影响。
#   .gitignore —— 剔除内部会话产物目录条目。
#   site/ → docs/ —— 官网单页落发布仓 docs/ 根（GitHub Pages main/docs 模式，
#   P-20261101-1），并改写 ../docs/img/ 引用为 img/（截图事实源仍在 docs/img）。
#
# 导出后必须跑零放行敏感扫描门禁（scripts/release-scan.sh）才可对外拷贝；
# Pages 发布步骤见 docs/pages-publishing.md。
#
# 用法：bash scripts/release-export.sh [DEST]
#   DEST 缺省 release/public/（.gitignore 已忽略 release/）。
#   DEST 含 .git 时拒绝导出（防止误清空用户的 GitHub 检出目录）。

set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

DEST="${1:-release/public}"
DEST_ABS="$(mkdir -p "$DEST" && cd "$DEST" && pwd)"
case "$DEST_ABS" in
  "$REPO_ROOT") echo "FATAL: DEST 不能是仓库根" >&2; exit 2;;
esac
if [ -e "$DEST_ABS/.git" ]; then
  echo "FATAL: DEST 是 git 工作树（含 .git），拒绝清空——发布拷贝目标是纯净目录" >&2
  exit 2
fi

# ---------- 剔除决策清单（每条带缘由；命中即不导出） ----------
# 返回 0 = 剔除；1 = 导出。
excluded() {
  local p="$1"
  case "$p" in
    # 内部协作纪律全文（公开版 CONTRIBUTING.md 已从其提炼；本体含内部流水线机制）
    CLAUDE.md|AGENTS.md) return 0;;
    # ZCode 助手配置（含被追踪的 enhance-executor/enhance-fixer workflow）
    .zcode/*|.zcodeignore) return 0;;
    # NOTICE 双轨合一：第三方附表已并入单一 NOTICE（2026-10-26）
    NOTICE.md) return 0;;
    # 英文 README 被「README.md=英文主 + docs/README.zh-CN.md=中文版」结构取代
    README_EN.md) return 0;;
    # 被追踪的本地构建二进制（源码 tools/licensegen/main.go 照常导出）
    licensegen.exe) return 0;;
    # 增强提案流水线（取号/审计/收割/槽位——内部多会话协作机制）
    scripts/enhance-*) return 0;;
    # 内部流水线门禁：提案格式/重复代码基线/巨型文件基线/文档引用路径
    # （后三者的基线 json 是内部台账；doc-paths 失明守卫按内部文档面标定，
    #  公开子集上必假红，故随 npm script 一并摘除）
    scripts/check-proposal-format.mjs|scripts/check-duplicates.mjs|\
    scripts/duplicates-baseline.json|scripts/check-giant-files.mjs|\
    scripts/giant-files-baseline.json|scripts/check-doc-paths.mjs) return 0;;
    # 内网/WSL 拓扑绑定的验证设施（真实内网 IP、盘符路径、72h 巡更编排）
    scripts/dsh-e2e-check.sh|scripts/wsl-e2e.sh|scripts/wsl-verify.sh|\
    scripts/e2e-cross.sh|scripts/linux-test.sh) return 0;;
    # 内部流程编排：worktree 槽位/净面重跑/真实实例重启/流水线推送封装
    scripts/e2e-worktree.sh|scripts/e2e-rerun-pristine.sh|\
    scripts/restart-real.sh|scripts/git-push-origin.sh) return 0;;
    # 内部性能压测台（含压测结果数据）
    scripts/perf/*) return 0;;
    # docs 内部过程文档（内部台账/审计快照/巡检记录——对公众零价值且含内部语境）
    docs/duplicate-triage-20261006.md|docs/e2e-trash-ui-24-0.md|\
    docs/e2e-trash-ui-25-0.md|docs/giant-files-20261007.md|\
    docs/license-audit-20261006.md|docs/license-audit-20261026.md|\
    docs/lint-baseline.md|docs/perf-report.md|docs/polish-roadmap.md|\
    docs/upgrade-compat-audit-20261005.md|docs/workflow-smoke-test.md) return 0;;
    # docs/design 内部过程稿（路线图/能力审计/打磨轮次/轮次台账）
    docs/design/continuation-roadmap.md|docs/design/hidden-capabilities-audit.md|\
    docs/design/polish-rounds.md|docs/design/rounds-ledger.md) return 0;;
    *) return 1;;
  esac
}

# ---------- 导出：清空重灌（真幂等——剔除清单收紧后旧残留不滞留） ----------
echo "==> Export destination: $DEST_ABS"
rm -rf "$DEST_ABS"
mkdir -p "$DEST_ABS"

total=0; kept=0; dropped=0
DROPPED_LIST="$(dirname "$DEST_ABS")/export-dropped.txt"
: > "$DROPPED_LIST"
while IFS= read -r f; do
  total=$((total + 1))
  if excluded "$f"; then
    dropped=$((dropped + 1))
    printf '%s\n' "$f" >> "$DROPPED_LIST"
    continue
  fi
  kept=$((kept + 1))
  mkdir -p "$DEST_ABS/$(dirname "$f")"
  cp -p "$f" "$DEST_ABS/$f"
done < <(git ls-files -z | tr '\0' '\n')

# ---------- 确定性后处理 ----------
# 1) web/package.json：只删 npm scripts 键与 check/check:fast 链里的挂载点；
#    dependencies 零改动（package-lock.json 完整性不受影响，公开仓 npm ci 可用）。
echo "==> Post-process: web/package.json (strip gates whose scripts are excluded)"
node - "$DEST_ABS/web/package.json" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const pj = JSON.parse(fs.readFileSync(file, 'utf8'));
const removed = ['check:duplicates', 'check:giant-files', 'check:doc-paths', 'check:proposal-format'];
const s = pj.scripts || {};
for (const k of removed) delete s[k];
for (const k of Object.keys(s)) {
  for (const r of removed) {
    s[k] = s[k].replace(new RegExp(`\\s*&&\\s*npm run ${r}\\b`, 'g'), '');
  }
}
fs.writeFileSync(file, JSON.stringify(pj, null, 2) + '\n');
console.log(`    stripped: ${removed.join(', ')}`);
NODE

# 2) .gitignore：剔除内部会话产物目录条目（公开仓无此等目录，留着只会引来
#    「这是什么」的疑问）。.sc-tmp/ 与 .e2e-data/ 保留——导出的 e2e 编排脚本
#    会写这两处，公开贡献者跑 e2e 需要它们保持被忽略。
echo "==> Post-process: .gitignore (drop internal session-artifact rules)"
node - "$DEST_ABS/.gitignore" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const isDrop = (l) => /^\.?(superpowers|goal-polish|goal-enhance)\/\S*\s*$/.test(l.trim()) || /^\.?(superpowers|goal-polish|goal-enhance)$/.test(l.trim());
const lines = fs.readFileSync(file, 'utf8').split('\n');
const kept = [];
for (let i = 0; i < lines.length; i++) {
  if (isDrop(lines[i])) {
    // 连带吞掉紧邻的纯注释行（如「# Superpowers brainstorm 临时文件」），不留孤儿注释
    while (kept.length && /^#[^#]*$/.test(kept[kept.length - 1].trim())) kept.pop();
    continue;
  }
  kept.push(lines[i]);
}
fs.writeFileSync(file, kept.join('\n'));
NODE

# 3) 官网落位（P-20261101-1）：site/ → 发布仓 docs/ 根（GitHub Pages main/docs
#    模式的站点根即 docs/，Pages 配置定死不靠映射猜）。源码仓里 site/index.html
#    以 ../docs/img/* 引用截图（docs/img 唯一事实源，只引用不复制）；落到发布
#    树 docs/index.html 后该相对路径失效（Pages 站点根 = docs/），故改写为
#    img/*——发布树里 docs/img/ 原样在场（导出白名单自动带上），一次改写即通。
#    冲突护栏：docs/index.html 与 docs/assets/ 是 site 专属落位——内部文档
#    将来若新增同名路径会静默覆盖官网，先炸出来。
if [ ! -f "$DEST_ABS/site/index.html" ]; then
  echo "FATAL: 导出树缺 site/index.html——官网源未入库或被剔除" >&2
  exit 2
fi
if [ -e "$DEST_ABS/docs/index.html" ] || [ -e "$DEST_ABS/docs/assets" ]; then
  echo "FATAL: docs/index.html|docs/assets 已被内部文档占用——site 落位会覆盖它，先改内部文档路径" >&2
  exit 2
fi
echo "==> Post-process: site/ -> docs/ (Pages main/docs mode landing)"
cp -R "$DEST_ABS/site/." "$DEST_ABS/docs/"
node - "$DEST_ABS/docs" <<'NODE'
const fs = require('fs');
const path = require('path');
const root = process.argv[2];
const files = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p);
    else if (/\.(html|css|js)$/.test(name)) files.push(p);
  }
};
walk(root);
let changed = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  // 源码态 ../docs/img/* → 发布树 docs/ 根态 img/*
  const out = src.replace(/\.\.\/docs\/img\//g, 'img/');
  if (out !== src) {
    fs.writeFileSync(f, out);
    changed++;
  }
}
console.log(`    img refs rewritten in ${changed} file(s)`);
NODE

# ---------- 导出树自检：金丝雀（不得混入）+ 骨架（必须在场） ----------
fail=0
for canary in CLAUDE.md AGENTS.md .zcodeignore NOTICE.md README_EN.md licensegen.exe \
              .zcode/workflows/enhance-executor.dwf.ts \
              scripts/enhance-next-id.sh scripts/check-duplicates.mjs scripts/duplicates-baseline.json \
              scripts/wsl-verify.sh scripts/restart-real.sh scripts/perf/api_perf.py \
              docs/lint-baseline.md docs/license-audit-20261006.md docs/design/rounds-ledger.md; do
  if [ -e "$DEST_ABS/$canary" ]; then
    echo "FATAL: 剔除物泄漏进导出树：$canary" >&2; fail=1
  fi
done
for must in main.go go.mod go.sum LICENSE NOTICE README.md CONTRIBUTING.md SECURITY.md CHANGELOG.md \
            build.sh build.bat .gitignore .golangci.yml \
            site/index.html site/assets/site.css site/assets/site.js site/assets/og-image.png \
            docs/index.html docs/assets/site.css docs/img/project-editor.png \
            docs/whatsnew.md docs/EXTENSION_POINTS.md docs/README.zh-CN.md docs/adr/README.md \
            server/api/tools/dsh.go server/share/assets/xterm.js web/public/fonts/LICENSE-JetBrainsMono.txt \
            web/package.json web/package-lock.json scripts/e2e-seed.sh scripts/check-event-names.mjs \
            scripts/release-export.sh scripts/release-scan.sh scripts/release-publish.sh \
            npm/cli/bin/codecombo.js scripts/npm-stage.mjs \
            scripts/install.sh scripts/install.ps1 \
            .github/workflows/ci.yml .github/workflows/release.yml .github/ISSUE_TEMPLATE/bug_report.md; do
  if [ ! -e "$DEST_ABS/$must" ]; then
    echo "FATAL: 导出树缺骨架文件：$must" >&2; fail=1
  fi
done
[ "$fail" = 0 ] || { echo "==> Export FAILED (see FATAL lines above)" >&2; exit 1; }

# ---------- 运行元信息（写 release/ 根，不进 public/ 拷贝树） ----------
COMMIT=$(git rev-parse HEAD 2>/dev/null || echo unknown)
{
  echo "source-commit: $COMMIT"
  echo "exported-at: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "files: $kept (tracked $total, excluded $dropped)"
  echo "next: bash scripts/release-scan.sh $DEST"
} > "$DEST_ABS/../export-info.txt"

echo "==> Exported $kept files (tracked $total, excluded $dropped) -> $DEST_ABS"
echo "==> docs/ 导出面（每次导出过目一眼，新增内部文档默认不导、勿误放行）:"
find "$DEST_ABS/docs" -name '*.md' | sed "s|$DEST_ABS/||" | sort | sed 's/^/    /'
echo "==> scripts/ 导出面:"
find "$DEST_ABS/scripts" -type f | sed "s|$DEST_ABS/||" | sort | sed 's/^/    /'
echo "==> Next: bash scripts/release-scan.sh $DEST   （零放行敏感扫描 + manifest，通过后才可拷贝）"
