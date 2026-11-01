import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import { createDiscreteApi } from 'naive-ui'
import { useOpenFiles } from '@/composables/useOpenFiles'
import { useThemeStore } from '@/stores/theme'
import { useProjectStore } from '@/stores/project'

// 多标签草稿写竞争保护（P-20261006-08）单测：双实例模拟双标签页——同一测试内
// 创建两份 useOpenFiles()（per-call 状态，见组合根单例纪律），各自持有独立同步态。
// storage 事件在 jsdom 不自动派发（settingsSync.test.ts 同款前提），手动
// dispatchEvent 模拟「另一标签页落库后广播」——浏览器语义下该事件只因他页写入
// 触发，单测口径与真实语义一致。IndexedDB 草稿存储层 mock 掉（同 draft.test.ts
// 分工：这里聚焦信标接收/判定编排，真实读写链路由 draftDb 单测与 e2e 覆盖）。
// 每用例独立项目 id：路由守卫按当前项目对位，天然隔离早前用例残留的实例监听器。

vi.mock('@/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/api/client')>('@/api/client')
  return {
    ...actual,
    projectApi: {
      ...actual.projectApi,
      filePolicy: vi.fn().mockRejectedValue(new Error('policy skip')),
      readFile: vi.fn().mockResolvedValue({ data: 'file content', hash: 'hash-A' }),
      writeFile: vi.fn().mockResolvedValue({ data: 'ok', hash: 'hash-B' }),
      status: vi.fn().mockResolvedValue({ data: [] }),
    },
    remoteHostApi: {
      ...actual.remoteHostApi,
      files: {
        ...actual.remoteHostApi.files,
        content: vi.fn().mockResolvedValue({ data: 'remote content', hash: 'rhash-A' }),
        writeContent: vi.fn().mockResolvedValue({ message: 'ok', hash: 'rhash-B' }),
      },
    },
  }
})

vi.mock('@/utils/draftDb', () => ({
  saveDraft: vi.fn().mockResolvedValue(true),
  readDraft: vi.fn().mockResolvedValue(null),
  readUntitledDraft: vi.fn().mockResolvedValue(null),
  removeDraft: vi.fn().mockResolvedValue(undefined),
  removeProjectDrafts: vi.fn().mockResolvedValue(undefined),
  saveUntitledDraft: vi.fn().mockResolvedValue(true),
  listUntitledDrafts: vi.fn().mockResolvedValue([]),
  removeUntitledDraft: vi.fn().mockResolvedValue(undefined),
  listFileDrafts: vi.fn().mockResolvedValue([]),
  removeDrafts: vi.fn().mockResolvedValue(undefined),
  DRAFT_MAX_CHARS: 2 * 1024 * 1024,
  DRAFT_SAVED_BEACON_KEY: 'sc.draft-saved',
}))

import { readDraft, readUntitledDraft, DRAFT_SAVED_BEACON_KEY } from '@/utils/draftDb'
import { REMOTE_DRAFT_PROJECT } from '@/composables/openfiles/persist'

const PATH = '/proj/a.ts'
let projSeq = 0
let projectId = ''

/** 当前实例的 message spy（组合根每次调用都新建一份 discrete api，取最新一份） */
function lastMessageApi(): { info: MockInstance; warning: MockInstance } {
  const results = vi.mocked(createDiscreteApi).mock.results
  const api = results[results.length - 1]!.value as unknown as {
    message: { info: MockInstance; warning: MockInstance }
  }
  return api.message
}

/** 模拟另一标签页落库广播：先落盘再派发（与真实顺序一致） */
function emitBeacon(project: string, path: string, savedAt: number) {
  localStorage.setItem(DRAFT_SAVED_BEACON_KEY, JSON.stringify({ project, path, savedAt }))
  window.dispatchEvent(new StorageEvent('storage', {
    key: DRAFT_SAVED_BEACON_KEY,
    newValue: localStorage.getItem(DRAFT_SAVED_BEACON_KEY),
  }))
}

/** 接收编排是 async（读库在微任务后），冲刷后断言 */
async function flushBeacon() {
  await vi.advanceTimersByTimeAsync(0)
}

async function openTargetFile(openFiles: ReturnType<typeof useOpenFiles>, path = PATH) {
  await openFiles.openFile({ path, name: path.split('/').pop() || path })
  await vi.advanceTimersByTimeAsync(0)
}

describe('useOpenFiles 跨标签草稿同步（P-20261006-08）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    const theme = useThemeStore()
    if (!theme.naiveTheme) {
      // @ts-expect-error: force default
      theme.$state = { currentTheme: 'dark', naiveTheme: undefined, naiveOverrides: undefined }
    }
    projectId = `proj-sync-${++projSeq}`
    useProjectStore().currentProjectId = projectId
    vi.mocked(readDraft).mockResolvedValue(null)
    vi.mocked(readUntitledDraft).mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('双实例：tab A 落库较新草稿 → tab B 收信标重载并轻提示；tab A 自身不回环不提示', async () => {
    const tabA = useOpenFiles()
    const spyA = lastMessageApi()
    const tabB = useOpenFiles()
    const spyB = lastMessageApi()
    await openTargetFile(tabA)
    await openTargetFile(tabB)

    // tab A 编辑并防抖落库（draftDb mock 掉信标发射，接收侧由下方 dispatch 模拟）
    tabA.updateContent(PATH, 'A-edited')
    await vi.advanceTimersByTimeAsync(2000)
    expect(tabA.openFiles.value[0]!.content).toBe('A-edited')

    // 模拟 tab A 的落库信标到达两页：A 内容已一致（静默对账），B 重载 + 轻提示
    vi.mocked(readDraft).mockResolvedValue({ content: 'A-edited', savedAt: Date.now() + 1, baseHash: 'hash-A' })
    emitBeacon(projectId, PATH, Date.now() + 1)
    await flushBeacon()

    expect(tabB.openFiles.value[0]!.content).toBe('A-edited')
    expect(tabB.openFiles.value[0]!.originalContent).toBe('file content') // 重载保持脏态
    expect(spyB.info).toHaveBeenCalledTimes(1)
    // A 自身不回环：内容已是信标值，短路吸收，零提示
    expect(tabA.openFiles.value[0]!.content).toBe('A-edited')
    expect(spyA.info).not.toHaveBeenCalled()
  })

  it('静默窗：本文件 2s 内有键盘活动时不重载（保守防打断）', async () => {
    const tabB = useOpenFiles()
    const spyB = lastMessageApi()
    await openTargetFile(tabB)

    tabB.updateContent(PATH, 'B-typing') // editAt = now
    vi.mocked(readDraft).mockResolvedValue({ content: 'other-tab-newer', savedAt: Date.now() + 1, baseHash: 'hash-A' })
    vi.mocked(readDraft).mockClear() // 打开探测已消费过读原语，此后零调用 = 早退在读库前
    emitBeacon(projectId, PATH, Date.now() + 1)
    await flushBeacon()

    expect(tabB.openFiles.value[0]!.content).toBe('B-typing') // 打字中不被覆盖
    expect(spyB.info).not.toHaveBeenCalled()
    expect(readDraft).not.toHaveBeenCalled()
  })

  it('更旧信标（savedAt ≤ 本页已知）直接跳过：自写即记账，不回灌不读库', async () => {
    const tabB = useOpenFiles()
    const spyB = lastMessageApi()
    await openTargetFile(tabB)
    tabB.updateContent(PATH, 'B-edited')
    await vi.advanceTimersByTimeAsync(2000) // 防抖落库 → stamp = 此刻
    const writeAt = Date.now()

    vi.mocked(readDraft).mockClear() // 同上：排除打开探测的既有消费
    emitBeacon(projectId, PATH, writeAt - 1000) // 对方更旧的写入
    await flushBeacon()

    expect(tabB.openFiles.value[0]!.content).toBe('B-edited')
    expect(spyB.info).not.toHaveBeenCalled()
    expect(readDraft).not.toHaveBeenCalled()
  })

  it('乒乓检测：窗口内第 3 次收到同一文件的对方更新 → warning 提示关一处，随后窗口重开', async () => {
    const tabB = useOpenFiles()
    const spyB = lastMessageApi()
    await openTargetFile(tabB)

    // 对方连续交替写：每次信标都带更新 savedAt，本页依次重载
    let latest = 0
    vi.mocked(readDraft).mockImplementation(async () => ({ content: `v${latest}`, savedAt: latest, baseHash: 'hash-A' }))
    const emit = (savedAt: number) => { latest = savedAt; emitBeacon(projectId, PATH, savedAt) }
    emit(1000); await flushBeacon()
    emit(2000); await flushBeacon()
    expect(spyB.warning).not.toHaveBeenCalled()
    emit(3000); await flushBeacon() // 第 3 次命中 → 提示一次，窗口重开
    expect(spyB.warning).toHaveBeenCalledTimes(1)
    emit(4000); await flushBeacon() // 重开后计数 1，不再提示
    expect(spyB.warning).toHaveBeenCalledTimes(1)
    // 内容始终跟到最新（提示不打断同步本身）
    expect(tabB.openFiles.value[0]!.content).toBe('v4000')
  })

  it('baseHash 陈旧守卫：对方草稿基线 ≠ 本页磁盘基线（本页已保存落盘）→ 不回灌', async () => {
    const tabB = useOpenFiles()
    const spyB = lastMessageApi()
    await openTargetFile(tabB)

    // 本页编辑后保存落盘：baseHash 随写响应推进为 hash-B，同步态随保存清账
    tabB.updateContent(PATH, 'B-saved')
    await vi.advanceTimersByTimeAsync(2000)
    await tabB.saveCurrentFile()
    expect(tabB.openFiles.value[0]!.baseHash).toBe('hash-B')

    // 保存前对方的旧草稿信标迟到：基线仍是旧磁盘 hash-A → 陈旧，不回灌
    vi.mocked(readDraft).mockResolvedValue({ content: 'other-stale', savedAt: Date.now() + 5, baseHash: 'hash-A' })
    emitBeacon(projectId, PATH, Date.now() + 5)
    await flushBeacon()

    expect(tabB.openFiles.value[0]!.content).toBe('B-saved')
    expect(spyB.info).not.toHaveBeenCalled()
  })

  it('内容已一致静默对账：只推进 stamp，不重载不提示', async () => {
    const tabB = useOpenFiles()
    const spyB = lastMessageApi()
    await openTargetFile(tabB)

    vi.mocked(readDraft).mockResolvedValue({ content: 'file content', savedAt: Date.now() + 1, baseHash: 'hash-A' })
    emitBeacon(projectId, PATH, Date.now() + 1)
    await flushBeacon()

    expect(tabB.openFiles.value[0]!.content).toBe('file content')
    expect(spyB.info).not.toHaveBeenCalled()
  })

  it('untitled 草稿同链：信标走 readUntitledDraft 原语重载', async () => {
    const tabB = useOpenFiles()
    const spyB = lastMessageApi()
    tabB.openUntitled()
    expect(tabB.openFiles.value[0]!.path).toBe('untitled://1')

    vi.mocked(readUntitledDraft).mockResolvedValue({ content: 'u-body', savedAt: 500 })
    emitBeacon(projectId, 'untitled://1', 500)
    await flushBeacon()

    expect(tabB.openFiles.value[0]!.content).toBe('u-body')
    expect(spyB.info).toHaveBeenCalledTimes(1)
    expect(readDraft).not.toHaveBeenCalledWith(projectId, 'untitled://1') // 命名空间不走文件读原语
  })

  it('防御面：跨项目信标不波及、坏载荷不炸、远程命名空间跨项目有效', async () => {
    const tabB = useOpenFiles()
    const spyB = lastMessageApi()
    await openTargetFile(tabB)

    emitBeacon('proj-OTHER', PATH, Date.now() + 1) // 异项目同路径：路由对位失败
    await flushBeacon()
    window.dispatchEvent(new StorageEvent('storage', { key: DRAFT_SAVED_BEACON_KEY, newValue: 'not-json' }))
    window.dispatchEvent(new StorageEvent('storage', { key: DRAFT_SAVED_BEACON_KEY, newValue: JSON.stringify({ project: projectId }) }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'theme-settings', newValue: 'dark' })) // 他键不触碰
    await flushBeacon()
    expect(tabB.openFiles.value[0]!.content).toBe('file content')
    expect(spyB.info).not.toHaveBeenCalled()

    // 远程伪路径：projectId 维度路由到固定命名空间，无选中项目也参与（与写入侧同路由）
    useProjectStore().currentProjectId = ''
    const RPATH = 'remote:h1:/tmp/a.txt'
    await openTargetFile(tabB, RPATH)
    vi.mocked(readDraft).mockResolvedValue({ content: 'remote-synced', savedAt: 900, baseHash: 'rhash-A' })
    emitBeacon(REMOTE_DRAFT_PROJECT, RPATH, 900)
    await flushBeacon()
    expect(tabB.openFiles.value.find(f => f.path === RPATH)!.content).toBe('remote-synced')
    expect(spyB.info).toHaveBeenCalledTimes(1)
  })
})
