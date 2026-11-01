/**
 * 键盘多选的范围收集（P-20261003-271，变更树 Shift+↑↓ / Ctrl+A 共用）：
 * 文件树 P-20 Shift+Click 锚点模式的键盘同构——自锚点行到当前光标行的闭区间内
 * 收集文件行路径。结果存「路径集合」防虚拟列表重排漂移（文件树多选同款）；
 * 目录行不参与（批量操作面是文件级）。
 */

/** 扁平行序中的一行（变更树 TreeNode 结构子集，flattenTree 产物可直接传入） */
export interface RangeRow {
  isDir: boolean
  path: string
  file?: { path: string }
}

/**
 * 锚点到当前光标的闭区间内的文件行路径。
 * 锚点缺省（<0，尚无任何导航/点选）时回落当前行——首次 Shift+↑↓ 从光标处起选。
 */
export function collectRangePaths(rows: RangeRow[], anchorIdx: number, activeIdx: number): Set<string> {
  const anchor = anchorIdx >= 0 ? anchorIdx : activeIdx
  const start = Math.min(anchor, activeIdx)
  const end = Math.max(anchor, activeIdx)
  const paths = new Set<string>()
  for (let i = start; i <= end; i++) {
    const row = rows[i]
    if (row?.file) paths.add(row.file.path)
  }
  return paths
}

/** 全选可见文件行（Ctrl+A；「可见」= 当前树展开/过滤视图的扁平行序，所见即所选） */
export function collectAllFilePaths(rows: RangeRow[]): Set<string> {
  const paths = new Set<string>()
  for (const row of rows) {
    if (row.file) paths.add(row.file.path)
  }
  return paths
}
