import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref, type VNode, type VNodeChild } from 'vue'

// ── mock 边界（groupsChanged.test.ts 同族装配）：vue-i18n 真 zh-CN 词条 /
// vue-router 桩 / naive-ui useMessage 桩 / uiStateApi 桩；confirmDialog 换
// 捕获桩——本文件断言「传给确认弹层的正文形态」，不真渲染 discrete dialog ──
const { uiGet, uiPatch, confirmDialogMock } = vi.hoisted(() => ({
  uiGet: vi.fn<() => Promise<{ data?: Record<string, unknown> }>>(),
  uiPatch: vi.fn<(data: Record<string, unknown>) => Promise<unknown>>(),
  confirmDialogMock: vi.fn<(options: Record<string, unknown>) => Promise<boolean>>(),
}))

vi.mock('vue-i18n', async () => {
  const zh = (await import('../../locales/zh-CN')).default
  const get = (o: Record<string, unknown>, k: string): unknown =>
    k.split('.').reduce<unknown>((a, c) => (a as Record<string, unknown> | undefined)?.[c], o)
  return {
    useI18n: () => ({
      t: (key: string, params?: Record<string, unknown>) => {
        const raw = (get(zh, key) as string) ?? key
        return params
          ? raw.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`))
          : raw
      },
    }),
  }
})

vi.mock('vue-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-router')>()
  return {
    ...actual,
    useRouter: () => ({
      currentRoute: ref({ name: '' }),
      push: vi.fn(),
    }),
  }
})

vi.mock('naive-ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('naive-ui')>()
  return {
    ...actual,
    useMessage: () => ({
      error: vi.fn(), warning: vi.fn(), success: vi.fn(), info: vi.fn(),
    }),
  }
})

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>()
  return { ...actual, uiStateApi: { get: uiGet, patch: uiPatch } }
})

vi.mock('../../composables/useDialog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../composables/useDialog')>()
  return { ...actual, confirmDialog: confirmDialogMock as never }
})

import { useAgentTerminalGroups } from '../../composables/useAgentTerminalGroups'
import { useApprovalsStore } from '../../stores/approvals'
import { useProjectStore } from '../../stores/project'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import type { AgentTermSession } from '../../composables/useAgentTerminal'

/**
 * 结束会话确认的 pending 审批警示（P-20261003-275）单测：会话有等待裁决的
 * 审批时，侧栏「结束会话」确认弹层正文由纯字符串升级为渲染函数（正文行 +
 * 橙色警示行）；无 pending 时维持字符串原样（零回归面）。外部接管会话的
 * 「解除接管」分支不附警示（会话原样存活、裁决仍可送达）。
 */

/** 取 confirmDialog 捕获桩最近一次收到的 options */
function lastConfirmOptions(): Record<string, unknown> {
  expect(confirmDialogMock).toHaveBeenCalledTimes(1)
  return confirmDialogMock.mock.calls[0]![0]!
}

/** 渲染函数形态正文的纯文本（按 VNode 树深度优先拼接） */
function vnodeText(node: VNodeChild): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(vnodeText).join('')
  const v = node as VNode
  if (Array.isArray(v.children)) return v.children.map(vnodeText).join('')
  return typeof v.children === 'string' ? v.children : ''
}

describe('useAgentTerminalGroups 结束会话确认 pending 审批警示（P-20261003-275）', () => {
  let wrapper: VueWrapper | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    uiGet.mockReset()
    uiPatch.mockReset()
    uiPatch.mockResolvedValue(undefined)
    uiGet.mockResolvedValue({ data: {} })
    confirmDialogMock.mockReset()
    confirmDialogMock.mockResolvedValue(false) // 取消：只断言弹层形态，不走 destroy
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  function mountHost(sessions: AgentTermSession[]): ReturnType<typeof useAgentTerminalGroups> {
    const sessionsRef = ref<AgentTermSession[]>(sessions)
    const selectedId = ref('')
    let m!: ReturnType<typeof useAgentTerminalGroups>
    const Host = defineComponent({
      setup() {
        m = useAgentTerminalGroups({
          sessions: sessionsRef,
          selectedId,
          lastViewedSessionId: ref(''),
          sessionsStore: useTerminalSessionsStore(),
          projectStore: useProjectStore(),
          rename: vi.fn(),
          destroy: vi.fn(),
          kill: vi.fn(),
          attachProject: vi.fn(),
          getSelectedProjectSession: () => null,
          hide: vi.fn(),
          afterRestore: vi.fn(),
        })
        return () => h('div')
      },
    })
    wrapper = mount(Host, { attachTo: document.body })
    return m
  }

  function seedPendingApproval(sessionId: string): void {
    useApprovalsStore().upsert({ id: 'a-1', sessionId, op: 'file.replace', status: 'pending' })
  }

  it('会话有 pending 审批：正文升级渲染函数，含原正文 + 橙色警示行', async () => {
    seedPendingApproval('s-1')
    const m = mountHost([{ id: 's-1', name: '会话一', runtime: 'claude', launched: true }])

    await m.onSessionAction({ sessionId: 's-1', key: 'destroy' })
    await flushPromises()

    const opts = lastConfirmOptions()
    expect(typeof opts.content).toBe('function')
    const text = vnodeText((opts.content as () => VNodeChild)())
    expect(text).toContain('确认结束「会话一」')
    expect(text).toContain('等待裁决的审批')
  })

  it('无 pending 审批：正文维持纯字符串原样', async () => {
    const m = mountHost([{ id: 's-2', name: '会话二', runtime: 'claude', launched: true }])

    await m.onSessionAction({ sessionId: 's-2', key: 'destroy' })
    await flushPromises()

    const opts = lastConfirmOptions()
    expect(opts.content).toBe('确认结束「会话二」？其中运行的进程将一并终止')
  })

  it('外部接管会话解除接管分支：不附警示（会话存活裁决仍可送达）', async () => {
    seedPendingApproval('s-3')
    const m = mountHost([{
      id: 's-3', name: '外部会话', runtime: '', launched: true, origin: 'external',
    }])

    await m.onSessionAction({ sessionId: 's-3', key: 'destroy' })
    await flushPromises()

    const opts = lastConfirmOptions()
    expect(typeof opts.content).toBe('string')
    expect(String(opts.content)).not.toContain('等待裁决的审批')
  })

  it('项目会话结束确认同款警示（onProjectSessionDestroy 同源正文）', async () => {
    const store = useTerminalSessionsStore()
    const m = mountHost([])
    // 项目会话侧读 sessionsStore.projectSessions（kind==='shell' && projectId）：
    // 按快照对账口径播种一条
    store.applySnapshot([{ id: 'p-1', name: '项目会话', projectId: 'proj-1', kind: 'shell' }])
    await flushPromises()
    seedPendingApproval('p-1')

    await m.onProjectSessionDestroy({ sessionId: 'p-1', key: 'destroy' })
    await flushPromises()

    const opts = lastConfirmOptions()
    expect(typeof opts.content).toBe('function')
    expect(vnodeText((opts.content as () => VNodeChild)())).toContain('等待裁决的审批')
  })
})
