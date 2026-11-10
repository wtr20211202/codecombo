#!/bin/bash
# release-publish.sh —— 发布快照→GitHub 发布仓检出的镜像同步器（P-20261025-2 补链）。
#
# 协作模式：内网 Gitea 唯一开发地；GitHub 发布仓是快照式发布历史（每版一提交，
# 开发仓提交历史不外流）。本脚本把「导出→扫描→镜像」三步串成一条命令，杜绝
# 手工逐文件拷贝的漏同步（2026-11-02 实证两次：docs/index.html、docs/assets/site.css）。
#
# 增量语义：发布仓不逐提交同步——每次运行都是「最新代码全量快照」覆盖检出目录
# （仅保留 .git），发布仓 git 自动把两版快照之差呈现为一个发布提交。
#
# 发布=发版铁律（P-20261106 实锚）：日常修复只攒开发仓，本脚本一次同步=一次发版。
# 发布仓「有代码无版本」的中间态用户拉不到更新（无 tag→无构建→无资产→无 npm 包），
# 公开面却已超前于最新 Release（beta.2 后 5 个修复提交曾裸挂 main）。故脚本带版本
# 叙事门禁：导出树 CHANGELOG 顶部版本段必须新于发布仓最新 tag 才放行镜像；仅官网/
# 文档类同步（不发版）用 --site-only 显式豁免。
#
# 流程（顺序即门禁，不可跳步）：
#   1. release-export.sh —— 当前 HEAD（或 --ref 提交）追踪面 → release/public
#      （幂等全量重导，拒绝复用旧快照，防陈旧发布）
#   2. 单调向前门禁      —— 导出提交必须是发布仓最新 tag 锚点（rel/<tag>）的
#      后代，否则拒绝（发布回退硬闸）
#   3. 版本叙事门禁      —— CHANGELOG 顶部版本段 ≠ 发布仓最新 tag（否则拒绝）
#   4. release-scan.sh   —— 零放行敏感扫描（含金丝雀自检），不过即停
#   5. 镜像同步          —— 检出目录清空（保 .git）→ 灌入导出树 → git add -A
#   6. 停在待提交状态    —— 展示变更摘要与建议提交信息，commit/push/tag 由人执行
#      （对外发布是外向动作，永远人工触发；脚本不做 push）
#
# 用法：bash scripts/release-publish.sh [--ref <commit|tag>] [--site-only] <发布仓检出目录>
#   --ref <commit>  节点发布：从指定提交导出（如某修复先发、其后已积累功能不发）；
#                   缺省=HEAD。单调向前门禁对 --ref 同样生效；节点叙事三件套须
#                   提交在该节点之上（叙事与内容同树匹配，见 runbook §3 变体节）。
#   --site-only  仅官网/文档类同步（不发版，用户拉不到二进制更新——慎用）
#   检出目录前置条件：在 main 分支、工作树干净（有未提交改动先处置，防混入非发布内容）。
#
# 单调向前门禁（发布回退硬闸）：新导出提交必须是「发布仓最新 tag 对应开发仓锚点
# rel/<tag>」的后代——发布仓是单调前进的版本历史，把更旧的树以更高版本号发出=
# 公开发布回滚，门禁拒绝；确属有意回滚走开发仓 git revert 后从新提交发布。

set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

SITE_ONLY=0
REL=""
REF=""
ref_pending=0
for arg in "$@"; do
  if [ "$ref_pending" = 1 ]; then REF="$arg"; ref_pending=0; continue; fi
  case "$arg" in
    --site-only) SITE_ONLY=1;;
    --ref) ref_pending=1;;
    --ref=*) REF="${arg#--ref=}";;
    *) if [ -z "$REL" ]; then REL="$arg"; fi;;
  esac
done
[ "$ref_pending" = 0 ] || { echo "FATAL: --ref 需要一个提交参数（commit/tag/分支名）" >&2; exit 2; }
case "$REL" in
  "") echo "FATAL: 用法：bash scripts/release-publish.sh [--site-only] <发布仓检出目录>" >&2; exit 2;;
esac
REL_ABS="$(mkdir -p "$REL" && cd "$REL" && pwd)"
case "$REL_ABS" in
  "$REPO_ROOT") echo "FATAL: 检出目录不能是开发仓根" >&2; exit 2;;
esac
if [ ! -e "$REL_ABS/.git" ]; then
  echo "FATAL: $REL_ABS 不是 git 工作树（缺 .git）——拒绝向非 git 目录灌快照" >&2
  exit 2
fi

# ---------- 1) 导出（总是全量重导，幂等；--ref 时从指定提交导出） ----------
EXPORT_SRC="HEAD"
REF_ARGS=()
if [ -n "$REF" ]; then
  REF=$(git rev-parse --verify --quiet "$REF^{commit}") \
    || { echo "FATAL: --ref 无法解析为提交：$REF" >&2; exit 2; }
  EXPORT_SRC="$REF"
  REF_ARGS=(--ref "$EXPORT_SRC")
  echo "==> 节点发布：导出源 $EXPORT_SRC"
fi
bash scripts/release-export.sh "${REF_ARGS[@]}" release/public

# ---------- 内容寻址短路径：新导出与上次「已扫描+已镜像」的树逐字节一致
# 时，跳过扫描与镜像（同一棵树不会被扫出不同结果，镜像也无可做）——零信任
# 不减配（首次/变更走全量），只是不为 identical 的树重复买单。清单哈希器
# 单进程秒级，本短路径把「纯确认一致性」的例行验证从分钟级降到秒级
node scripts/manifest-hash.mjs release/public release/manifest.pending.sha256
if cmp -s release/manifest.pending.sha256 release/manifest.prev.sha256 && [ -f release/manifest.sha256 ]; then
  echo "==> 导出树与上次已验证快照逐字节一致 —— 短路径返回（扫描与镜像已在上轮完成）"
  exit 0
fi

# ---------- 2) 单调向前门禁（发布回退硬闸） ----------
# 导出提交必须是「发布仓最新 tag 对应开发仓锚点 rel/<tag>」的后代——发布仓是
# 单调前进的版本历史，把更旧的树以更高版本号发出=公开发布回滚，拒绝。
last_tag=$(git -C "$REL_ABS" describe --tags --abbrev=0 2>/dev/null || true)
if [ -n "$last_tag" ]; then
  if ! anchor_commit=$(git rev-parse --verify --quiet "refs/tags/rel/$last_tag^{commit}"); then
    echo "FATAL: 单调向前门禁缺锚点——开发仓没有 rel/$last_tag（发布仓最新 tag 的导出锚点）。" >&2
    echo "       上次发版漏打锚点=取材基线缺失，先按 runbook §3 第 8 步补打再发布。" >&2
    exit 2
  fi
  src_commit=${REF:-$(git rev-parse HEAD)}   # REF 已在导出步骤解析为全量 SHA
  if ! git merge-base --is-ancestor "$anchor_commit" "$src_commit"; then
    echo "FATAL: 发布回退拒绝——导出提交 $(git rev-parse --short=8 "$src_commit") 不是 rel/$last_tag（$(git rev-parse --short=8 "$anchor_commit")）的后代。" >&2
    echo "       发布仓必须单调向前：把更旧的树以更高版本号发出=公开发布回滚。" >&2
    echo "       确属有意回滚：在开发仓 git revert 后从新提交发布，叙事如实记录。" >&2
    exit 2
  fi
  echo "==> 单调向前 ✓：导出提交 $(git rev-parse --short=8 "$src_commit") ⊇ rel/$last_tag"
fi

# ---------- 3) 版本叙事门禁（发布=发版铁律） ----------
# 导出树 CHANGELOG 顶部版本段必须新于发布仓最新 tag——即本版变更叙事三件套已备好。
# 仅官网/文档类同步（不发版）用 --site-only 显式豁免
top_ver=$(awk '/^## \[/{v=substr($0,5); sub(/\].*/,"",v); if (v!="Unreleased"){print v; exit}}' release/public/CHANGELOG.md 2>/dev/null || true)
if [ -z "$top_ver" ]; then
  echo "FATAL: 导出树 CHANGELOG.md 无版本段——变更叙事三件套缺失，拒绝发布" >&2
  exit 2
fi
if [ "$SITE_ONLY" = "1" ]; then
  echo "==> --site-only：跳过版本叙事门禁（仅限官网/文档类同步，不发版——用户拉不到二进制更新）"
elif [ "v$top_ver" = "$last_tag" ]; then
  echo "FATAL: CHANGELOG 顶部版本段（$top_ver）与发布仓最新 tag（$last_tag）相同——没有基于上个版本的新变更叙事。" >&2
  echo "       修复请攒在开发仓，攒到发版再同步。本版叙事取材：git log --oneline rel/$last_tag..HEAD" >&2
  echo "       （仅官网/文档类同步可加 --site-only 豁免）" >&2
  exit 2
fi

# ---------- 4) 零放行扫描（不过即停，exit 1/2 直接终止本脚本） ----------
bash scripts/release-scan.sh release/public

# ---------- 检出目录前置状态 ----------
branch=$(git -C "$REL_ABS" rev-parse --abbrev-ref HEAD)
if [ "$branch" != "main" ]; then
  echo "FATAL: 发布仓检出在 '$branch' 分支——快照发布只落 main（Pages 与 tag 流程均绑 main）" >&2
  exit 2
fi
if [ -n "$(git -C "$REL_ABS" status --porcelain)" ]; then
  echo "FATAL: 发布仓工作树不干净——先处置未提交内容再发布（防混入非本版内容）" >&2
  git -C "$REL_ABS" status --short | head -10 >&2
  exit 2
fi

# ---------- 5) 镜像同步（保留 .git，其余全换） ----------
echo "==> Mirror: $REL_ABS <- release/public"
find "$REL_ABS" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a release/public/. "$REL_ABS/"
git -C "$REL_ABS" add -A

# 记录「已验证+已镜像」内容基线（短路径的比较锚点，.gitignore 已忽略 release/）
cp release/manifest.pending.sha256 release/manifest.prev.sha256

# ---------- 6) 待提交摘要（人工确认后 commit / push / tag） ----------
SRC_COMMIT=$(sed -n 's/^source-commit: //p' release/export-info.txt 2>/dev/null || echo unknown)
echo ""
echo "==> 快照已灌入，待提交变更（git add -A 已完成）："
git -C "$REL_ABS" status --short | sed 's/^/    /' | head -40
changed=$(git -C "$REL_ABS" status --porcelain | wc -l)
[ "$changed" -gt 40 ] && echo "    ... 共 $changed 项"
echo ""
echo "==> 建议下一步（人工执行）："
echo "    git -C \"$REL_ABS\" commit -m \"release: snapshot from $SRC_COMMIT\""
echo "    git -C \"$REL_ABS\" push origin main        # Pages 随推自动重部署"
echo "    bash scripts/release-ci-gate.sh <上一步推送后的提交SHA>   # CI 绿门禁（P-20261106 纪律：未绿不打 tag）"
echo "    git -C \"$REL_ABS\" tag v<版本> && git -C \"$REL_ABS\" push origin v<版本>   # 门禁绿了才走这步——触发 release.yml 六平台构建"
echo "    发版完成后回开发仓打锚点（下次变更叙事取材基线）："
echo "    git tag rel/v<版本> && git push origin rel/v<版本>   # 指向本次导出提交（$SRC_COMMIT）"
