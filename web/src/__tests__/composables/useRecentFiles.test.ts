import { describe, it, expect, beforeEach } from 'vitest'
import { useRecentFiles, type RecentEntry } from '../../composables/useRecentFiles'

/**
 * 最近文件记录语义：
 *   - 去重键 = 路径 + 项目位置（projectPath 稳定；projectId 会随项目重建轮换）
 *   - removeRecent 按 path 清除死条目（打开失败的僵尸项治理）
 */
function entry(path: string, projectId: string, projectPath?: string): RecentEntry {
  return { path, name: path.split('/').pop() || path, projectId, projectPath: projectPath || '', ts: Date.now() }
}

describe('useRecentFiles', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('pushRecent：同路径同项目 → 去重为一条', () => {
    const { recents, pushRecent } = useRecentFiles()
    pushRecent(entry('src/a.ts', 'p1', 'D:/work/proj'))
    pushRecent(entry('src/a.ts', 'p1', 'D:/work/proj'))
    expect(recents.value.filter(r => r.path === 'src/a.ts').length).toBe(1)
  })

  it('pushRecent：projectId 轮换（项目重建）→ 按 projectPath 去重', () => {
    const { recents, pushRecent } = useRecentFiles()
    pushRecent(entry('src/a.ts', 'old-id', 'D:/work/proj'))
    // 项目删除重建：projectId 轮换、projectPath 不变
    pushRecent(entry('src/a.ts', 'new-id', 'D:/work/proj'))
    expect(recents.value.filter(r => r.path === 'src/a.ts').length).toBe(1)
  })

  it('pushRecent：不同路径互不挤占', () => {
    const { recents, pushRecent } = useRecentFiles()
    pushRecent(entry('src/a.ts', 'p1', 'D:/work/proj'))
    pushRecent(entry('src/b.ts', 'p1', 'D:/work/proj'))
    expect(recents.value.length).toBe(2)
  })

  it('removeRecent：按路径清除死条目', () => {
    const { recents, pushRecent, removeRecent } = useRecentFiles()
    pushRecent(entry('src/a.ts', 'p1', 'D:/work/proj'))
    pushRecent(entry('src/b.ts', 'p1', 'D:/work/proj'))
    removeRecent('src/a.ts')
    expect(recents.value.some(r => r.path === 'src/a.ts')).toBe(false)
    expect(recents.value.some(r => r.path === 'src/b.ts')).toBe(true)
  })

  it('removeRecent：不存在路径静默无副作用', () => {
    const { recents, pushRecent, removeRecent } = useRecentFiles()
    pushRecent(entry('src/b.ts', 'p1', 'D:/work/proj'))
    removeRecent('no-such.ts')
    expect(recents.value.length).toBe(1)
  })
})
