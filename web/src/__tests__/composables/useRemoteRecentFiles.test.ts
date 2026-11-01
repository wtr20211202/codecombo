import { describe, it, expect, beforeEach } from 'vitest'
import {
  useRemoteRecentFiles, REMOTE_RECENT_FILES_KEY, REMOTE_RECENT_MAX,
} from '@/composables/useRemoteRecentFiles'
import { safeStorage } from '@/utils/storage'

// 远程文件「最近打开」环形清单（P-20261004-137）：模块级单例跨用例共享，
// 每个用例先清空（clearRemoteRecent 正门）
describe('useRemoteRecentFiles', () => {
  beforeEach(() => {
    useRemoteRecentFiles().clearRemoteRecent()
  })

  it('push 置顶并按 hostId+rpath 去重（同文件重复打开不产生第二条）', () => {
    const { remoteRecentFiles, pushRemoteRecent } = useRemoteRecentFiles()
    pushRemoteRecent({ hostId: 'h1', rpath: '/srv/a.txt', name: 'a.txt' })
    pushRemoteRecent({ hostId: 'h1', rpath: '/srv/b.txt', name: 'b.txt' })
    pushRemoteRecent({ hostId: 'h1', rpath: '/srv/a.txt', name: 'a.txt' })

    expect(remoteRecentFiles.value.map(e => e.rpath)).toEqual(['/srv/a.txt', '/srv/b.txt'])
    // 同名路径不同主机不误去重（hostId 是寻址键）
    pushRemoteRecent({ hostId: 'h2', rpath: '/srv/a.txt', name: 'a.txt' })
    expect(remoteRecentFiles.value).toHaveLength(3)
  })

  it('环形上限 8 条：超限从最旧截尾', () => {
    const { remoteRecentFiles, pushRemoteRecent } = useRemoteRecentFiles()
    for (let i = 0; i < REMOTE_RECENT_MAX + 2; i++) {
      pushRemoteRecent({ hostId: 'h1', rpath: `/srv/f${i}.txt`, name: `f${i}.txt` })
    }
    expect(remoteRecentFiles.value).toHaveLength(REMOTE_RECENT_MAX)
    expect(remoteRecentFiles.value[0]!.rpath).toBe(`/srv/f${REMOTE_RECENT_MAX + 1}.txt`)
    expect(remoteRecentFiles.value.at(-1)!.rpath).toBe('/srv/f2.txt')
  })

  it('写入落 safeStorage（刷新后仍在），remove 清指定条目并同步落盘', () => {
    const { pushRemoteRecent, removeRemoteRecent, remoteRecentFiles } = useRemoteRecentFiles()
    pushRemoteRecent({ hostId: 'h1', rpath: '/srv/a.txt', name: 'a.txt' })
    pushRemoteRecent({ hostId: 'h1', rpath: '/srv/b.txt', name: 'b.txt' })

    const persisted = JSON.parse(safeStorage.getItem(REMOTE_RECENT_FILES_KEY) || '[]') as { rpath: string }[]
    expect(persisted.map(e => e.rpath)).toEqual(['/srv/b.txt', '/srv/a.txt'])

    removeRemoteRecent('h1', '/srv/b.txt')
    expect(remoteRecentFiles.value.map(e => e.rpath)).toEqual(['/srv/a.txt'])
    const after = JSON.parse(safeStorage.getItem(REMOTE_RECENT_FILES_KEY) || '[]') as { rpath: string }[]
    expect(after.map(e => e.rpath)).toEqual(['/srv/a.txt'])
  })

  it('形态不符/空 hostId 的入参被忽略（读侧同口径防御）', () => {
    const { remoteRecentFiles, pushRemoteRecent } = useRemoteRecentFiles()
    pushRemoteRecent({ hostId: '', rpath: '/srv/a.txt' })
    pushRemoteRecent({ hostId: 'h1', rpath: '' })
    expect(remoteRecentFiles.value).toHaveLength(0)
    // 省略 name 时用 rpath 末段兜底
    pushRemoteRecent({ hostId: 'h1', rpath: '/srv/deep/c.txt' })
    expect(remoteRecentFiles.value[0]!.name).toBe('c.txt')
  })
})
