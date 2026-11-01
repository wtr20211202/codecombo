import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as monaco from 'monaco-editor'
import type { MessageApi } from 'naive-ui'

// monaco-editor 全量入口在 jsdom 无法导入（monacoModelCache.test 同款 stub）：
// 本组合式只消费 ContentWidgetPositionPreference 枚举与 KeyMod/KeyCode 键码
// （0.55 content widget 定位走 position+preference，无 Range 面）
vi.mock('monaco-editor', () => ({
  // 键码常量取 vendored d.ts 同值（2048=CtrlCmd，KeyK=41）；仅作不透明载荷断言
  KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
  KeyCode: { KeyK: 41 },
  editor: {
    ContentWidgetPositionPreference: { EXACT: 0, ABOVE: 1, BELOW: 2 },
  },
}))

// 发送链两端模块级 mock：活跃会话面（useAgentTerminal）与指令队列写口
// （agentQueue store）——组合式只经这两点触达外部世界，mock 后免 pinia
const mockAgentTerminal = {
  activeId: { value: '' as string },
  sessions: { value: [] as Array<{ id: string; name: string }> },
  refresh: vi.fn(async () => true),
  open: vi.fn(async () => undefined),
}
vi.mock('./useAgentTerminal', () => ({ useAgentTerminal: () => mockAgentTerminal }))

const mockEnqueue = vi.fn(async () => true)
vi.mock('../stores/agentQueue', () => ({
  useAgentQueueStore: () => ({ enqueue: mockEnqueue }),
}))

const mockRequestDialog = vi.fn()
vi.mock('./useInlineEditGuide', () => ({
  requestSessionDialogWithPrompt: (...a: unknown[]) => mockRequestDialog(...(a as [])),
}))

import { useEditorInlineEdit } from './useEditorInlineEdit'

type EditorStub = monaco.editor.IStandaloneCodeEditor

/** 最小编辑器 stub：组合式触碰的 Monaco 面只有选区/模型/content widget/addAction。
 *  显隐协议同 0.55：widget 的 getPosition() 惰性读闭包态，条目持活引用供断言 */
function makeEditor(overrides?: {
  selection?: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number } | null
  valueInRange?: string
}) {
  type WidgetStub = {
    id: string
    dom: HTMLElement
    getPosition: () => unknown
    afterRender?: (position: unknown, coordinate: unknown) => void
  }
  const contentWidgets: WidgetStub[] = []
  const actions: Array<Record<string, unknown>> = []
  const sel = overrides?.selection === undefined
    ? { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 10 }
    : overrides.selection
  const editor = {
    getSelection: () => (sel
      ? { isEmpty: () => false, ...sel }
      : { isEmpty: () => true, startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }),
    getModel: () => ({
      getValueInRange: () => overrides?.valueInRange ?? 'const a = b.c\nreturn a',
      getLineMaxColumn: (line: number) => 42 + line,
    }),
    // 焦点交还语义可断言：blur 当前焦点元素（真实编辑器聚焦 textarea，等价让出）
    focus: () => { (document.activeElement as HTMLElement | null)?.blur() },
    addContentWidget: (w: { getId: () => string; getDomNode: () => HTMLElement; getPosition: () => unknown; afterRender?: (position: unknown, coordinate: unknown) => void }) => {
      // 挂进文档（真 Monaco 的 widget DOM 挂编辑器容器）：focus() 对游离节点
      // 是 no-op，afterRender 聚焦断言需要真实 attach
      document.body.appendChild(w.getDomNode())
      contentWidgets.push({ id: w.getId(), dom: w.getDomNode(), getPosition: () => w.getPosition(), afterRender: w.afterRender })
    },
    layoutContentWidget: (_w: { getId: () => string }) => undefined,
    onMouseDown: () => ({ dispose: () => undefined }),
    onDidChangeCursorSelection: () => ({ dispose: () => undefined }),
    addAction: (a: Record<string, unknown>) => { actions.push(a) },
  }
  return { editor: editor as unknown as EditorStub, contentWidgets, actions }
}

/** widget 当前位置（getPosition 活引用；未注册 = null） */
function widgetPos(widgets: Array<{ id: string; getPosition: () => unknown }>, id: string): unknown {
  return widgets.find(w => w.id === id)?.getPosition() ?? null
}

/** 模拟渲染帧回调：真 Monaco 在视图渲染后以解析出的 position preference 调
 *  afterRender（浮层待聚焦标记的消费点）；定位中传 BELOW，失位传 null */
function renderWidget(widgets: Array<{ id: string; getPosition: () => unknown; afterRender?: (p: unknown, c: unknown) => void }>, id: string): void {
  const w = widgets.find(x => x.id === id)
  w?.afterRender?.(w.getPosition() ? 2 : null, null)
}

function makeDeps(editorRef: { current: EditorStub | null }, canEdit = true) {
  const message = { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() }
  const deps = {
    getEditor: () => editorRef.current,
    getPath: () => 'src/a.ts',
    canEditWithAgent: () => canEdit,
    // 值拼接渲染：断言可对插值值（路径/行号）做子串匹配；签名经 cast 对齐
    // ComposerTranslation（第二参 plurals 联合形态，stub 只覆盖命名参数面）
    t: ((key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${Object.values(params).join(' ')}` : key) as unknown as Parameters<typeof useEditorInlineEdit>[0]['t'],
    message: message as unknown as MessageApi,
  }
  return { deps, message }
}

describe('useEditorInlineEdit 选区浮条', () => {
  beforeEach(() => {
    mockEnqueue.mockReset()
    mockEnqueue.mockImplementation(async () => true)
    mockRequestDialog.mockReset()
    mockAgentTerminal.activeId.value = ''
    mockAgentTerminal.sessions.value = []
    mockAgentTerminal.refresh.mockClear()
    mockAgentTerminal.open.mockClear()
  })
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  it('非空选区 → 浮条 content widget 注册并锚在选区末行（BELOW 优先）', () => {
    const ref = { current: null as EditorStub | null }
    const { editor, contentWidgets } = makeEditor()
    ref.current = editor
    const { deps } = makeDeps(ref)
    const ctl = useEditorInlineEdit(deps)
    ctl.handleSelectionChange()
    const pos = widgetPos(contentWidgets, 'sc.inlineEdit.bar') as
      { position: { lineNumber: number }; preference: number[] } | null
    expect(pos, '浮条已定位').toBeTruthy()
    expect(pos!.position.lineNumber, '锚在选区末行').toBe(2)
    expect(pos!.preference[0], 'BELOW 优先（视口放不下 Monaco 自动翻 ABOVE）').toBe(2)
  })

  it('空选区 → 浮条不定位（选区消失即隐）', () => {
    const ref = { current: null as EditorStub | null }
    const { editor } = makeEditor({ selection: null })
    ref.current = editor
    const { deps } = makeDeps(ref)
    const ctl = useEditorInlineEdit(deps)
    ctl.handleSelectionChange()
    expect(widgetPos([], 'sc.inlineEdit.bar') ?? null).toBeNull()
  })

  it('远程伪路径/未命名草稿（canEditWithAgent=false）→ 浮条不出现', () => {
    const ref = { current: null as EditorStub | null }
    const { editor, contentWidgets } = makeEditor()
    ref.current = editor
    const { deps } = makeDeps(ref, false)
    const ctl = useEditorInlineEdit(deps)
    ctl.handleSelectionChange()
    expect(widgetPos(contentWidgets, 'sc.inlineEdit.bar') ?? null).toBeNull()
  })
})

describe('useEditorInlineEdit 就地浮层与发送链', () => {
  beforeEach(() => {
    mockEnqueue.mockReset()
    mockEnqueue.mockImplementation(async () => true)
    mockRequestDialog.mockReset()
    mockAgentTerminal.activeId.value = ''
    mockAgentTerminal.sessions.value = []
    mockAgentTerminal.refresh.mockClear()
    mockAgentTerminal.open.mockClear()
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('openPrompt 捕获选区快照开浮层；actionDescriptor 提供编辑器域注册描述符（P-20261008-14 键位由注册表注入）', () => {
    const ref = { current: null as EditorStub | null }
    const { editor, contentWidgets } = makeEditor({ valueInRange: 'const a = b.c\nreturn a' })
    ref.current = editor
    const { deps } = makeDeps(ref)
    const ctl = useEditorInlineEdit(deps)
    ctl.attach(editor)
    // 键位注册收敛到编辑器域注册表（editorKeymapBindings，宿主按 keymap 生效值
    // 注入/改键重注册）——本组合式只提供无键位描述符，precondition 语义不变
    const action = ctl.actionDescriptor()
    expect(action.id).toBe('sc-ask.inline-edit')
    expect(action.precondition, '无选区不接管 Ctrl+K').toBe('editorHasSelection')
    expect(action.keybindings, '键位不在组合式内硬编码').toBeUndefined()

    ctl.openPrompt()
    expect(ctl.promptOpen.value).toBe(true)
    const prompt = contentWidgets.find(w => w.id === 'sc.inlineEdit.prompt')
    expect(prompt, '浮层 widget 已注册').toBeTruthy()
    const input = prompt!.dom.querySelector<HTMLInputElement>('.sc-inline-edit-input')!
    expect(input).toBeTruthy()
    expect(widgetPos(contentWidgets, 'sc.inlineEdit.prompt')).toBeTruthy()
    // 聚焦 = 渲染帧驱动（真浏览器 openPrompt 时刻 widget 仍 display:none，同步
    // focus() 是 no-op——e2e 实测；jsdom 无布局语义两路都通，此断言守住
    // afterRender 消费链本身）：渲染帧后输入聚焦（键盘流第一步）
    renderWidget(contentWidgets, 'sc.inlineEdit.prompt')
    expect(document.activeElement, '首轮渲染后输入聚焦（键盘流第一步）').toBe(input)

    // Esc 关闭（浮层根 keydown 链）：浮层失位 + 焦点交还编辑器（stub focus=blur）
    prompt!.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: false }))
    expect(ctl.promptOpen.value).toBe(false)
    expect(widgetPos(contentWidgets, 'sc.inlineEdit.prompt') ?? null).toBeNull()
    // 关闭后的渲染帧以 position=null 到达：不消费挂起标记、不回抢焦点
    renderWidget(contentWidgets, 'sc.inlineEdit.prompt')
    expect(document.activeElement, '关闭后焦点在编辑器侧不被浮层回抢').not.toBe(input)
  })

  it('发送 → 组装结构化指令（路径+行号+选区+指令）入活跃会话队列，toast 带会话名并跳 docked', async () => {
    const ref = { current: null as EditorStub | null }
    const { editor, contentWidgets } = makeEditor({ valueInRange: 'const a = b.c\nreturn a' })
    ref.current = editor
    const { deps, message } = makeDeps(ref)
    const ctl = useEditorInlineEdit(deps)
    ctl.openPrompt()
    const input = contentWidgets.find(w => w.id === 'sc.inlineEdit.prompt')!.dom.querySelector<HTMLInputElement>('.sc-inline-edit-input')!
    input.value = '加上空值保护'

    mockAgentTerminal.activeId.value = 'sc_t1'
    mockAgentTerminal.sessions.value = [{ id: 'sc_t1', name: '修复者' }]
    mockEnqueue.mockImplementation(async () => true)
    await ctl.send()

    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    const [sessionId, text] = mockEnqueue.mock.calls[0] as unknown as [string, string]
    expect(sessionId).toBe('sc_t1')
    expect(text).toContain('加上空值保护')
    expect(text).toContain('src/a.ts')
    expect(text).toContain('1 2')
    expect(text).toContain('const a = b.c return a')
    expect(text).not.toContain('\n')
    expect(message.success).toHaveBeenCalled()
    expect(mockAgentTerminal.open).toHaveBeenCalledWith('docked')
    expect(ctl.promptOpen.value, '发送成功即收浮层').toBe(false)
  })

  it('busy 会话（enqueue 返回 false = 排队等回执）→ 排队文案 toast，浮层照常收', async () => {
    const ref = { current: null as EditorStub | null }
    const { editor, contentWidgets } = makeEditor()
    ref.current = editor
    const { deps, message } = makeDeps(ref)
    const ctl = useEditorInlineEdit(deps)
    ctl.openPrompt()
    const input = contentWidgets.find(w => w.id === 'sc.inlineEdit.prompt')!.dom.querySelector<HTMLInputElement>('.sc-inline-edit-input')!
    input.value = '改个名字'
    mockAgentTerminal.activeId.value = 'sc_t2'
    mockAgentTerminal.sessions.value = [{ id: 'sc_t2', name: '会话B' }]
    mockEnqueue.mockImplementation(async () => false)
    await ctl.send()
    expect(mockEnqueue).toHaveBeenCalled()
    expect(message.success).toHaveBeenCalledTimes(1)
    expect(String(message.success.mock.calls[0]![0])).toContain('会话B')
    expect(ctl.promptOpen.value).toBe(false)
  })

  it('无活跃会话（refresh 对账仍空）→ 引导新建对话框预填指令（指令暂存），不入队', async () => {
    const ref = { current: null as EditorStub | null }
    const { editor, contentWidgets } = makeEditor({ valueInRange: 'let x = 1' })
    ref.current = editor
    const { deps, message } = makeDeps(ref)
    const ctl = useEditorInlineEdit(deps)
    ctl.openPrompt()
    const input = contentWidgets.find(w => w.id === 'sc.inlineEdit.prompt')!.dom.querySelector<HTMLInputElement>('.sc-inline-edit-input')!
    input.value = '重命名变量'
    await ctl.send()
    expect(mockAgentTerminal.refresh, '活动会话缺席先对账').toHaveBeenCalledTimes(1)
    expect(mockRequestDialog).toHaveBeenCalledTimes(1)
    const prefilled = mockRequestDialog.mock.calls[0]![0] as string
    expect(prefilled).toContain('重命名变量')
    expect(prefilled).toContain('src/a.ts')
    expect(mockEnqueue, '无会话不写入任何队列').not.toHaveBeenCalled()
    expect(message.info).toHaveBeenCalled()
    expect(ctl.promptOpen.value).toBe(false)
  })

  it('空指令发送 → 就地警示不入队（失败可恢复，浮层保持）', async () => {
    const ref = { current: null as EditorStub | null }
    const { editor } = makeEditor()
    ref.current = editor
    const { deps, message } = makeDeps(ref)
    const ctl = useEditorInlineEdit(deps)
    ctl.openPrompt()
    await ctl.send()
    expect(mockEnqueue).not.toHaveBeenCalled()
    expect(message.warning).toHaveBeenCalled()
    expect(ctl.promptOpen.value, '浮层保持可修正').toBe(true)
  })

  it('浮层内 Enter 触发发送；IME 组合期 Enter 不触发（isComposing 守卫）', async () => {
    const ref = { current: null as EditorStub | null }
    const { editor, contentWidgets } = makeEditor()
    ref.current = editor
    const { deps } = makeDeps(ref)
    const ctl = useEditorInlineEdit(deps)
    ctl.openPrompt()
    const promptDom = contentWidgets.find(w => w.id === 'sc.inlineEdit.prompt')!.dom
    const input = promptDom.querySelector<HTMLInputElement>('.sc-inline-edit-input')!
    input.value = '加点注释'
    mockAgentTerminal.activeId.value = 'sc_t3'
    mockAgentTerminal.sessions.value = [{ id: 'sc_t3', name: 'C' }]
    mockEnqueue.mockImplementation(async () => true)

    // IME 组合期（isComposing=true，Safari 旧 keyCode 229 同面）：不发送。
    // 事件须 bubbles（浏览器真实 keydown 冒泡到浮层根监听器，jsdom 同构）
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
    await Promise.resolve()
    expect(mockEnqueue).not.toHaveBeenCalled()

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await new Promise(r => setTimeout(r, 0))
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
    expect(ctl.promptOpen.value).toBe(false)
  })
})
