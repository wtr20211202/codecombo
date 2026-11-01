import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref, type VNode } from 'vue'
import type { MessageApi } from 'naive-ui'

// ── mock 边界：本组合式的外部依赖只有 ① 确认弹窗（敏感/多行/大文本两道闸共用
// confirmDialog）② 「不再提示」偏好存取（stub 掉 useTerminalClipboard 的存取面，
// 64KB 阈值常量保持真值参与判定）③ 写入链（Layout provide 的 sendToTerminal）。
// t / message 走 deps 注入，测试给 key 直通与记录器，断言按 key 不按文案 ──
const { confirmMock, pasteNoWarnPref } = vi.hoisted(() => ({
  confirmMock: vi.fn<(opts?: Record<string, unknown>) => Promise<boolean>>(),
  pasteNoWarnPref: { v: false },
}))

vi.mock('./useDialog', () => ({
  confirmDialog: confirmMock,
}))

vi.mock('./useTerminalClipboard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useTerminalClipboard')>()
  return {
    ...actual,
    isPasteMultilineNoWarn: () => pasteNoWarnPref.v,
    setPasteMultilineNoWarn: (v: boolean) => { pasteNoWarnPref.v = v },
  }
})

import {
  planEditorSend,
  renderSendConfirmBody,
  useEditorSendToTerminal,
  type EditorSendPlan,
  type SendToTerminalOutcome,
} from './useEditorSendToTerminal'
import { PASTE_SIZE_WARN_BYTES } from './useTerminalClipboard'

// key 直通 t（插值参数以 JSON 后缀保留可断言），message 为记录器——断言按 key
const tKey = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key
// vue-i18n ComposerTranslation 带重载面，deps 注入面按实现子集 cast（与生产传
// useI18n().t 同形；测试只需 (key, params) 两参形态）
const t = tKey as unknown as Parameters<typeof useEditorSendToTerminal>[0]['t']
const messageMock = {
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}
const message = messageMock as unknown as MessageApi

function makeDeps(overrides?: {
  getSelection?: () => string
  send?: (text: string, opts?: { createIfMissing?: boolean }) => Promise<SendToTerminalOutcome>
}) {
  const send = overrides?.send ?? vi.fn<() => Promise<SendToTerminalOutcome>>(async () => 'sent')
  const api = useEditorSendToTerminal({
    getSelection: overrides?.getSelection ?? (() => 'echo hi'),
    send: send as (text: string, opts?: { createIfMissing?: boolean }) => Promise<SendToTerminalOutcome>,
    t,
    message,
  })
  return { api, send }
}

beforeEach(() => {
  vi.clearAllMocks()
  pasteNoWarnPref.v = false
  confirmMock.mockResolvedValue(true)
})

/** 从渲染函数产物里找「不再提示」勾选 VNode（正文结构 div > [p, div[div, pre], checkbox?]） */
function findCheckbox(vnode: VNode): VNode | null {
  for (const child of vnode.children as VNode[]) {
    if (!child) continue
    if (Array.isArray(child.children)) {
      const hit = findCheckbox(child)
      if (hit) return hit
    } else if ((child.props as Record<string, unknown> | null)?.['onUpdate:checked']) {
      return child
    }
  }
  return null
}

describe('planEditorSend 发送计划（纯函数）', () => {
  it('单行小文本：直接发送面，无任何确认维度命中', () => {
    const plan = planEditorSend('echo hi', false)
    expect(plan.payload).toBe('echo hi')
    expect(plan.large).toBe(false)
    expect(plan.multiline).toBe(false)
    expect(plan.lineCount).toBe(1)
  })

  it('尾部换行剥离（CRLF/LF/CR），正文保持原样', () => {
    expect(planEditorSend('echo hi\n', false).payload).toBe('echo hi')
    expect(planEditorSend('echo hi\r\n', false).payload).toBe('echo hi')
    expect(planEditorSend('echo hi\r', false).payload).toBe('echo hi')
  })

  it('多行命中确认面：偏好未豁免 multiline=true，豁免后 false（lineCount 不变）', () => {
    const text = 'echo a\necho b\necho c'
    expect(planEditorSend(text, false).multiline).toBe(true)
    expect(planEditorSend(text, true).multiline).toBe(false)
    expect(planEditorSend(text, true).lineCount).toBe(3)
  })

  it('超 64KB：单行也命中 large（不受偏好豁免），kb 按真实 UTF-8 字节算', () => {
    const big = 'x'.repeat(PASTE_SIZE_WARN_BYTES + 1)
    const plan = planEditorSend(big, true)
    expect(plan.large).toBe(true)
    expect(plan.kb).toBe(Math.round((PASTE_SIZE_WARN_BYTES + 1) / 1024))
  })

  it('预览行取前 8 行', () => {
    const text = Array.from({ length: 12 }, (_, i) => `echo ${i}`).join('\n')
    const plan = planEditorSend(text, true)
    expect(plan.previewLines).toHaveLength(8)
    expect(plan.previewLines[0]).toBe('echo 0')
  })

  it('阈值边界：恰好 64KB 不命中 large', () => {
    expect(planEditorSend('x'.repeat(PASTE_SIZE_WARN_BYTES), true).large).toBe(false)
  })
})

describe('sendSelectionToTerminal 确认链', () => {
  it('空选区：不弹窗不发送', async () => {
    const { api, send } = makeDeps({ getSelection: () => '' })
    await api.sendSelectionToTerminal()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('纯换行选区：剥尾后无正文，放弃不发送', async () => {
    const { api, send } = makeDeps({ getSelection: () => '\n' })
    await api.sendSelectionToTerminal()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('单行干净文本：零确认直达写入链，尾部补 \\r 且携带 createIfMissing', async () => {
    const { api, send } = makeDeps({ getSelection: () => 'echo hi' })
    await api.sendSelectionToTerminal()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith('echo hi\r', { createIfMissing: true })
    expect(messageMock.success).toHaveBeenCalledWith('editor.sendToTerminal.sent')
  })

  it('敏感启发式命中先提示：取消 = 整体放弃', async () => {
    confirmMock.mockResolvedValue(false)
    const { api, send } = makeDeps({ getSelection: () => 'git clone https://user:pass@example.com/repo.git' })
    await api.sendSelectionToTerminal()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      title: 'editor.sendToTerminal.sensitiveTitle',
      type: 'warning',
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('敏感确认通过后单行小文本不再有第二道弹窗，直接发送', async () => {
    const { api, send } = makeDeps({ getSelection: () => 'export token=ghp_abcdefghijklmnop' })
    await api.sendSelectionToTerminal()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('export token=ghp_abcdefghijklmnop\r', { createIfMissing: true })
  })

  it('多行文本：多行确认弹窗（预览面），取消不发送，确认后发送', async () => {
    const { api, send } = makeDeps({ getSelection: () => 'echo a\necho b' })
    confirmMock.mockResolvedValueOnce(false)
    await api.sendSelectionToTerminal()
    expect(send).not.toHaveBeenCalled()
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({
      title: 'editor.sendToTerminal.multilineTitle',
      confirmText: 'editor.sendToTerminal.sendAnyway',
    })
    confirmMock.mockResolvedValueOnce(true)
    await api.sendSelectionToTerminal()
    expect(send).toHaveBeenCalledWith('echo a\necho b\r', { createIfMissing: true })
  })

  it('弹窗勾选「不再提示」：偏好落盘，下次多行不再弹确认直接发送', async () => {
    const { api, send } = makeDeps({ getSelection: () => 'echo a\necho b' })
    // 经 content 渲染函数驱动真实勾选联动（与 UI 同一条 onUpdate:checked 链）
    confirmMock.mockImplementationOnce(async (opts) => {
      const body = (opts!.content as () => VNode)()
      const cb = findCheckbox(body)
      expect(cb).not.toBeNull()
      ;(cb!.props as Record<string, (v: boolean) => void>)['onUpdate:checked']!(true)
      return true
    })
    await api.sendSelectionToTerminal()
    expect(pasteNoWarnPref.v).toBe(true)
    // 偏好已落：再次多行发送零弹窗直达
    await api.sendSelectionToTerminal()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('大文本（>64KB）：偏好已豁免仍弹体积感知版（无勾选渲染），取消不发送', async () => {
    pasteNoWarnPref.v = true
    const big = 'x'.repeat(PASTE_SIZE_WARN_BYTES + 1)
    const { api, send } = makeDeps({ getSelection: () => big })
    confirmMock.mockImplementationOnce(async (opts) => {
      expect(opts).toMatchObject({ title: 'editor.sendToTerminal.largeTitle' })
      const body = (opts!.content as () => VNode)()
      expect(findCheckbox(body)).toBeNull()
      return false
    })
    await api.sendSelectionToTerminal()
    expect(send).not.toHaveBeenCalled()
  })

  it('弹窗文案按档位携带行数/体积参数', async () => {
    const { api } = makeDeps({ getSelection: () => 'echo a\necho b' })
    confirmMock.mockImplementationOnce(async (opts) => {
      const body = (opts!.content as () => VNode)()
      // 正文首段 = 警示行（key 带 {n} 行数插值）
      const p = (body.children as VNode[])[0]!
      expect(p.children).toBe(
        `editor.sendToTerminal.multilineWarn:${JSON.stringify({ n: 2, kb: 0 })}`,
      )
      return true
    })
    await api.sendSelectionToTerminal()
  })

  it('写入链三态回告：cancelled 走高危取消提示，no-terminal 走无终端警示', async () => {
    const cancelled = makeDeps({
      send: async () => 'cancelled',
      getSelection: () => 'echo hi',
    })
    await cancelled.api.sendSelectionToTerminal()
    expect(messageMock.info).toHaveBeenCalledWith('terminal.cmdPreview.insertCancelled')

    const noTerm = makeDeps({
      send: async () => 'no-terminal',
      getSelection: () => 'echo hi',
    })
    await noTerm.api.sendSelectionToTerminal()
    expect(messageMock.warning).toHaveBeenCalledWith('editor.sendToTerminal.noTerminal')
  })
})

describe('renderSendConfirmBody 渲染面', () => {
  it('多行计划渲染勾选项，大文本计划不渲染', () => {
    const plan: EditorSendPlan = {
      payload: 'echo a\necho b', large: false, multiline: true,
      lineCount: 2, kb: 0, previewLines: ['echo a', 'echo b'],
    }
    const noWarn = ref(false)
    const body = renderSendConfirmBody(plan, noWarn, tKey) as VNode
    expect(findCheckbox(body)).not.toBeNull()
    const largePlan: EditorSendPlan = { ...plan, large: true, multiline: false }
    expect(findCheckbox(renderSendConfirmBody(largePlan, noWarn, tKey) as VNode)).toBeNull()
  })

  it('预览块只含前 N 行且换行连接', () => {
    const plan: EditorSendPlan = {
      payload: 'a\nb\nc', large: false, multiline: true,
      lineCount: 3, kb: 0, previewLines: ['a', 'b', 'c'],
    }
    const body = renderSendConfirmBody(plan, ref(false), tKey) as VNode
    const previewWrap = (body.children as VNode[])[1]!
    const pre = ((previewWrap.children as VNode[])[1]!)
    expect(pre.children).toBe('a\nb\nc')
    expect((pre.props as Record<string, string>).style).toContain('var(--font-mono')
  })
})
