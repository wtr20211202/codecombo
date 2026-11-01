import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { useTerminalSessionsStore } from '@/stores/terminal-sessions'

// 终端会话统一数据源（P1）单测——本文件只钉分组视图 toggle（P-20261003-238）
// 的契约面：默认 flat（未设置/非法值回落）、set 即持久化（safeStorage，刷新
// 后读回）、resetForTest 复位内存态。会话列表/快照对账面由 e2e 守门（依赖
// 服务端真实会话拓扑），store 既有行为不在本文件扩张。

const GROUP_KEY = 'sc.terminalSessions.groupMode'

describe('terminalSessionsStore groupMode（P-20261003-238）', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    window.localStorage.clear()
  })

  it('默认 flat；set(runtime) 切换并持久化', () => {
    const store = useTerminalSessionsStore()
    expect(store.groupMode).toBe('flat')
    store.setGroupMode('runtime')
    expect(store.groupMode).toBe('runtime')
    expect(window.localStorage.getItem(GROUP_KEY)).toBe('runtime')
  })

  it('持久化值刷新后读回（新 pinia 实例模拟重进）', () => {
    useTerminalSessionsStore().setGroupMode('runtime')
    setActivePinia(createPinia())
    expect(useTerminalSessionsStore().groupMode).toBe('runtime')
  })

  it('非法持久化值回落 flat，不吞类型外状态', () => {
    window.localStorage.setItem(GROUP_KEY, 'grid')
    expect(useTerminalSessionsStore().groupMode).toBe('flat')
  })

  it('resetForTest 复位为 flat（用例隔离）', () => {
    const store = useTerminalSessionsStore()
    store.setGroupMode('runtime')
    store.resetForTest()
    expect(store.groupMode).toBe('flat')
  })
})
