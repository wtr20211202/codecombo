/**
 * 文件树常用目录钉选（P-20261002-97）纯函数：钉选表的增删/别名/失效清理。
 * 排序约定：新→旧（新钉的在最上），上限 MAX_PINNED_DIRS、超出 FIFO 淘汰最旧；
 * 持久化形态是 uiState fileTree.pinnedDirs 的 projectId -> 列表映射（项目级），
 * 映射的拼装在宿主（FileTreeView persistPins），此处只管单项目内的列表语义。
 */

/** 钉选上限：超出后最旧的被淘汰（FIFO） */
export const MAX_PINNED_DIRS = 8

/** 钉选一个目录：置顶去重后截到上限（重复钉选 = 移到最前，同 recent-files 语义） */
export function upsertPin(list: string[], dirPath: string, max = MAX_PINNED_DIRS): string[] {
  return [dirPath, ...list.filter(p => p !== dirPath)].slice(0, max)
}

/** 取消钉选 */
export function removePin(list: string[], dirPath: string): string[] {
  return list.filter(p => p !== dirPath)
}

/** 清理失效钉选（isPinValid 由宿主按磁盘存在性注入） */
export function prunePins(list: string[], isPinValid: (p: string) => boolean): string[] {
  return list.filter(isPinValid)
}

/** 钉选项显示别名：末两段（src/components/layout → components/layout；
 *  单段目录就是自身），全路径走 title 属性 */
export function pinAlias(dirPath: string): string {
  const parts = dirPath.split('/').filter(Boolean)
  return parts.slice(-2).join('/')
}
