import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import type { Ref } from 'vue'

// useRemoteFileBrowser 路径历史/pin 接线测试（P-20261006-19）：列表纯语义在
// utils/remotePathMemory（伴随单测），此处覆盖「cwd watcher 入史 + safeStorage
// 按主机持久化 + 主机切换装载」的组合行为。外部依赖全部 mock（naive-ui 的
// useMessage 需 Provider 上下文、api client 走网络、useDialog 弹原生窗）。
const memStore = vi.hoisted(() => ({}) as Record<string, string>)

vi.mock('naive-ui', () => ({
  useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
}))
vi.mock('./useI18n', () => ({
  useI18n: () => ({ t: (k: string) => k }),
}))
vi.mock('./useDialog', () => ({
  confirmDialog: vi.fn(async () => true),
  promptDialog: vi.fn(async () => ''),
}))
vi.mock('../api/client', () => ({
  remoteHostApi: {
    files: {
      list: vi.fn(async () => ({ data: { entries: [] } })),
    },
  },
}))
vi.mock('../utils/storage', () => ({
  safeStorage: {
    getItem: (k: string) => memStore[k] ?? null,
    setItem: (k: string, v: string) => { memStore[k] = v },
    removeItem: (k: string) => { delete memStore[k] },
  },
}))

import { useRemoteFileBrowser } from './useRemoteFileBrowser'
import type { RemoteHost } from '../api/client'

/** 构造被测组合式：host 挂 ref 供切换，cwd 经返回值驱动（与宿主同一路径） */
function setup(hostId: string) {
  const host = ref({ id: hostId, name: 'h' } as unknown as RemoteHost)
  const filterText = ref('')
  const browser = useRemoteFileBrowser({ host: () => host.value, filterText })
  return { host, browser }
}

/** cwd 赋值后等 watcher flush（pre 队列挂在 nextTick） */
async function navigate(cwd: Ref<string>, to: string) {
  cwd.value = to
  await nextTick()
  await nextTick()
}

beforeEach(() => {
  for (const k of Object.keys(memStore)) delete memStore[k]
})

describe('useRemoteFileBrowser 路径历史 + pin（P-20261006-19）', () => {
  it('cwd 变化自动入史（新→旧），根 / 不入史', async () => {
    const { browser } = setup('h1')
    await nextTick() // host watcher immediate：初始装载 + 从根列出
    await navigate(browser.cwd, '/var/www')
    await navigate(browser.cwd, '/var/www/app/logs')
    expect(browser.recentPaths.value).toEqual(['/var/www/app/logs', '/var/www'])
    await navigate(browser.cwd, '/')
    expect(browser.recentPaths.value).toEqual(['/var/www/app/logs', '/var/www'])
  })

  it('重复访问去重置顶（LRU），并持久化到按主机隔离的 key', async () => {
    const { browser } = setup('h1')
    await nextTick()
    await navigate(browser.cwd, '/a')
    await navigate(browser.cwd, '/b')
    await navigate(browser.cwd, '/a')
    expect(browser.recentPaths.value).toEqual(['/a', '/b'])
    expect(JSON.parse(memStore['sc.rfm.mem.h1'] ?? '{}')).toEqual({
      recent: ['/a', '/b'],
      pins: [],
    })
  })

  it('pin 从最近区迁入置顶并持久化；unpin 回落最近区；已 pin 路径再访问不重复入史', async () => {
    const { browser } = setup('h1')
    await nextTick()
    await navigate(browser.cwd, '/a')
    await navigate(browser.cwd, '/b')
    browser.togglePinPath('/b')
    expect(browser.pinnedPaths.value).toEqual(['/b'])
    expect(browser.recentPaths.value).toEqual(['/a'])
    // pin 态再访问（先离开再回来，触发 cwd watcher）：常驻置顶，不入最近区（双区不重复）
    await navigate(browser.cwd, '/c')
    await navigate(browser.cwd, '/b')
    expect(browser.recentPaths.value).toEqual(['/c', '/a'])
    expect(JSON.parse(memStore['sc.rfm.mem.h1'] ?? '{}').pins).toEqual(['/b'])
    // unpin：回落最近区置顶（不丢路径）
    browser.togglePinPath('/b')
    expect(browser.pinnedPaths.value).toEqual([])
    expect(browser.recentPaths.value).toEqual(['/b', '/c', '/a'])
  })

  it('主机切换装载该主机的历史（隔离互不串扰）', async () => {
    memStore['sc.rfm.mem.h2'] = JSON.stringify({ recent: ['/x'], pins: ['/p'] })
    const { host, browser } = setup('h1')
    await nextTick()
    await navigate(browser.cwd, '/a')
    host.value = { id: 'h2', name: 'h2' } as unknown as RemoteHost
    await nextTick()
    await nextTick()
    expect(browser.recentPaths.value).toEqual(['/x'])
    expect(browser.pinnedPaths.value).toEqual(['/p'])
  })

  it('持久层脏数据按空历史处理不抛错', async () => {
    memStore['sc.rfm.mem.h1'] = 'not-json'
    const { browser } = setup('h1')
    await nextTick()
    expect(browser.recentPaths.value).toEqual([])
    expect(browser.pinnedPaths.value).toEqual([])
  })
})
