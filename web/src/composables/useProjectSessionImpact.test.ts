import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'

// 终端域 API 全量 mock：composable 经 terminal-sessions store 的 refresh 只依赖 list
vi.mock('../api/domains/terminal', () => ({
  terminalApi: {
    list: vi.fn(),
    createAgent: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    close: vi.fn(),
    resize: vi.fn(),
  },
  getTerminalWsUrl: (id: string) => `ws://${id}`,
}))

import { terminalApi } from '../api/domains/terminal'
import { useProjectStore } from '../stores/project'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useAssistantTaskStore } from '../stores/assistantTask'
import { useProjectSessionImpact } from './useProjectSessionImpact'

const mockedApi = vi.mocked(terminalApi, true)

/** 统一包一层响应形态：axios 拦截器返回 gin body，业务负载在 res.data（真实形态） */
function apiRes<T>(data: T) {
  return Promise.resolve({ data }) as any
}

beforeEach(() => {
  vi.resetAllMocks()
  useTerminalSessionsStore().resetForTest()
  useAssistantTaskStore().resetForTest()
  const projectStore = useProjectStore()
  projectStore.$patch((state) => {
    state.projects = [
      { id: 'p1', name: 'P1', path: '/home/u/proj', currentBranch: '', remoteURL: '', valid: true },
      { id: 'p2', name: 'P2', path: '/home/u/other', currentBranch: '', remoteURL: '', valid: true },
    ]
  })
})

describe('useProjectSessionImpact', () => {
  it('按 projectId 过滤：只数该项目绑定会话，agent 系统会话（projectId 恒空）不计', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' },
      { id: 'term-2', name: 'T2', kind: 'shell', projectId: 'p1' },
      { id: 'term-3', name: 'T3', kind: 'shell', projectId: 'p2' },
      { id: 'agent-a', name: '智能体 1', kind: 'agent' },
    ])
    const pid = ref<string | undefined>('p1')
    const { total, running } = useProjectSessionImpact(pid)
    expect(total.value).toBe(2)
    expect(running.value).toBe(0)
  })

  it('运行中计数：OSC 133 命令运行态 或 assistant task running 上报任一命中', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' },
      { id: 'term-2', name: 'T2', kind: 'shell', projectId: 'p1' },
      { id: 'term-3', name: 'T3', kind: 'shell', projectId: 'p1' },
    ])
    store.reportOsc('term-1', 'C') // 命令运行中
    const taskStore = useAssistantTaskStore()
    taskStore.progressFor('term-2', { task: '重构', status: 'running' }) // agent 进度上报
    store.reportOsc('term-3', 'D') // 已结束不计

    const { total, running } = useProjectSessionImpact(ref('p1'))
    expect(total.value).toBe(3)
    expect(running.value).toBe(2)
  })

  it('响应式跟随：projectId 切换与运行态变化即时反映', async () => {
    const store = useTerminalSessionsStore()
    mockedApi.list.mockReturnValue(apiRes([
      { id: 'term-1', name: 'T1', kind: 'shell', projectId: 'p1' },
    ]) as any)
    const pid = ref<string | undefined>('p1')
    const { total, running, refreshSnapshot } = useProjectSessionImpact(pid)

    expect(total.value).toBe(0) // 未加载过
    refreshSnapshot()
    await Promise.resolve()
    expect(total.value).toBe(1)

    pid.value = 'p2' // 换目标项目 → 清零
    expect(total.value).toBe(0)

    store.reportOsc('term-1', 'C')
    pid.value = 'p1'
    expect(total.value).toBe(1)
    expect(running.value).toBe(1)
  })

  it('refreshSnapshot 失败静默：知情报不阻断（refresh 返回 false 不冒泡）', async () => {
    mockedApi.list.mockRejectedValueOnce(new Error('network') as any)
    const { refreshSnapshot } = useProjectSessionImpact(ref('p1'))
    expect(() => refreshSnapshot()).not.toThrow()
    await Promise.resolve()
  })

  it('驻留智能体会话计数（P-20261006-36）：免项目绑定 agent 会话按创建目录前缀补计入', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      // 驻留：agent 会话创建目录在项目根内（根 + 子目录两形态）
      { id: 'a1', name: 'A1', kind: 'agent', projectId: '', path: '/home/u/proj' },
      { id: 'a2', name: 'A2', kind: 'agent', projectId: '', path: '/home/u/proj/packages/app' },
      // 不驻留：目录在项目外
      { id: 'a3', name: 'A3', kind: 'agent', projectId: '', path: '/home/u/elsewhere' },
      // external 接管会话不参与（其「关闭」=解除接管，项目删除不该碰）
      { id: 'a4', name: 'A4', kind: 'agent', projectId: '', path: '/home/u/proj', origin: 'external' },
      // 项目绑定会话走既有 projectId 计数，不重复计入驻留
      { id: 't1', name: 'T1', kind: 'shell', projectId: 'p1', path: '/home/u/proj' },
    ])
    const { total, residentTotal, residentAgents } = useProjectSessionImpact(ref('p1'))
    expect(total.value).toBe(1) // 仅 t1
    expect(residentTotal.value).toBe(2) // a1 + a2（a3 不驻留、a4 external、t1 绑定）
    expect(residentAgents.value.map(s => s.id)).toEqual(['a1', 'a2'])
  })

  it('驻留计数随项目切换与路径失配归零：大小写敏感（前端刻意不折叠）', () => {
    const store = useTerminalSessionsStore()
    store.applySnapshot([
      { id: 'a1', name: 'A1', kind: 'agent', projectId: '', path: '/home/u/proj' },
      { id: 'a2', name: 'A2', kind: 'agent', projectId: '', path: '/home/u/PROJ' },
    ])
    const pid = ref<string | undefined>('p1')
    const { residentTotal } = useProjectSessionImpact(pid)
    expect(residentTotal.value).toBe(1)
    pid.value = 'p2'
    expect(residentTotal.value).toBe(0) // 目标项目路径在 /home/u/other，均不驻留
  })
})
