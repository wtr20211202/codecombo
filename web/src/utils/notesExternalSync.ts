// 外部更新无扰换装纯函数集（P-20261111-4-S2）：全局笔记 onExternalUpdate 重读
// 后应用前的两道守卫——
//   ①清单 diff 守卫（mergeNoteLists）：后台静默刷新清单时按 id 复用未变更条目的
//     对象身份，keyed v-for 对同身份条目零 DOM 写入（仅变更项原地更新，不全量
//     重渲侧栏闪动）；
//   ②换装光标锚定（computeAnchoredSelection）：外部内容与编辑面现值不同必须换装
//     时，按新旧内容的最长稳定前缀/后缀映射换装前的选区偏移——光标前的文字没被
//     改写就不动，改写区前方被插入时沿稳定后缀端平移，光标落在被改写区内才退化
//     到稳定前缀端（好过现状整篇重读的光标/选区/undo 栈全重置）。
// 纯函数无副作用：不入引擎/组件状态，单测直测数学形态。
import type { MultiNoteMeta } from '../api/client'

/**
 * 清单静默合并（服务端序 updatedAt 降序为权威序，next 即目标序）：
 * 未变更条目复用 prev 的对象引用（Vue keyed 行零 DOM 写入的依据），变更/新增
 * 用 next 的条目，next 缺失的 id 自然落出。deletedAt/deletedBy 只比有无（软删
 * 篇不入在册清单，字段仅防御性对齐）。
 */
export function mergeNoteLists(prev: MultiNoteMeta[], next: MultiNoteMeta[]): MultiNoteMeta[] {
  const prevById = new Map(prev.map(n => [n.id, n]))
  return next.map(n => {
    const old = prevById.get(n.id)
    if (!old) return n
    if (old.title === n.title && old.updatedAt === n.updatedAt && old.size === n.size
      && !!old.deletedAt === !!n.deletedAt && !!old.deletedBy === !!n.deletedBy) {
      return old
    }
    return n
  })
}

/** 锚定后的选区（textarea.setSelectionRange 直用形态） */
export interface AnchoredSelection {
  selectionStart: number
  selectionEnd: number
}

/**
 * 外部换装的光标锚定映射：oldValue 换装到 newValue 后，换装前选区 [start, end)
 * 在新内容里的落点。
 *
 * 算法（diff-match-patch 光标恢复同思路的定长版）：
 *   lcp = 新旧最长公共前缀长度；lcs = 最长公共后缀长度（与前缀不重叠封顶）。
 *   旧偏移 p 的映射——
 *   · p ≤ lcp：光标前文字未变，偏移原地成立（agent 尾部追加：光标不动）；
 *   · 旧串尾距 p ≤ lcs：改写区整体在光标前方，沿稳定后缀端平移（外部在
 *     文首插入：视觉位置不变，数值偏移 = newLen - 旧尾距）；
 *   · 其余（光标落在被改写区内）：退化夹取到 lcp（稳定前缀端——任务书认可的
 *     降级形态，好过全重置）。
 * 起终偏移各自独立映射后保序（start ≤ end），再夹进新值界内；偏移超界/负值
 * 一律收敛到合法区间（健壮性红线：外部数据不设防不成立）。
 */
export function computeAnchoredSelection(
  oldValue: string,
  newValue: string,
  selectionStart: number,
  selectionEnd: number,
): AnchoredSelection {
  const oldLen = oldValue.length
  const newLen = newValue.length
  const minLen = Math.min(oldLen, newLen)
  let lcp = 0
  while (lcp < minLen && oldValue[lcp] === newValue[lcp]) lcp++
  let lcs = 0
  const suffixCap = minLen - lcp // 后缀与前缀不重叠
  while (lcs < suffixCap && oldValue[oldLen - 1 - lcs] === newValue[newLen - 1 - lcs]) lcs++

  const mapEdge = (p: number): number => {
    const fromEnd = oldLen - p
    if (p <= lcp) return p
    if (fromEnd <= lcs) return newLen - fromEnd
    return Math.min(p, lcp)
  }
  // 入域夹到旧值界（textarea selectionStart/End 合法域），出域夹到新值界——
  // 入域用新值界会把超界偏移错误推进后缀映射分支（fromEnd 变负）
  const clampIn = (v: number): number => Math.max(0, Math.min(v, oldLen))
  const clampOut = (v: number): number => Math.max(0, Math.min(v, newLen))
  const start = clampOut(mapEdge(clampIn(selectionStart)))
  let end = clampOut(mapEdge(clampIn(selectionEnd)))
  if (end < start) end = start
  return { selectionStart: start, selectionEnd: end }
}
