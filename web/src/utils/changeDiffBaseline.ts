// 变更面板行 diff 基线分流（P-20261004-42 盲提交收口）：双击/回车开 diff 标签
// 时按行的暂存态选对比基线——部分暂存后 HEAD vs 工作区合并 diff 把「将提交什么」
// 与「剩余改动」混在一屏，提交对暂存内容是盲的。与行内嵌 diff（P-20261004-25，
// GetFileDiff staged 参数）及 hunk 三键基线同语义：
//   已暂存行 → HEAD vs index（「将提交什么」，键 diff:HEAD:index:<path>）
//   未暂存行 → index vs worktree（「剩余改动」，键 diff:index:wt:<path>）
//   冲突行   → 维持 HEAD vs worktree 合并 diff（见 changeDiffBaseline 内注）
// 本文件只做纯判定（changeSummary 同范式，可独立单测），取数在 openfiles/diff.ts。

/** git 索引伪 ref：键与面包屑层保持可读字面量，openDiffView 取数时映射为
 *  底层 stage-0 语法（git show :0:<path>）——:0 含冒号会破坏 diff: 键的冒号
 *  分段（parseDiffKey 首段空即 null），不能直接进键 */
export const INDEX_REF = 'index'

/** 基线分流所需的最小文件面（FileStatus 的形状子集，ChangeSummaryFile 同范式） */
export interface ChangeBaselineFile {
  staged: boolean
  status: string
}

/** openDiffView 参数面（伪 ref 语义清单见 utils/diffTabKey 头注） */
export interface ChangeDiffTarget {
  oldRef: string
  newRef?: string
}

/** 按暂存态分流 diff 对比基线（VS Code 双列表语义的单一入口投影） */
export function changeDiffBaseline(file: ChangeBaselineFile): ChangeDiffTarget {
  if (file.staged) {
    return { oldRef: 'HEAD', newRef: INDEX_REF }
  }
  if (file.status === 'Unmerged') {
    // 冲突文件 index 里是 stage 1/2/3 分立条目、无 stage-0，index 基线取数必空
    // （会退化成「空 vs 工作区」）——维持 HEAD 合并 diff 形态（左=ours）供裁决
    return { oldRef: 'HEAD' }
  }
  // 未暂存行按 index 基线：未跟踪新文件 index 无条目，左侧自然为空 =
  // 「全新文件」形态（与旧 HEAD 基线的显示等价，语义更准：相对暂存区新增）
  return { oldRef: INDEX_REF }
}
