import * as monaco from 'monaco-editor'
import { useFontStore, composeMonoFontFamily, bracketColorizationEnabled } from '../../stores/font'
import { applyBracketColorization } from './useEditorOptionSyncs'
import { getLanguageByPath } from '../../utils/git'
import { getCachedMonacoModel, retainMonacoModel } from './monacoModelCache'

/**
 * Monaco 编辑器实例构建（P-20261003-301 自 MonacoEditor.vue 的 onMounted 原样
 * 搬运）：按 LRU 缓存 → monaco 全局注册表 → 新建的优先级解析 model，再以主题/
 * 字体/书签 glyph 车道等既有选项集创建编辑器实例。纯搬运不改逻辑；选项语义
 * 注释随语句逐一保留。
 */

export function createMonacoEditorInstance(
  container: HTMLDivElement,
  p: { path: string; language?: string; modelValue: string; readOnly?: boolean },
  fontStore: ReturnType<typeof useFontStore>,
  themeName: string,
): monaco.editor.IStandaloneCodeEditor {
  // 使用显式model和URI确保语言服务正确激活
  const path = p.path || 'untitled.txt'
  const lang = p.language || getLanguageByPath(path)
  const uri = monaco.Uri.parse(`file:///${path}`)
  // 复用优先级：LRU 缓存 → monaco 全局注册表 → 新建（避免 URI 冲突）
  const uriKey = uri.toString()
  let model = getCachedMonacoModel(uriKey)
  if (model) {
    if (model.getValue() !== p.modelValue) model.setValue(p.modelValue)
    monaco.editor.setModelLanguage(model, lang)
    // 命中即 retain：刷新 LRU 时间戳——否则最旧条目挂上 editor 后仍是最旧，
    // 下次插入可把它淘汰 dispose 掉，导致存活 editor 持有 disposed model
    retainMonacoModel(uriKey, model, model)
  } else if ((model = monaco.editor.getModel(uri) ?? undefined)) {
    if (model.getValue() !== p.modelValue) model.setValue(p.modelValue)
    monaco.editor.setModelLanguage(model, lang)
    retainMonacoModel(uriKey, model, model)
  } else {
    model = monaco.editor.createModel(p.modelValue, lang, uri)
    retainMonacoModel(uriKey, model, model)
  }

  const editor = monaco.editor.create(container, {
    model,
    theme: themeName,
    automaticLayout: true,
    fontSize: fontStore.editorFontSize,
    // 行高 = 生效字号 × 倍率（P-20261006-7，对标 VS Code editor.lineHeight）：
    // 与运行期 watch 同走 fontStore.editorLineHeight 出口，缺省 1.5 ≈ 硬编码
    // 22px / 缺省字号 14px 的既有观感
    lineHeight: fontStore.editorLineHeight,
    // CSS var 可用于 Monaco：fontFamily 经内联 style 落 DOM，var() 由文档级联解析
    // （编辑器与测宽节点都在 app 树内，--font-mono 恒可用，P-20261004-43 token 收口）。
    // 经 composeMonoFontFamily 合成自定义等宽字体名前插段（P-20261005-227）——
    // 与运行期 watch 同源取值，保证 fontFamily 缓存键在改名/清名时必变化触发重测宽
    fontFamily: composeMonoFontFamily(fontStore.monoFontName),
    tabSize: fontStore.editor.tabSize,
    insertSpaces: fontStore.editor.insertSpaces,
    minimap: { enabled: fontStore.editor.minimap, maxColumn: 80 },
    stickyScroll: { enabled: fontStore.editor.stickyScroll },
    scrollBeyondLastLine: false,
    // 书签 gutter 图标车道（P-20261002-131）：glyphMargin 默认关闭——书签在
    // 行号左侧车道画图标并接受点击 toggle
    glyphMargin: true,
    renderWhitespace: fontStore.editor.renderWhitespace,
    wordWrap: fontStore.editor.wordWrap,
    readOnly: p.readOnly,
    padding: { top: 8 },
    smoothScrolling: true,
    cursorSmoothCaretAnimation: 'on',
    // 括号彩色化（P-20261006-9）：创建期仅作全局侧门播种（后续 createModel 继承
    // 初值）；本 model 的生效值在 create 后经 applyBracketColorization 对 model
    // 直写——editor 级选项对已存在 model 不落地（见该函数注记）
    bracketPairColorization: { enabled: bracketColorizationEnabled(fontStore.editor.bracketColor, lang) },
    // 中文全角标点（（，。等）被 Monaco 判定为「歧义字符」画黄框，中文文档全部误伤——
    // 关闭歧义高亮，仅保留不可见字符告警（防同形注入的安全价值保留）
    unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: true },
  })
  applyBracketColorization(editor, fontStore.editor.bracketColor, lang)
  return editor
}
