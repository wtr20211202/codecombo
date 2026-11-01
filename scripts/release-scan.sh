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
  'zhouchangjian2016[@]gmail[.]com|wtr20211202[@]gmail[.]com'  # 新旧两个历史作者邮箱都拦
  'D:[/\\]workspace[/\\](go[/\\]coding|github)|[/]d/workspace|[C][:][/\\]Users[/\\]zcj|[/]home/zcj'  # 真实盘面布局，分隔符两形态都拦（泛例 D:/workspace/my-project 类文档示例不拦；尾段曾只写 [/] 漏拦反斜杠形态；C: 必须写成 [C][:]——裸「C:」在 ugrep 下触发其 GLOB:PATTERN 前缀语法被拆参静默假绿）
  '(^|[^A-Za-z0-9])([s]ca_|[s]cl_|[s]c_)[A-Za-z0-9]{16,}'  # sc_/sca_/scl_ 真实 token 前缀（旧写法 s[cal]_ 只匹配 sc_/sa_/sl_，sca_/scl_ 从未拦过；\b 是 GNU 扩展 ugrep 不支持，边界改 (^|[^A-Za-z0-9])）
)
INFO_PATTERN='[.]goal-enhance|[.]goal-polish|[.]sc-tmp/|[.]superpowers|[.]zcodeignore'

# —— 门禁自检（防静默假绿）：本机 grep 若与 HARD 库存在方言失配（如 ugrep 的
# GLOB:PATTERN 前缀解析、类内反斜杠差异），曾让整条模式 0 命中而门禁照常放行。
# 金丝雀逐类各放一行真实形态，13 行必须全数命中，否则响亮拒绝。canary 字面量
# 在源码里全部断写（引号拼接/变量），防 HARD 扫描命中本脚本自身。
B=$(printf '\134')
SCAN_CANARY=$(mktemp -d)
trap 'rm -rf "$SCAN_CANARY"' EXIT
{
  printf '%s\n' \
    '172.16.''50.7' \
    '.enhance-''wt-x' \
    'D:/workspace/''go/coding/x' \
    "D:${B}workspace${B}github${B}y" \
    'zhouchangjian2016''@gmail.com' \
    'wtr20211202''@gmail.com' \
    "C:${B}Users${B}zcj${B}n" \
    'C:/Users''/zcj/n' \
    '/d/work''space/p' \
    '/home/z''cj/n' \
    'sca_0123456789''abcdef0' \
    'scl_0123456789''abcdef0' \
    'sc_0123456789''abcdef'
} > "$SCAN_CANARY/canary.txt"
canary_hits=0
for pat in "${PATTERNS[@]}"; do
  c=$(grep -cE "$pat" "$SCAN_CANARY/canary.txt" 2>/dev/null || true)
  canary_hits=$((canary_hits + ${c:-0}))
done
if [ "$canary_hits" -ne 13 ]; then
  echo "FATAL: 扫描自检失败（金丝雀 $canary_hits/13）——当前 grep 与 HARD 库方言不兼容，拒绝在假绿状态下扫描（可用 GNU grep 或修正模式）" >&2
  exit 2
fi

# —— 测试夹具假 token 精确白名单：脱敏/录制/迁移类单测与 e2e 夹具的 token 必须
# 长得与真 token 同形态才测得出来，逐串精确排除（新增夹具时在此同步登记）。
# 源码内断写，防 HARD 扫描命中本脚本自身。注意「sca_0123456789abcdef」是前缀
# 包含关系（金丝雀同前缀行靠本表排除——金丝雀计数走直连 grep 不经本表，不受影响）。
{
  printf '%s\n' \
    'sca_''8f3a2b1c4d5e4f6a8b7c9d0e1f2a3b4c' \
    'sca_''0123456789abcdef' \
    'sca_''Ab12Cd34Ef56Gh78' \
    'sca_''abcdef1234567890' \
    'sca_''migrationtesttoken01' \
    'sca_''e2escmT0k3nXy7Qw' \
    'sca_''e2eFrozen0Secret1' \
    'sca_''test0000000000000000000000000000000000000000000000000000test'
} > "$SCAN_CANARY/fake-tokens.txt"

total_hits=0
for pat in "${PATTERNS[@]}"; do
  # -I 跳二进制（快照 png 等）；-n 带行号；文本面全量；命中行再过假 token 精确白名单
  hits=$(grep -rInE "$pat" "$DIR" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    hits=$(printf '%s\n' "$hits" | grep -vFf "$SCAN_CANARY/fake-tokens.txt" 2>/dev/null || true)
  fi
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
