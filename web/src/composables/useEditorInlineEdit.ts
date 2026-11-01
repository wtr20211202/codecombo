import { ref } from 'vue'
import * as monaco from 'monaco-editor'
import type { MessageApi } from 'naive-ui'
import { useAgentTerminal } from './useAgentTerminal'
import { useAgentQueueStore } from '../stores/agentQueue'
import { requestSessionDialogWithPrompt } from './useInlineEditGuide'
import { buildInlineEditInstruction } from '../utils/inlineEditPrompt'
import type { useI18n } from './useI18n'
import '../views/editor/inlineEditWidget.css'

/**
 * 选区内联 AI 编辑入口（P-20261005-206）：Monaco 选区时浮「AI 修改此选区」
 * 浮条 + 就地 prompt 浮层，结构化指令（文件路径+行号区间+选区内容+指令）直达
 * **当前活跃 agent 会话**——本组合式只做「入口交互」，执行引擎全是既有面：
 * 会话（useAgentTerminal）/ 指令队列（P-20261003-248 enqueue：busy 等回执、
 * idle 即发、纯 shell 降级手动发送）/ 变更审查（agent 改文件后既有变更面板
 * diff 链，零新做）。
 *
 * - 浮条/浮层均为 Monaco content widget（Monaco 动态 DOM 挂不上 scoped 样式，
 *   类走 inlineEditWidget.css 全局块，monacoDecorations.css 同款惯例）——
 *   content widget 随选区锚点自动跟随滚动/编辑，免手工重算像素位
 * - 浮条锚在选区末行、preference [BELOW, ABOVE]（Monaco 视口放不下自动翻转，
 *   vendored contentWidgets.js 两 pass 落点逻辑）；选区消失即隐
 * - 浮层锚在打开时刻的选区快照末行：后续选区变化（含点击塌缩）不回收浮层，
 *   指令以快照为准——浮层在场时选区归其所有
 * - 浮层内按键一律 stopPropagation 截断在浮层根：不给 document 级布局链
 *   （Ctrl+K 命令面板 / Esc 逐层退出 / Quick Open），Enter 发送、Esc 关闭；
 *   IME 组合期 Enter 不触发（isComposing/229 守卫，P-196 @ 补全同款）
 * - Ctrl+K 触发：Monaco addAction 键位接入 keymap 编辑器域注册表（P-20261008-14，
 *   键位由宿主按注册表生效值注入、改键重注册，见 views/editor/editorKeymapBindings.ts）
 *   + precondition editorHasSelection——编辑器聚焦且有选区时接管 Ctrl+K，
 *   无选区时放行内建 chord 前缀（既有行为零变化）；改绑后 precondition 语义不变
 *   （无选区不触发，放行面随新键位走）
 * - 发送目标：useAgentTerminal().activeId（管理页当前选中会话）；缺席先
 *   refresh() 对账（服务重启恢复同链），仍无会话 → requestSessionDialogWithPrompt
 *   引导打开新建对话框预填指令（不静默新建会话，见 useInlineEditGuide 头注）
 * - 发送后 toast + open('docked') 跳会话面板（过程可见性由会话面板承载）；
 *   入队失败浮层保持可修正重试（服务端校验/网络错误由 http 拦截器统一 toast，
 *   AgentSessionQueuePanel 同款双 toast 规避）
 * - 边界：远程伪路径（remote:）/未命名草稿（untitled://）不适用——agent 会话
 *   cwd 是本地项目，无本地文件可指（sc-ask.selection run 守卫同口径）
 */

const BAR_WIDGET_ID = 'sc.inlineEdit.bar'
const PROMPT_WIDGET_ID = 'sc.inlineEdit.prompt'

/** 打开浮层时刻的选区快照：指令的定位与内容以此为准 */
interface InlineEditSnapshot {
  path: string
  startLine: number
  endLine: number
  code: string
  /** 浮层锚点：选区末行行尾（拖选塌缩/编辑后快照仍可锚） */
  anchorLine: number
  anchorColumn: number
}

export interface EditorInlineEditDeps {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  getPath: () => string
  /** 远程伪路径/未命名草稿 = false（agent 会话只认本地项目文件） */
  canEditWithAgent: () => boolean
  t: ReturnType<typeof useI18n>['t']
  message: MessageApi
}

export function useEditorInlineEdit(deps: EditorInlineEditDeps) {
  const promptOpen = ref(false)
  const sending = ref(false)

  let barWidget: monaco.editor.IContentWidget | null = null
  let promptWidget: monaco.editor.IContentWidget | null = null
  /** 浮层打开后的待聚焦标记：真实渲染帧（afterRender）消费，见 afterRender 注 */
  let promptFocusPending = false
  let barPosition: monaco.editor.IContentWidgetPosition | null = null
  let promptPosition: monaco.editor.IContentWidgetPosition | null = null
  let snapshot: InlineEditSnapshot | null = null

  function editor(): monaco.editor.IStandaloneCodeEditor | null {
    return deps.getEditor()
  }

  // ── 选区快照与行号规整 ──────────────────────────────────────────────
  /** 选区末行规整（P-122 同款）：拖到下一行行首（尾列=1）该行并无选中内容 */
  function normalizedEndLine(sel: monaco.Selection): number {
    return sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber
      ? sel.endLineNumber - 1
      : sel.endLineNumber
  }

  function readSelectionSnapshot(): InlineEditSnapshot | null {
    const ed = editor()
    const sel = ed?.getSelection()
    const model = ed?.getModel()
    const path = deps.getPath()
    if (!ed || !sel || sel.isEmpty() || !model || !path || !deps.canEditWithAgent()) return null
    const endLine = normalizedEndLine(sel)
    return {
      path,
      startLine: sel.startLineNumber,
      endLine,
      code: model.getValueInRange(sel),
      anchorLine: endLine,
      anchorColumn: model.getLineMaxColumn(endLine),
    }
  }

  // ── 浮条（选区在场即浮，选区消失即隐） ─────────────────────────────
  function ensureBarWidget(ed: monaco.editor.IStandaloneCodeEditor): monaco.editor.IContentWidget {
    if (barWidget) return barWidget
    const dom = document.createElement('div')
    dom.className = 'sc-inline-edit-bar'
    dom.setAttribute('data-testid', 'inline-edit-bar')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'sc-inline-edit-bar-btn'
    btn.setAttribute('data-testid', 'inline-edit-open')
    btn.textContent = deps.t('editor.inlineEdit.bar')
    btn.title = deps.t('editor.inlineEdit.barTitle')
    // suppressMouseDown 已挡编辑器把点击落成光标；preventDefault/stopPropagation
    // 再挡原生行为与 blame 书签等同挂编辑器 onMouseDown 处理器误消费
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      openPrompt()
    })
    dom.appendChild(btn)
    barWidget = {
      getId: () => BAR_WIDGET_ID,
      getDomNode: () => dom,
      getPosition: () => barPosition,
      suppressMouseDown: true,
      allowEditorOverflow: false,
    }
    ed.addContentWidget(barWidget)
    return barWidget
  }

  function showBarFor(sel: monaco.Selection): void {
    const ed = editor()
    const model = ed?.getModel()
    if (!ed || !model) return
    const widget = ensureBarWidget(ed)
    const endLine = normalizedEndLine(sel)
    // 0.55 content widget 定位走 position 锚 + preference（Monaco 视口放不下
    // 自动按两 pass 翻 ABOVE，vendored contentWidgets.js fitsBelow/fitsAbove）；
    // 显隐统一经闭包位置态 + layoutContentWidget 重算（getPosition 惰性求值）
    const next: monaco.editor.IContentWidgetPosition = {
      position: { lineNumber: endLine, column: model.getLineMaxColumn(endLine) },
      preference: [monaco.editor.ContentWidgetPositionPreference.BELOW, monaco.editor.ContentWidgetPositionPreference.ABOVE],
    }
    // 同位幂等短路：拖选调整期同一锚点重复事件不重排（打字/拖选热路径量级考量）
    const cur = barPosition?.position
    if (cur && cur.lineNumber === next.position!.lineNumber && cur.column === next.position!.column) return
    barPosition = next
    ed.layoutContentWidget(widget)
  }

  function hideBar(): void {
    // 幂等短路：选区事件随每次光标移动高频触发（打字热路径），已隐不再
    // 触发 layoutContentWidget 重算
    if (!barWidget || !barPosition) return
    barPosition = null
    editor()?.layoutContentWidget(barWidget)
  }

  /** 选区变化入口（宿主 onDidChangeCursorSelection 接线）：浮层在场时选区
   *  归浮层快照所有，不跟随回落浮条；其余按有/无选区浮/隐浮条 */
  function handleSelectionChange(): void {
    if (promptOpen.value) return
    const ed = editor()
    const sel = ed?.getSelection()
    if (!sel || sel.isEmpty() || !deps.getPath() || !deps.canEditWithAgent()) {
      hideBar()
      return
    }
    showBarFor(sel)
  }

  // ── 就地 prompt 浮层（content widget，输入指令单行起步） ──────────
  function ensurePromptWidget(ed: monaco.editor.IStandaloneCodeEditor): monaco.editor.IContentWidget {
    if (promptWidget) return promptWidget
    const dom = document.createElement('div')
    dom.className = 'sc-inline-edit-prompt'
    dom.setAttribute('data-testid', 'inline-edit-prompt')
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'sc-inline-edit-input'
    input.setAttribute('data-testid', 'inline-edit-input')
    input.placeholder = deps.t('editor.inlineEdit.placeholder')
    input.spellcheck = false
    input.autocomplete = 'off'
    const sendBtn = document.createElement('button')
    sendBtn.type = 'button'
    sendBtn.className = 'sc-inline-edit-send'
    sendBtn.setAttribute('data-testid', 'inline-edit-send')
    sendBtn.textContent = deps.t('editor.inlineEdit.send')
    sendBtn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
    sendBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); void send() })
    const hint = document.createElement('span')
    hint.className = 'sc-inline-edit-hint'
    hint.textContent = deps.t('editor.inlineEdit.hint')
    dom.append(input, sendBtn, hint)
    // 浮层根截断 mousedown 传播：点击浮层内任意处（含输入框挪光标）不给编辑器
    // 鼠标链——onMouseDown 外点收层只应响应浮层外的编辑器点击；不 preventDefault
    // （输入框内挪光标是合法默认行为）。按钮级另有 preventDefault+stop（防原生
    // 行为 + blame/书签等同挂处理器误消费）
    dom.addEventListener('mousedown', (e) => { e.stopPropagation() })
    // 浮层根统一截断按键传播：输入/Enter/Esc 都不给 document 级布局链
    // （Ctrl+K 命令面板 / Esc 逐层退出等）；Enter 发送（IME 组合期不触发，
    // isComposing/229 双守卫——P-196 同款），Esc 关闭
    dom.addEventListener('keydown', (e) => {
      e.stopPropagation()
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault()
        void send()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closePrompt()
      }
    })
    promptWidget = {
      getId: () => PROMPT_WIDGET_ID,
      getDomNode: () => dom,
      getPosition: () => promptPosition,
      suppressMouseDown: true,
      allowEditorOverflow: false,
      // 打开后的首轮真实渲染才补聚焦：openPrompt 时刻锚点 viewPosition 尚未在
      // 视图渲染中计算，widget 仍 display:none（vendored contentWidgets.js
      // setPosition 的 viewPosition 空判分支），同步 focus() 是 no-op（e2e 实测
      // 输入 inactive、键盘流断裂）。position=null（已关）不消费挂起标记
      afterRender: (position) => {
        if (promptFocusPending && position !== null) {
          promptFocusPending = false
          input.focus()
        }
      },
    }
    ed.addContentWidget(promptWidget)
    return promptWidget
  }

  /** 打开浮层：以当前选区为快照锚在末行行尾，聚焦输入。无可用选区/远程伪
   *  路径/未命名草稿静默不动作（入口侧已守卫，此处防御） */
  function openPrompt(): void {
    if (promptOpen.value || sending.value) return
    const snap = readSelectionSnapshot()
    const ed = editor()
    if (!snap || !ed) return
    snapshot = snap
    hideBar()
    const widget = ensurePromptWidget(ed)
    const input = widget.getDomNode().querySelector<HTMLInputElement>('.sc-inline-edit-input')
    if (input) input.value = ''
    promptPosition = {
      position: { lineNumber: snap.anchorLine, column: snap.anchorColumn },
      preference: [monaco.editor.ContentWidgetPositionPreference.BELOW, monaco.editor.ContentWidgetPositionPreference.ABOVE],
    }
    ed.layoutContentWidget(widget)
    promptOpen.value = true
    // 即时尽力聚焦（display:none 时为 no-op），真实落位由 afterRender 补齐
    promptFocusPending = true
    input?.focus()
  }

  function closePrompt(): void {
    if (!promptWidget || !promptOpen.value) return
    promptOpen.value = false
    // 挂起聚焦随关闭作废（afterRender 以 position=null 到达也不消费，双保险）
    promptFocusPending = false
    snapshot = null
    promptPosition = null
    editor()?.layoutContentWidget(promptWidget)
    // 关闭后焦点交还编辑器，续接打断前的编辑流
    editor()?.focus()
  }

  // ── 发送链：结构化指令 → 活跃会话队列（idle 即发 / busy 等回执） ──
  async function send(): Promise<void> {
    if (sending.value || !snapshot) return
    const input = promptWidget?.getDomNode().querySelector<HTMLInputElement>('.sc-inline-edit-input')
    const instruction = (input?.value ?? '').trim()
    if (!instruction) {
      deps.message.warning(deps.t('editor.inlineEdit.empty'))
      input?.focus()
      return
    }
    const snap = snapshot
    const rel = snap.path.replace(/\\/g, '/')
    const text = buildInlineEditInstruction(
      {
        instruction,
        location: snap.startLine === snap.endLine
          ? deps.t('editor.inlineEdit.locSingle', { path: rel, line: snap.startLine })
          : deps.t('editor.inlineEdit.loc', { path: rel, start: snap.startLine, end: snap.endLine }),
        codePrefix: deps.t('editor.inlineEdit.codePrefix'),
      },
      snap.code,
    )
    sending.value = true
    try {
      const agentTerminal = useAgentTerminal()
      let activeId = agentTerminal.activeId.value
      if (!activeId) {
        // 活动会话缺席先对账（服务重启恢复/跨页创建同链），仍无 = 无会话
        await agentTerminal.refresh()
        activeId = agentTerminal.activeId.value
      }
      if (!activeId) {
        // 无活跃会话：引导打开新建会话对话框、指令暂存预填（不静默新建）
        requestSessionDialogWithPrompt(text)
        deps.message.info(deps.t('editor.inlineEdit.noSession'))
        closePrompt()
        return
      }
      const name = agentTerminal.sessions.value.find(s => s.id === activeId)?.name || ''
      const sentNow = await useAgentQueueStore().enqueue(activeId, text)
      deps.message.success(sentNow
        ? deps.t('editor.inlineEdit.sentNow', { name })
        : deps.t('editor.inlineEdit.queued', { name }))
      closePrompt()
      // 过程可见性由会话面板承载：跳 docked 管理页（ask 发起族同款收尾）
      await agentTerminal.open('docked')
    } catch {
      // 服务端校验/网络失败：拦截器已 toast（queueFull/queueInvalid 已入
      // KNOWN_ERROR 映射），浮层保持可修正重试——此处不叠加第二个 toast
    } finally {
      sending.value = false
    }
  }

  /** 编辑器域键位注册表动作描述符（P-20261008-14）：无键位——键位由宿主经
   *  editorKeymapBindings 按 keymap 注册表生效值注入（改键重注册同步面）。
   *  无选区不接管（precondition 放行内建 Ctrl+K chord 前缀，既有行为零变化） */
  function actionDescriptor(): monaco.editor.IActionDescriptor {
    return {
      id: 'sc-ask.inline-edit',
      label: deps.t('editor.inlineEdit.actionLabel'),
      // 无选区不接管（放行内建 Ctrl+K chord 前缀，既有行为零变化）
      precondition: 'editorHasSelection',
      run: () => { if (deps.canEditWithAgent()) openPrompt() },
    }
  }

  /** 宿主 onMounted 编辑器创建后调用一次：选区监听 + 点击外部收层（Ctrl+K
   *  键位注册随编辑器域注册表走 editorKeymapBindings，见 actionDescriptor）。
   *  无可用文件形态的守卫在各处理器内 */
  function attach(ed: monaco.editor.IStandaloneCodeEditor): void {
    ed.onDidChangeCursorSelection(() => handleSelectionChange())
    // 点击编辑器文本（浮层外）= 放弃本次指令：浮层根 mousedown stopPropagation
    // 已把浮层内点击挡在本链之外（suppressMouseDown 另挡 Monaco 自身的落光标）
    ed.onMouseDown(() => { if (promptOpen.value) closePrompt() })
  }

  /** 宿主换签/卸载收口：快照与浮层随文件域失效（路径已不是快照路径） */
  function resetForPathChange(): void {
    hideBar()
    if (promptOpen.value) closePrompt()
    snapshot = null
  }

  return { promptOpen, sending, handleSelectionChange, openPrompt, closePrompt, hideBar, resetForPathChange, attach, actionDescriptor, send }
}
