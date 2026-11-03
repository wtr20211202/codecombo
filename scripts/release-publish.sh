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
# 流程（顺序即门禁，不可跳步）：
#   1. release-export.sh —— 当前 HEAD 追踪面 → release/public（幂等全量重导，
#      拒绝复用旧快照，防陈旧发布）
#   2. release-scan.sh   —— 零放行敏感扫描（含金丝雀自检），不过即停
#   3. 镜像同步          —— 检出目录清空（保 .git）→ 灌入导出树 → git add -A
#   4. 停在待提交状态    —— 展示变更摘要与建议提交信息，commit/push/tag 由人执行
#      （对外发布是外向动作，永远人工触发；脚本不做 push）
#
# 用法：bash scripts/release-publish.sh <发布仓检出目录>
#   检出目录前置条件：在 main 分支、工作树干净（有未提交改动先处置，防混入非发布内容）。

set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

REL="${1:-}"
case "$REL" in
  ""|"$REPO_ROOT") echo "FATAL: 用法：bash scripts/release-publish.sh <发布仓检出目录>" >&2; exit 2;;
esac
REL_ABS="$(mkdir -p "$REL" && cd "$REL" && pwd)"
case "$REL_ABS" in
  "$REPO_ROOT") echo "FATAL: 检出目录不能是开发仓根" >&2; exit 2;;
esac
if [ ! -e "$REL_ABS/.git" ]; then
  echo "FATAL: $REL_ABS 不是 git 工作树（缺 .git）——拒绝向非 git 目录灌快照" >&2
  exit 2
fi

# ---------- 1) 导出（总是全量重导，幂等） ----------
bash scripts/release-export.sh release/public

# ---------- 内容寻址短路径：新导出与上次「已扫描+已镜像」的树逐字节一致
# 时，跳过扫描与镜像（同一棵树不会被扫出不同结果，镜像也无可做）——零信任
# 不减配（首次/变更走全量），只是不为 identical 的树重复买单。清单哈希器
# 单进程秒级，本短路径把「纯确认一致性」的例行验证从分钟级降到秒级
node scripts/manifest-hash.mjs release/public release/manifest.pending.sha256
if cmp -s release/manifest.pending.sha256 release/manifest.prev.sha256 && [ -f release/manifest.sha256 ]; then
  echo "==> 导出树与上次已验证快照逐字节一致 —— 短路径返回（扫描与镜像已在上轮完成）"
  exit 0
fi

# ---------- 2) 零放行扫描（不过即停，exit 1/2 直接终止本脚本） ----------
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

# ---------- 3) 镜像同步（保留 .git，其余全换） ----------
echo "==> Mirror: $REL_ABS <- release/public"
find "$REL_ABS" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -a release/public/. "$REL_ABS/"
git -C "$REL_ABS" add -A

# 记录「已验证+已镜像」内容基线（短路径的比较锚点，.gitignore 已忽略 release/）
cp release/manifest.pending.sha256 release/manifest.prev.sha256

# ---------- 4) 待提交摘要（人工确认后 commit / push / tag） ----------
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
echo "    git -C \"$REL_ABS\" tag v<版本> && git -C \"$REL_ABS\" push origin v<版本>   # 触发 release.yml 六平台构建"
