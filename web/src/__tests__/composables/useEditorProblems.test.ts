import { describe, it, expect, vi, afterEach } from 'vitest'
import { connectEditorProblems, disconnectEditorProblems, useEditorProblems } from '../../../src/composables/useEditorProblems'
import { MARKER_SEVERITY } from '../../../src/utils/editorProblems'

/** 结构化 mock：只实现 useEditorProblems 依赖的最小 monaco.editor 面 */
function mockMonaco(markers: unknown[] = []) {
  const listeners: Array<(uris: unknown[]) => void> = []
  const api = {
    editor: {
      onDidChangeMarkers(cb: (uris: unknown[]) => void) {
        listeners.push(cb)
        return { dispose: () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1) } }
      },
      getModelMarkers: vi.fn(() => markers),
    },
  }
  return {
    api,
    listeners,
    /** 模拟 worker 算完 markers 后 monaco 派发的变更事件 */
    fire() { for (const cb of [...listeners]) cb([]) },
  }
}

afterEach(() => {
  vi.useRealTimers()
  disconnectEditorProblems()
})

describe('useEditorProblems', () => {
  it('接线即拉一次聚合；变更事件经 300ms 防抖后重算', async () => {
    vi.useFakeTimers()
    const m = mockMonaco([
      { resource: { path: '/src/a.ts' }, startLineNumber: 3, startColumn: 1, severity: MARKER_SEVERITY.Error, message: 'x' },
    ])
    connectEditorProblems(m.api)
    // 接线时同步初算
    expect(useEditorProblems().aggregate.total).toBe(1)
    expect(useEditorProblems().aggregate.groups[0]!.path).toBe('src/a.ts')

    // 连发多次变更事件：只调度一次防抖尾帧
    m.fire(); m.fire(); m.fire()
    expect(m.api.editor.getModelMarkers).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(299)
    expect(m.api.editor.getModelMarkers).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(m.api.editor.getModelMarkers).toHaveBeenCalledTimes(2)
  })

  it('重复 connect 幂等：只注册一个监听（分屏双编辑器重挂场景）', () => {
    const m = mockMonaco([])
    connectEditorProblems(m.api)
    connectEditorProblems(m.api)
    expect(m.listeners).toHaveLength(1)
  })

  it('disconnect 后事件不再触发重算，聚合清零', () => {
    vi.useFakeTimers()
    const m = mockMonaco([
      { resource: { path: '/a.ts' }, startLineNumber: 1, startColumn: 1, severity: MARKER_SEVERITY.Warning, message: 'w' },
    ])
    connectEditorProblems(m.api)
    expect(useEditorProblems().aggregate.total).toBe(1)
    disconnectEditorProblems()
    expect(useEditorProblems().aggregate.total).toBe(0)
    m.fire()
    vi.advanceTimersByTime(1000)
    expect(m.api.editor.getModelMarkers).toHaveBeenCalledTimes(1)
  })

  it('onDidChangeMarkers 返回无效句柄时不置连接态（防御第三方包装）', () => {
    const bad = { editor: { onDidChangeMarkers: () => null, getModelMarkers: () => [] } }
    connectEditorProblems(bad)
    // 无效句柄 → 未连接 → 再次 connect 可重试
    const m = mockMonaco([])
    connectEditorProblems(m.api)
    expect(m.listeners).toHaveLength(1)
  })
})
