import { watch } from 'vue'
import * as monaco from 'monaco-editor'
import { useFontStore, bracketColorizationEnabled } from '../../stores/font'
import { useThemeStore } from '../../stores/theme'
import { applyMonacoTheme } from '../../utils/monaco-theme'
import { getLanguageByPath } from '../../utils/git'
import { resolveIndentOptions, type EditorConfigEffective } from '../../utils/editorConfig'

/**
 * Monaco 编辑器外观/运行态选项 watches（P-20261003-301 自 MonacoEditor.vue 原样
 * 搬运）：生效字号（含演示模式缩放）、只读态动态切换、tabSize 等编辑行为选项、
 * 主题应用、按文件缩进约定（P-20261003-95 移植主线增量，applyIndentOptions 随
 * editorconfig 输入同域落此）。path/model 两个核心 watcher 留在宿主（与模型切换
 * 强耦合），此处只收拢纯选项同步面。纯搬运不改逻辑；editor 实例经 getEditor 迟后
 * 取用。
 */

export interface EditorOptionSyncDeps {
  getEditor: () => monaco.editor.IStandaloneCodeEditor | null
  fontStore: ReturnType<typeof useFontStore>
  themeStore: ReturnType<typeof useThemeStore>
  getLanguage: () => string | undefined
  getPath: () => string | undefined
  getReadOnly: () => boolean | undefined
  /** .editorconfig 生效缩进约定（P-20261003-95，打开链 file-policy 随行下发） */
  getEditorconfig: () => EditorConfigEffective | null | undefined
}

/**
 * 括号彩色化双轨应用（P-20261006-9，三处引用点共用）：editor 级选项（保留
 * standalone 全局侧门语义——后续 createModel 经 modelService 继承该初值）之外，
 * 必须对 **model 直写** bracketColorizationOptions 才落地——monaco 0.55 实测
 * editor.updateOptions({bracketPairColorization}) 的配置侧门对已存在 model 不
 * 生效（e2e editor-bracket-color.spec 守护），而括号着色装饰的权威真值是
 * model options（colorizedBracketPairsDecorationProvider 按 model options 出
 * inlineClass）。independentColorPoolPerBracketType 保留 model 现值只覆写 enabled。
 */
export function applyBracketColorization(
  editor: monaco.editor.IStandaloneCodeEditor,
  bracketColor: boolean,
  lang: string | undefined,
): void {
  const enabled = bracketColorizationEnabled(bracketColor, lang)
  editor.updateOptions({ bracketPairColorization: { enabled } })
  const model = editor.getModel()
  if (!model) return
  const current = model.getOptions().bracketPairColorizationOptions
  model.updateOptions({ bracketColorizationOptions: { ...current, enabled } })
  if (enabled) {
    // 重启用缝补：着色期间 provider 对 bracketPairs 早退（getDecorationsInRange
    // disabled 分支直返 []），bracketPairs 树的 bracketsRequested 停滞 false——重开
    // 开关后树惰性重建不发 onDidChangeDecorations，view 不会重新收集着色装饰
    //（首渲染即关→重开的场景，e2e「再打开恢复着色」守护）。显式查询一次置位并
    // 触发树重建事件链；返回值弃置仅驱动失效，开关操作低频、O(全文) AST 可接受
    const bracketPart = (model as unknown as {
      bracketPairs: { getBracketPairsInRange(range: monaco.Range): unknown }
    }).bracketPairs
    bracketPart?.getBracketPairsInRange(model.getFullModelRange())
  }
}

export function attachEditorOptionSyncs(deps: EditorOptionSyncDeps) {
  const { getEditor, fontStore, themeStore, getLanguage, getPath, getReadOnly, getEditorconfig } = deps

  // 按文件套缩进选项（P-20261003-95）：editorconfig（getEditorconfig）>
  // 全局设置（font store）逐键合成后落 **model options**。Monaco 0.55 机制事实：
  // 缩进行为的权威真值是 model options（光标/视图层均读 model.getOptions()），
  // editor.create 的 tabSize/insertSpaces 是经 standalone 全局配置侧门生效的
  // 全局值——per-file 约定必须 updateOptions 到 model 上才能按文件生效。
  // 应用点位：创建后 / 切签换 model 后（宿主调用返回值）/ 约定迟到到达 /
  // 全局设置变更后（下者）
  function applyIndentOptions(): void {
    const editor = getEditor()
    if (!editor) return
    const model = editor.getModel()
    if (!model) return
    const eff = resolveIndentOptions(
      { tabSize: fontStore.editor.tabSize, insertSpaces: fontStore.editor.insertSpaces },
      getEditorconfig(),
    )
    model.updateOptions({ tabSize: eff.tabSize, insertSpaces: eff.insertSpaces })
  }

  // 生效字号（持久 sizes × 演示模式缩放，P-20261002-45）：投屏演示临时放大
  // 不落盘，监听生效值让创建/字号设置/进出演示三条路径统一随动
  // 行高倍率（P-20261006-7）并入同一联动链：生效行高 = 生效字号 × 倍率，字号
  // 变更联动重算与倍率切换即时生效都经 editorLineHeight 出口一次 updateOptions
  watch([() => fontStore.editorFontSize, () => fontStore.editor.lineHeightMultiplier], ([size]) => {
    const editor = getEditor()
    if (editor) editor.updateOptions({ fontSize: size, lineHeight: fontStore.editorLineHeight })
  })

  // 自定义等宽字体名（P-20261005-227）：--font-mono-lead 覆写后 DOM 级联即时换
  // 字形，但 Monaco 测宽缓存键是 fontFamily 值串本身——重设合成值（键必变化，
  // 与 monacoEditorFactory 创建期同一 compose 源 monoFontFamily）触发 font
  // metrics 重测，光标/折叠对位不漂
  watch(() => fontStore.monoFontName, () => {
    const editor = getEditor()
    if (editor) editor.updateOptions({ fontFamily: fontStore.monoFontFamily })
  })

  // 只读态动态切换（P-20261003-15）：远程文件离线降级只读 / 重试成功恢复可编辑。
  // readOnly 只在 editor.create 时吃初值，运行期变化必须显式 updateOptions
  watch(getReadOnly, (v) => {
    const editor = getEditor()
    if (editor) editor.updateOptions({ readOnly: !!v })
  })

  watch(() => fontStore.editor, (cfg) => {
    const editor = getEditor()
    if (!editor) return
    editor.updateOptions({
      tabSize: cfg.tabSize,
      insertSpaces: cfg.insertSpaces,
      minimap: { enabled: cfg.minimap, maxColumn: 80 },
      stickyScroll: { enabled: cfg.stickyScroll },
      renderWhitespace: cfg.renderWhitespace,
      wordWrap: cfg.wordWrap,
    })
    // 括号彩色化开关即时生效（P-20261006-9）：与 markdown 语言差异正交组合，
    // 语言取值口径与下方面语言 watch 同源
    applyBracketColorization(editor, cfg.bracketColor, getLanguage() || getLanguageByPath(getPath()))
    // 全局缩进值变更经 standalone 配置侧门触发 modelService 以 detectIndentation
    // 重推所有 model——.editorconfig 钉的约定会被冲掉，此处对当前 model 重钉
    //（约定 > 全局的优先级在设置变更后保持，P-20261003-95）
    applyIndentOptions()
  }, { deep: true })

  // 约定迟到到达（内容读取完成前 MonacoEditor 可能已挂载）：策略响应写入
  // OpenFile.editorconfig 后在此补钉
  watch(getEditorconfig, () => {
    applyIndentOptions()
  })

  // 主题或 diff 色板档（P-20261006-5）任一变更重广播 Monaco 主题（主编辑器自身
  // 无 diff 面，重定义保证主题全局数据一致——DiffEditor 实例共享同一注册表）
  watch([() => themeStore.currentTheme, () => fontStore.diffPalette], () => {
    applyMonacoTheme(themeStore, fontStore.diffPalette)
  })

  // 语言变化同步 model 语言与括号着色（markdown 恒关；其余语言随设置开关，
  // P-20261006-9）——path watcher 内同款语义，此处承接不改 path 的语言切换
  watch(getLanguage, () => {
    const editor = getEditor()
    if (!editor) return
    const lang = getLanguage() || getLanguageByPath(getPath())
    const model = editor.getModel()
    if (model) monaco.editor.setModelLanguage(model, lang)
    applyBracketColorization(editor, fontStore.editor.bracketColor, lang)
  })

  return { applyIndentOptions }
}
