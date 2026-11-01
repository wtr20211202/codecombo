#!/bin/bash
# release-scan.sh —— 发布拷贝包敏感扫描零放行门禁 + manifest 哈希闭环（P-20261025-2）。
#
# 对导出树（scripts/release-export.sh 产物，默认 release/public/）做敏感载荷扫描：
# 任一命中即退出码 1（零放行）——启发式不穷尽，通过后仍须按任务书做一轮人工抽查
# （本脚本结尾打印高危抽查清单）。全部通过后生成 release/manifest.sha256（导出树
# 全量 SHA-256，迁移拷贝后可对账「拷的是否 = 扫的是否」）。
#
# 模式库分两层（按仓库实证标定，宁缺毋滥——模式过宽会对 _test.go 合法夹具海误报，
# 门禁红成常态就没人看了）：
#   HARD（零放行，任一命中即红）：
#     1. 开发环境真实路径：worktree 根目录名（点前缀 enhance-wt 形态，见 PATTERN 区
#        bracket 写法）；本仓曾泄内网网段的点分前缀
#     2. 个人邮箱：git 历史作者的两个 gmail 地址（内容面零存量，命中即回流）；
#        @local 形态是测试夹具惯例（user.email=e2e@…），不在此列
#     3. 开发机绝对路径：盘符 workspace 目录、用户目录、/d 与 /home 挂载形态
#     4. sc- token 形态：scl_ / sca_ / sc_ 前缀接 16+ 位连续 token 字符
#        （真实签发 token 形态；文档惯用的 sc_xxx/scl_xxx 占位串不误伤）
#   INFO（只列出不拦）：
#     - 内部流水线目录名（.goal-* / .sc-tmp / .superpowers / .zcodeignore）——
#       目录内容物理不可入导出树（追踪面白名单），「提及目录名」是内部惯例残留
#       而非敏感载荷，逐条人工判断是否需要措辞清理
#
# 用法：bash scripts/release-scan.sh [DIR]   （DIR 缺省 release/public）

set -euo pipefail
cd "$(dirname "$0")/.."
DIR="${1:-release/public}"
if [ ! -d "$DIR" ]; then
  echo "FATAL: $DIR 不存在——先跑 scripts/release-export.sh" >&2
  exit 2
fi

# —— HARD 模式库（bracket 化写法规避自匹配：[.] 不匹配自身文本里的点；注释不写点分字面）——
PATTERNS=(
  '172[.]16[.]5[0-9][.]'                          # 内网真实网段（53 系开发段，留两位余量）
  '[.]enhance-wt'                                 # 开发机 worktree 根目录名（点前缀）
  'zhouchangjian2016[@]gmail[.]com|wtr20211202[@]gmail[.]com'
  'D:[\\]workspace|[/]d/workspace|[C]:[\\]Users[/]zcj|[/]home/zcj'
  '\bs[cal]_[A-Za-z0-9]{16,}'                     # sc_/sca_/scl_ 真实 token 形态
)
INFO_PATTERN='[.]goal-enhance|[.]goal-polish|[.]sc-tmp/|[.]superpowers|[.]zcodeignore'

total_hits=0
for pat in "${PATTERNS[@]}"; do
  # -I 跳二进制（快照 png 等）；-n 带行号；文本面全量
  hits=$(grep -rInE "$pat" "$DIR" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    count=$(printf '%s\n' "$hits" | wc -l)
    total_hits=$((total_hits + count))
    echo "=== HIT [$pat] x$count ==="
    printf '%s\n' "$hits" | head -20 | sed 's/^/    /'
    [ "$count" -gt 20 ] && printf '    ... (%d more)\n' $((count - 20))
  fi
done

if [ "$total_hits" -gt 0 ]; then
  echo "" >&2
  echo "release-scan: $total_hits 处敏感命中——零放行门禁拒绝，处置后重扫" >&2
  exit 1
fi

# —— INFO 层：内部惯例目录名提及（不拦，人工过目决定是否措辞清理）——
info_hits=$(grep -rInE "$INFO_PATTERN" "$DIR" 2>/dev/null | grep -vE '^release-scan\.sh|scripts/release-scan\.sh' || true)
if [ -n "$info_hits" ]; then
  echo "--- INFO（内部目录名提及 x$(printf '%s\n' "$info_hits" | wc -l)，不拦，逐条过目）---"
  printf '%s\n' "$info_hits" | sed 's/^/    /'
fi

# —— manifest 哈希闭环（全过才生成；sha256sum Git Bash/Linux 通用）——
MANIFEST="$(dirname "$(cd "$DIR" && pwd)")/manifest.sha256"
( cd "$DIR" && find . -type f ! -path './.git/*' -print0 | sort -z \
    | xargs -0 sha256sum ) > "$MANIFEST"
echo "release-scan: 0 hits —— 零放行通过；manifest: $MANIFEST ($(wc -l < "$MANIFEST") files)"

# —— 人工抽查兜底（启发式非穷尽，首版必做；打印即交接）——
cat <<'CHECKLIST'

人工抽查清单（启发式之外的最后防线，逐项目视一遍再对外拷贝）：
  [ ] docs/ 全目录        —— 内部过程文档是否已全部剔除、公开子集无内部语境段落
  [ ] scripts/ 全目录     —— 是否残留内部流水线/内网拓扑脚本
  [ ] README.md + docs/README.zh-CN.md —— 无改名史/无内部提案编号/无内网信息
  [ ] .github/ 两个 workflow 与 issue 模板 —— 可在公开仓直接工作
  [ ] CHANGELOG.md / NOTICE —— 与公开版本叙事一致、第三方附表齐全
  [ ] web/e2e/ 种子与夹具 —— 无真实凭据/真实主机
  [ ] git grep -iE '(password|secret|token)\s*[:=]\s*"[^"]+"' -- server/ 抽样复核
CHECKLIST
