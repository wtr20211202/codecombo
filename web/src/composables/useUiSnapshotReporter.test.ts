import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ── mock 边界：外部依赖只有 settingsApi（开关读取）与 uiSnapshotApi（上报）。
// 聚合（buildUiSnapshot）、去抖窗口、心跳、相等短路、开关门控全是真实现；
// store 侧用真实 pinia（project / terminal-sessions）+ 真实 usePanelLayout /
// useEditorNavHistory 模块（resetPanelLayout 复位模块级单例） ──
const { getSettingsMock, putMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn<() => Promise<unknown>>(),
  putMock: vi.fn<(data: unknown) => Promise<unknown>>(),
}))
vi.mock('../api/domains/system', () => ({
  settingsApi: { get: () => getSettingsMock() },
  uiSnapshotApi: { put: (data: unknown) => putMock(data) },
}))

import { setActivePinia, createPinia } from 'pinia'
import { startUiSnapshotReporter, UI_SNAPSHOT_DEBOUNCE_MS, UI_SNAPSHOT_HEARTBEAT_MS } from './useUiSnapshotReporter'
import { useProjectStore } from '../stores/project'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { resetPanelLayout, usePanelLayout } from './usePanelLayout'
import { useEditorNavHistory } from './useEditorNavHistory'
import { OPS_SETTINGS_CHANGED } from '../utils/opsEvents'
import type { UiSnapshotPayload } from '../api/domains/system'

function lastPayload(call: number): UiSnapshotPayload {
  return putMock.mock.calls[call]![0] as UiSnapshotPayload
}

beforeEach(() => {
  vi.useFakeTimers()
  getSettingsMock.mockReset().mockResolvedValue({ data: { uiSnapshotEnabled: true } })
  putMock.mockReset().mockResolvedValue({ message: 'accepted' })
  setActivePinia(createPinia())
  resetPanelLayout()
  // 导航历史是模块级单例：先换 pid 强制作废（同 pid 重入是幂等 no-op）再回空，
  // 清掉上一用例残留的 activeLocation（去抖/聚合用例间互不串场）
  useEditorNavHistory().beginSession('test-reset')
  useEditorNavHistory().beginSession('')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startUiSnapshotReporter 现场上报', () => {
  it('挂载首报：聚合各数据源为快照载荷（activeFile 齐全时含 path/line/column）', async () => {
    const projectStore = useProjectStore()
    projectStore.currentProjectId = 'proj-1'
    const layout = usePanelLayout()
    layout.sideView.value = 'files'
    layout.showSidePanel.value = true
    layout.bottomTab.value = 'terminal'
    layout.showBottomPanel.value = true
    useEditorNavHistory().reportLocation('web/src/main.ts', 200, 7)
    useTerminalSessionsStore().setActiveSession('term-9')

    const reporter = startUiSnapshotReporter()
    try {
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS + 10)
      expect(putMock).toHaveBeenCalledTimes(1)
      expect(lastPayload(0)).toEqual({
        activeProjectId: 'proj-1',
        activeFile: { path: 'web/src/main.ts', line: 200, column: 7 },
        visiblePanels: { side: 'files', sideOpen: true, bottom: 'terminal', bottomOpen: true },
        activeTerminalSessionId: 'term-9',
      })
      expect(reporter.getLastSent()).toEqual(lastPayload(0))
    } finally {
      reporter.stop()
    }
  })

  it('无激活文件/空 id 字段省略不传（诚实降级，不传 null/0）', async () => {
    const reporter = startUiSnapshotReporter()
    try {
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS + 10)
      expect(putMock).toHaveBeenCalledTimes(1)
      expect(lastPayload(0)).toEqual({
        visiblePanels: { side: 'files', sideOpen: true, bottom: 'terminal', bottomOpen: false },
      })
    } finally {
      reporter.stop()
    }
  })

  it('去抖窗口：窗口内连续变化只落一次盘（尾沿值），稳态重复不 POST', async () => {
    const nav = useEditorNavHistory()
    const reporter = startUiSnapshotReporter()
    try {
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS + 10)
      expect(putMock).toHaveBeenCalledTimes(1)

      // 窗口内连续两次变化：只有尾沿落一次
      nav.reportLocation('a.ts', 10)
      await vi.advanceTimersByTimeAsync(1000)
      nav.reportLocation('a.ts', 42)
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS + 10)
      expect(putMock).toHaveBeenCalledTimes(2)
      expect(lastPayload(1)?.activeFile).toEqual({ path: 'a.ts', line: 42 })

      // 无变化再等去抖窗口：相等短路，零请求
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS * 3)
      expect(putMock).toHaveBeenCalledTimes(2)
    } finally {
      reporter.stop()
    }
  })

  it('心跳：无变化也强制上报刷新 TTL', async () => {
    const reporter = startUiSnapshotReporter()
    try {
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS + 10)
      expect(putMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_HEARTBEAT_MS)
      expect(putMock).toHaveBeenCalledTimes(2)
    } finally {
      reporter.stop()
    }
  })

  it('开关关：不 POST；settings.changed 广播重读后即时恢复', async () => {
    const reporter = startUiSnapshotReporter()
    try {
      // 开关关（挂载即读到）
      getSettingsMock.mockResolvedValue({ data: { uiSnapshotEnabled: false } })
      window.dispatchEvent(new Event(OPS_SETTINGS_CHANGED))
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS + 10)
      expect(putMock).not.toHaveBeenCalled()

      // 设置页翻回开：广播重读，下一拍恢复上报
      getSettingsMock.mockResolvedValue({ data: { uiSnapshotEnabled: true } })
      window.dispatchEvent(new Event(OPS_SETTINGS_CHANGED))
      await vi.advanceTimersByTimeAsync(10)
      useEditorNavHistory().reportLocation('b.ts', 5)
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS + 10)
      expect(putMock).toHaveBeenCalledTimes(1)
    } finally {
      reporter.stop()
    }
  })

  it('隐藏页不上报（多标签页可见页胜）；上报失败静默不抛', async () => {
    const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const reporter = startUiSnapshotReporter()
    try {
      useEditorNavHistory().reportLocation('c.ts', 1)
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS + UI_SNAPSHOT_HEARTBEAT_MS + 10)
      expect(putMock).not.toHaveBeenCalled()
      hiddenSpy.mockReturnValue(false)

      // 恢复可见后下一个变化照常落盘；失败路径不抛出
      putMock.mockRejectedValueOnce(new Error('network down'))
      useEditorNavHistory().reportLocation('c.ts', 2)
      await vi.advanceTimersByTimeAsync(UI_SNAPSHOT_DEBOUNCE_MS + 10)
      expect(putMock).toHaveBeenCalledTimes(1)
      expect(reporter.getLastSent()).toBeNull()
    } finally {
      reporter.stop()
    }
  })
})
