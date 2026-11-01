/**
 * 历史检视 worktree（P-20261005-179）：提交右键「在此提交检视」在定点提交上
 * 开出独立工作区（`git worktree add <path> <hash>`，HEAD 分离、不建分支），
 * 用于「在提交 X 的代码态跑一下」的回归排查——不动主检出、不建分支、与主
 * 检出的脏区无关。
 *
 * 目录名约定 `wt-hist-<短hash>` 是「历史检视」身份的唯一标记（git worktree
 * 元数据不存自定义注记）：创建位（CommitsPanel）与 worktree 管理区徽标
 * （GitWorktreesSection）共用本单一事实源，两边口径漂移会让徽标失明。
 */

/** 历史检视 worktree 目录名前缀 */
export const HIST_WORKTREE_PREFIX = 'wt-hist-'

/** 短 hash 长度：与提交列表展示口径一致（CommitsPanel.mapCommitRow shortHash=8） */
export const HIST_WORKTREE_HASH_LEN = 8

/** 目录名：wt-hist-<shortHash>（超长短 hash 截到展示口径长度） */
export function histWorktreeName(shortHash: string): string {
  return HIST_WORKTREE_PREFIX + shortHash.slice(0, HIST_WORKTREE_HASH_LEN)
}

/** 路径归一化比对键：反斜杠折正斜杠 + 去尾分隔符 + 小写（Windows 大小写
 * 不敏感；与 GitWorktreesSection.openWorktreeAsProject 的既有归一同款） */
export function normalizeWorktreePathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/** 历史检视判定：尾段目录名以前缀开头即认（不限落点——徽标语义跟名字走，
 * 用户把 worktree 建在任何位置都保持同一身份） */
export function isHistWorktreePath(path: string): boolean {
  const norm = normalizeWorktreePathKey(path)
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  return base.startsWith(HIST_WORKTREE_PREFIX)
}

/** 惯例落点：仓库兄弟目录 `<parent>/wt-hist-<shortHash>`——worktree 创建
 * 弹窗占位符 `../repo-feature` 确立的兄弟目录惯例。恒用正斜杠拼接（前端无
 * path 库；三平台的 git CLI 与服务端路径 API 均接受正斜杠形态）。无父段
 * （项目根就在盘符/根下）时回落相对名，git 以仓库根为 cwd 解析 */
export function histWorktreeSiblingPath(projectPath: string, shortHash: string): string {
  const norm = projectPath.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = norm.lastIndexOf('/')
  const parent = i > 0 ? norm.slice(0, i) : ''
  const name = histWorktreeName(shortHash)
  return parent ? `${parent}/${name}` : name
}
