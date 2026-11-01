import { ref } from 'vue'
import * as monaco from 'monaco-editor'
import type { MessageApi } from 'naive-ui'
import { useSnippetShare } from './useSnippetShare'
import { useEditorAskAgent } from './useEditorAskAgent'
import { SNIPPET_MAX_BYTES } from '../api/domains/share'
import { expandSnippetVars, referencesClipboard } from '../utils/snippetVars'
import { readClipboardText } from '../utils/clipboard'
import type { useI18n } from './useI18n'

/**
 * Monaco 右键菜单的片段/分享/询问族（P-20261003-301 自 MonacoEditor.vue 原样
 * 搬运）：保存选区为片段 + 插入片段（P-20261002-44，executeEdits 走 Monaco 原生
 * 编辑事务不劫持撤销栈）+ 选区文本分享短链（P-20261002-71）+ 选区询问智能体
 * （P-20261002-122）+ 剪贴板对比/多剪贴板粘贴（P-20261002-149）。纯搬运不改
 * 逻辑；editor 实例经 getEditor 迟后取用，路径经 getter 读取实时值。
 */

// 编辑器代码片段选区上限：对齐服务端 snippetCommandMax（8192 rune），留余量防 UTF-16 计数差
const SNIPPET_CONTENT_MAX = 8000

export interface EditorSnippetsDeps {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  getPath: () => string
  t: ReturnType<typeof useI18n>['t']
  message: MessageApi
  /** 剪贴板对比：读取成功后上抛宿主开 diff 标签（原 emit 直连） */
  onCompareClipboard: (payload: { path: string; text: string }) => void
}

export function useEditorSnippets(deps: EditorSnippetsDeps) {
  const { getEditor, getPath, t, message, onCompareClipboard } = deps
  const shareSnippet = useSnippetShare()
  const { askAgentAboutSelection } = useEditorAskAgent()

  const snippetSaveShow = ref(false)
  const snippetSaveText = ref('')
  const snippetSaveLanguage = ref('')
  const snippetInsertShow = ref(false)
  const snippetInsertLanguage = ref('')

  function currentLanguageId(): string {
    return getEditor()?.getModel()?.getLanguageId() || ''
  }

  /** 右键「保存为片段」：捕获选区文本 + 当前语言后开表单弹窗 */
  function openSaveSnippetModal() {
    const editor = getEditor()
    if (!editor) return
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (!selection || selection.isEmpty() || !model) {
      message.warning(t('snippet.code.noSelection'))
      return
    }
    const text = model.getValueInRange(selection)
    if (text.length > SNIPPET_CONTENT_MAX) {
      message.warning(t('snippet.code.tooLong'))
      return
    }
    snippetSaveText.value = text
    snippetSaveLanguage.value = currentLanguageId()
    snippetSaveShow.value = true
  }

  /** 右键/命令面板「插入片段」：按当前文件语言开选择器。
   *  返回 false = 无可用编辑器（未打开文件），供命令面板路径就地提示 */
  function openSnippetInsertPicker(): boolean {
    const editor = getEditor()
    if (!editor || !editor.getModel()) return false
    snippetInsertLanguage.value = currentLanguageId()
    snippetInsertShow.value = true
    return true
  }

  /** 多剪贴板粘贴（P-20261002-149）：历史弹层选中后插入光标处。复用片段插入的
   *  executeEdits 事务语义（参与撤销栈，撤销一步即回到插入前）。返回 false =
   *  无可用编辑器（欢迎页/diff 标签），宿主降级为仅复制提示 */
  function insertClipboardText(text: string): boolean {
    const editor = getEditor()
    if (!editor || !editor.getModel()) return false
    insertSnippetText(text)
    return true
  }

  /** 选择器点选后插入（P-20261006-1）：先做插入时变量替换（${CLIPBOARD}/${DATE}/
   *  ${TIME}；$0 从文本剔除并记光标终位），剪贴板读取失败降级保留原样，再走既有
   *  executeEdits 事务。只有片段点选路径做替换——多剪贴板粘贴（insertClipboardText）
   *  是字面历史文本，不经此处 */
  async function insertPickedSnippet(text: string) {
    // 剪贴板按需读（referencesClipboard 门卫）：无变量插入不触碰权限/焦点面
    const clip = referencesClipboard(text) ? await readClipboardText() : undefined
    const v = expandSnippetVars(text, { clipboardText: clip ?? undefined })
    insertSnippetText(v.text, v.cursorOffset)
  }

  /** 选择器点选后插入：executeEdits 走 Monaco 原生编辑事务（参与撤销栈，
   *  不劫持——撤销一步即回到插入前），无选区时插在光标处；cursorOffset 非空时
   *  把光标落到插入起点 + 片段内偏移（$0 终位）并滚动到可见 */
  function insertSnippetText(text: string, cursorOffset: number | null = null) {
    const editor = getEditor()
    if (!editor) return
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (!selection || !model) return
    const startOffset = model.getOffsetAt(selection.getStartPosition())
    editor.executeEdits('sc-snippet', [{ range: selection, text, forceMoveMarkers: true }])
    if (cursorOffset !== null) {
      const pos = model.getPositionAt(startOffset + cursorOffset)
      editor.setPosition(pos)
      editor.revealPosition(pos)
    }
    editor.focus()
  }

  /** 当前选区文本（空选区/无编辑器返回空串；命令面板经 EditorArea 链取用） */
  function getSelectedText(): string {
    const editor = getEditor()
    const selection = editor?.getSelection()
    const model = editor?.getModel()
    if (!selection || selection.isEmpty() || !model) return ''
    return model.getValueInRange(selection)
  }

  /** 右键「分享选中文本」：选区开片段分享弹窗（确认「将公开此文本」后创建）。
   *  上限按服务端字节口径预检（SNIPPET_MAX_BYTES），超限就地提示 */
  function shareSelectionSnippet() {
    const text = getSelectedText()
    if (!text) {
      message.warning(t('share.snippet.noSelection'))
      return
    }
    if (new TextEncoder().encode(text).length > SNIPPET_MAX_BYTES) {
      message.warning(t('share.snippet.tooLarge'))
      return
    }
    shareSnippet.openShareSnippet(text)
  }

  /** 右键「询问智能体选中代码」：以选中代码为上下文新建 agent 会话（复用
   *  P-28 发起链路，选区注入 prompt）。菜单项 precondition（editorHasSelection）
   *  已保证非空选区，此处空选区/无模型防御性不动作 */
  function askSelectionAgent() {
    const editor = getEditor()
    const path = getPath()
    if (!path || !editor) return
    const selection = editor.getSelection()
    const model = editor.getModel()
    if (!selection || selection.isEmpty() || !model) return
    // 选区拖到下一行行首（尾列=1）时该行并无选中文本，行号头部回退一行
    const endLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
      ? selection.endLineNumber - 1
      : selection.endLineNumber
    void askAgentAboutSelection(
      path,
      model.getValueInRange(selection),
      selection.startLineNumber,
      endLine,
    )
  }

  /** 剪贴板对比：读取失败/为空就地提示，有内容则上抛宿主开 diff 标签 */
  async function compareWithClipboard() {
    const path = getPath()
    if (!path) return
    const text = (await readClipboardText()) ?? ''
    if (!text.trim()) {
      message.warning(t('editor.clipboardEmpty'))
      return
    }
    onCompareClipboard({ path, text })
  }

  /** 当前光标行号（询问智能体的 prompt 聚焦行）：由 EditorGitActions 在点击时
   *  求值，编辑器未就绪返回 undefined（询问退化为整文件） */
  function getCursorLine(): number | undefined {
    return getEditor()?.getPosition()?.lineNumber ?? undefined
  }

  return {
    snippetSaveShow,
    snippetSaveText,
    snippetSaveLanguage,
    snippetInsertShow,
    snippetInsertLanguage,
    currentLanguageId,
    openSaveSnippetModal,
    openSnippetInsertPicker,
    insertClipboardText,
    insertPickedSnippet,
    insertSnippetText,
    getSelectedText,
    shareSelectionSnippet,
    askSelectionAgent,
    compareWithClipboard,
    getCursorLine,
  }
}
