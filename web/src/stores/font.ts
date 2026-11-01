import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { safeStorage } from '../utils/storage'

export type FontSection = 'base' | 'editor' | 'terminal' | 'diff' | 'sidebar' | 'bottom'

/** localStorage key：字体/编辑器外观设置（写入侧 save；跨标签分发见 utils/settingsSync） */
export const FONT_SETTINGS_KEY = 'font-settings'

/** 界面字体族：brand = 打包的 Geist/Inter（默认）；system = 纯系统栈（与 dsh 等原生应用一致） */
export type UIFontFamily = 'brand' | 'system'

/** 终端编程连字（=> !== 等合字）：默认开启；关闭后字体面禁用 calt/liga */
export type TerminalLigatures = 'on' | 'off'

/** 自定义等宽字体名（P-20261005-227）：空 = 内置 --font-mono 栈缺省；非空经
 *  base.css 的 --font-mono-lead 注入点前插回退链。设备本地视觉偏好（字体是本地
 *  渲染条件，本地装了才能生效——uiFont 双档/P-69 同口径），落 localStorage */
export const MONO_FONT_NAME_DEFAULT = ''
/** 字体名长度上限：超长输入只可能是误粘贴，钳断防样式串膨胀 */
export const MONO_FONT_NAME_MAX_LENGTH = 64

/** 终端光标形态（P-20261005-212）：xterm options.cursorStyle 原生三档——
 *  block = 填充块（xterm 缺省，存量行为）；bar = 竖条 / underline = 下划线
 *  （不遮挡光标下字符，vim/emacs 等编辑态重度使用场景的偏好） */
export type TerminalCursorStyle = 'block' | 'bar' | 'underline'
export const TERMINAL_CURSOR_STYLES: readonly TerminalCursorStyle[] = ['block', 'bar', 'underline']
export const TERMINAL_CURSOR_STYLE_DEFAULT: TerminalCursorStyle = 'block'
/** 光标闪烁缺省开：与 useTerminalAddons 既有硬编码 cursorBlink: true 同值——
 *  旧存储缺档零迁移；关闭 = 静止常显（演示/录屏场景友好） */
export const TERMINAL_CURSOR_BLINK_DEFAULT = true

/** 编辑器自动保存档位（对标 VS Code files.autoSave）：off = 仅手动保存（默认，
 *  存量行为不变）；afterDelay = 内容变更停手 autoSaveDelayMs 后自动走既有保存链 */
export type EditorAutoSave = 'off' | 'afterDelay'

/** 编辑器行高倍率档（P-20261006-7，对标 VS Code editor.lineHeight）：倍率制随字号
 *  联动（像素制在大字号下行距比例失配）；缺省 1.5 ≈ 硬编码 22px / 缺省字号 14px
 *  的既有观感（DiffViewer 虚拟行槽 P-20261004-104 同为 ×1.5 口径）。生效行高 =
 *  生效字号 × 倍率，出口 editorLineHeight（初装/字号联动/倍率切换同源） */
export const LINE_HEIGHT_MULTIPLIERS: readonly number[] = [1.2, 1.4, 1.5, 1.6, 1.8, 2.0]
export const LINE_HEIGHT_MULTIPLIER_DEFAULT = 1.5
/** diff 色板档（P-20261006-5）：standard = 现状红绿；colorblind = 蓝/橙替代
 *  （deuteranopia-safe 业界标准组合，红绿色弱用户约 8% 男性）。色觉是人类感知
 *  条件（本地装了才能生效），设备本地视觉偏好落 localStorage——uiFont 双档同口径。
 *  生效链：本 store 承载档位与持久化，CSS 变量 --diff-added/--diff-removed 由
 *  theme store apply() 按「当前主题 × 本档」解析写入，Monaco diffEditor 经
 *  applyMonacoTheme 同源注入（themes/diffPalette.ts 单点解析） */
export type DiffPalette = 'standard' | 'colorblind'

export const DIFF_PALETTE_DEFAULT: DiffPalette = 'standard'

interface FontConfig {
  base: number
  editor: number
  terminal: number
  diff: number
  sidebar: number
  bottom: number
}

/** 编辑器外观配置段（导出供消费方类型引用，如设置导出/导入的 font 节消毒） */
export interface EditorConfig {
  tabSize: number
  insertSpaces: boolean
  wordWrap: 'on' | 'off' | 'wordWrapColumn'
  minimap: boolean
  /** sticky scroll：当前作用域的函数/类定义钉在编辑器顶部滚动（Monaco 内置，VS Code 默认开） */
  stickyScroll: boolean
  renderWhitespace: 'none' | 'selection' | 'all'
  /** 自动保存档位（P-20261002-129）：消费方 useOpenFiles（防抖保存挂接） */
  autoSave: EditorAutoSave
  /** afterDelay 档停手延时（毫秒）；设置页输入钳制在 [500, 10000] */
  autoSaveDelayMs: number
  /** 保存时自动格式化（P-20261003-83，对标 VS Code files.formatOnSave）：默认关
   *  （存量行为不变）。消费方 MonacoEditor save-file 动作——保存链前置执行内建
   *  「格式化文档」action，语言有无 formatter 由 Monaco provider 注册表决定 */
  formatOnSave: boolean
  /** 编辑器 tab 按 git 状态着色下划线（P-20261003-242，对标 VS Code
   *  workbench.editor.decorations）：默认关（视觉克制，存量 tab 形态不变）。
   *  消费方 EditorGroupPane tab 渲染——修改蓝 / 未跟踪绿细条，数据面为
   *  changes store 缓存（零新增请求） */
  gitStatusTabs: boolean
  /** 行高倍率（P-20261006-7，档位 LINE_HEIGHT_MULTIPLIERS）：消费方
   *  monacoEditorFactory 初装 options + useEditorOptionSyncs 字号联动 watch，
   *  经 editorLineHeight 出口换算 */
  lineHeightMultiplier: number
  /** 括号对彩色化（P-20261006-9，对标 VS Code editor.bracketPairColorization）：
   *  默认开（存量行为不变）。与 markdown 域语言差异正交组合（见
   *  bracketColorizationEnabled）——markdown 文档括号是散文标点，恒维持差异化关闭。
   *  消费方 monacoEditorFactory 创建期 + useEditorOptionSyncs 语言 watch /
   *  editor 深度 watch（切换即时 updateOptions 生效） */
  bracketColor: boolean}

const FONT_DEFAULTS: FontConfig = {
  base: 13,
  editor: 14,
  terminal: 14,
  diff: 13,
  sidebar: 13,
  bottom: 13,
}

/** 终端字号步进上下限（与设置页 TerminalSettings 滑条 min/max 一致）：
 *  Ctrl+滚轮手势 / 字号快捷键 / 工具栏按钮共用 */
export const TERMINAL_FONT_SIZE_MIN = 10
export const TERMINAL_FONT_SIZE_MAX = 32

const UI_FONT_DEFAULT: UIFontFamily = 'brand'

const TERMINAL_LIGATURES_DEFAULT: TerminalLigatures = 'on'

/** 字体名消毒：剥掉引号/反斜杠/声明终结符——名字会拼进 font-family 值串（CSS
 *  变量与 xterm 内联样式两处），这些字符要么断链要么注入垃圾 token；CSS 对整值
 *  非法时静默回退继承，防的是「清空才能恢复」的体验坑而非安全洞 */
export function sanitizeMonoFontName(v: unknown): string {
  if (typeof v !== 'string') return MONO_FONT_NAME_DEFAULT
  return v.replace(/['"\\;{}]/g, '').trim().slice(0, MONO_FONT_NAME_MAX_LENGTH)
}

/** 等宽字体族合成（设置页预览行 / Monaco fontFamily 共用）：自定义名前插
 *  var(--font-mono)（CSS 天然回退，字体缺失整链顺延）。注意返回值同时是
 *  Monaco 测宽缓存键——创建期与运行期 watch 必须经本函数同源取值，否则改
 *  名/清名时键未变不触发重测、光标对位漂移 */
export function composeMonoFontFamily(custom: string): string {
  return custom ? `'${custom}', var(--font-mono)` : 'var(--font-mono)'
}

/** afterDelay 档默认停手延时（毫秒，对标 VS Code files.autoSaveDelay）；
 *  设置页输入钳制上下限（自动保存防抖与设置页输入共用） */
export const AUTOSAVE_DELAY_DEFAULT = 1000
export const AUTOSAVE_DELAY_MIN = 500
export const AUTOSAVE_DELAY_MAX = 10000

/** 括号彩色化生效值（P-20261006-9）：设置开关与 markdown 语言差异正交组合——
 *  markdown 恒关（散文括号着色是噪音，存量差异化语义保留），其余语言跟随开关。
 *  三处引用点（monacoEditorFactory / MonacoEditor path watcher /
 *  useEditorOptionSyncs 两 watch）同源取值，防止派生逻辑漂移 */
export function bracketColorizationEnabled(bracketColor: boolean, lang: string | undefined): boolean {
  return bracketColor && lang !== 'markdown'
}

const EDITOR_DEFAULTS: EditorConfig = {
  tabSize: 4,
  insertSpaces: true,
  wordWrap: 'off',
  minimap: true,
  stickyScroll: true,
  renderWhitespace: 'selection',
  autoSave: 'off',
  autoSaveDelayMs: AUTOSAVE_DELAY_DEFAULT,
  formatOnSave: false,
  gitStatusTabs: false,
  lineHeightMultiplier: LINE_HEIGHT_MULTIPLIER_DEFAULT,
  bracketColor: true,}

export const useFontStore = defineStore('font', () => {
  const sizes = ref<FontConfig>({ ...FONT_DEFAULTS })
  const editor = ref<EditorConfig>({ ...EDITOR_DEFAULTS })
  const uiFont = ref<UIFontFamily>(UI_FONT_DEFAULT)
  const terminalLigatures = ref<TerminalLigatures>(TERMINAL_LIGATURES_DEFAULT)
  /** 光标形态/闪烁（P-20261005-212）：设备本地视觉偏好（P-87 字号同款
   *  localStorage 口径，智能体无消费需求）。消费方 = 创建期 options
   *  （createTerminalWithAddons）+ 运行期 watch（useTerminalInstances /
   *  TerminalPane 直写 term.options 即时生效，options 动态可设） */
  const cursorStyle = ref<TerminalCursorStyle>(TERMINAL_CURSOR_STYLE_DEFAULT)
  const cursorBlink = ref(TERMINAL_CURSOR_BLINK_DEFAULT)
  /** 自定义等宽字体名（P-20261005-227）：写侧一律经 setMonoFontName/load 消毒，
   *  消费方（terminal-theme 的 currentFontStack、Monaco 同步 watch、预览行）可
   *  直接拼值无需再防 */
  const monoFontName = ref(MONO_FONT_NAME_DEFAULT)
  /** diff 色板档（P-20261006-5）：CSS/Monaco 双消费面经 theme store 与
   *  applyMonacoTheme 按此档解析，本 store 不直接写 diff 色变量 */
  const diffPalette = ref<DiffPalette>(DIFF_PALETTE_DEFAULT)
  /** 生效等宽字体族（Monaco 运行期同步 watch 的响应式出口；xterm 侧走
   *  terminal-theme store 的 currentFontStack 同一数据源另拼 xterm 栈） */
  const monoFontFamily = computed(() => composeMonoFontFamily(monoFontName.value))
  /** 投屏演示模式临时缩放（P-20261002-45）：生效字号 = 持久字号 × presentScale，
   *  纯内存瞬态不落盘（不写入 font-settings），退出即还原 1。编辑器/终端渲染
   *  （Monaco/xterm）与 --fs-editor/--fs-terminal CSS 变量统一走
   *  editorFontSize/terminalFontSize 出口；设置页滑条与字号手势仍读写持久
   *  sizes（演示中调整基础字号 = 缩放基数变化），与 ui-zoom（P-2）正交 */
  const presentScale = ref(1)

  /** 编辑器生效字号：演示态 = 持久 editor × 缩放（四舍五入取整），
   *  Monaco 初始 options 与字号 watch 共用此出口 */
  const editorFontSize = computed(() => Math.round(sizes.value.editor * presentScale.value))
  /** 终端生效字号：xterm options.fontSize 与工具栏字号指示共用此出口 */
  const terminalFontSize = computed(() => Math.round(sizes.value.terminal * presentScale.value))
  /** 编辑器生效行高（P-20261006-7）：生效字号 × 行高倍率（四舍五入取整，Monaco
   *  期望整数 px）——随字号联动重算（含演示态缩放）与倍率切换即时生效两路同源；
   *  MonacoEditor 初装 options 与运行期 watch 共用此出口 */
  const editorLineHeight = computed(() =>
    Math.round(editorFontSize.value * editor.value.lineHeightMultiplier),
  )

  function load() {
    try {
      const saved = safeStorage.getItem(FONT_SETTINGS_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        sizes.value = { ...FONT_DEFAULTS, ...parsed.sizes }
        editor.value = { ...EDITOR_DEFAULTS, ...parsed.editor }
        // 自动保存字段消毒：存量缺档由展开默认兜底；损坏值（手改存储）钳回
        // 安全档位/区间，防延时 NaN 使 setTimeout 退化为 0ms 每击键保存
        if (editor.value.autoSave !== 'afterDelay') editor.value.autoSave = 'off'
        const d = Number(editor.value.autoSaveDelayMs)
        editor.value.autoSaveDelayMs = Math.min(AUTOSAVE_DELAY_MAX, Math.max(AUTOSAVE_DELAY_MIN, Number.isFinite(d) ? Math.round(d) : AUTOSAVE_DELAY_DEFAULT))
        // 布尔开关消毒（formatOnSave，P-20261003-83）：非布尔（手改存储）回默认关
        if (typeof editor.value.formatOnSave !== 'boolean') editor.value.formatOnSave = false
        // 布尔开关消毒（gitStatusTabs，P-20261003-242）：非布尔（手改存储）回默认关
        if (typeof editor.value.gitStatusTabs !== 'boolean') editor.value.gitStatusTabs = false
        // 行高倍率消毒（P-20261006-7）：档位外数值（手改存储）回缺省 1.5
        if (!LINE_HEIGHT_MULTIPLIERS.includes(editor.value.lineHeightMultiplier)) {
          editor.value.lineHeightMultiplier = LINE_HEIGHT_MULTIPLIER_DEFAULT
        }
        // 布尔开关消毒（bracketColor，P-20261006-9）：非布尔（手改存储）回默认开
        if (typeof editor.value.bracketColor !== 'boolean') editor.value.bracketColor = true
        if (parsed.uiFont === 'brand' || parsed.uiFont === 'system') {
          uiFont.value = parsed.uiFont
        }
        if (parsed.terminalLigatures === 'on' || parsed.terminalLigatures === 'off') {
          terminalLigatures.value = parsed.terminalLigatures
        }
        // 自定义等宽字体名消毒（P-20261005-227）：非字符串（存量缺档/手改存储）回空 = 内置栈
        monoFontName.value = sanitizeMonoFontName(parsed.monoFontName)
        // 光标偏好消毒（P-20261005-212）：档位外样式/非布尔闪烁（手改存储）回缺省
        // block+闪烁（= xterm 默认），旧存储缺档由 ref 初值兜底零迁移
        if (TERMINAL_CURSOR_STYLES.includes(parsed.cursorStyle)) {
          cursorStyle.value = parsed.cursorStyle
        }
        if (typeof parsed.cursorBlink === 'boolean') {
          cursorBlink.value = parsed.cursorBlink
        }
        // diff 色板档消毒（P-20261006-5）：值域外（存量缺档/手改存储）回标准档
        if (parsed.diffPalette === 'standard' || parsed.diffPalette === 'colorblind') {
          diffPalette.value = parsed.diffPalette
        }
      }
    } catch { /* ignore */ }
    apply()
  }

  function save() {
    safeStorage.setItem(FONT_SETTINGS_KEY, JSON.stringify({ sizes: sizes.value, editor: editor.value, uiFont: uiFont.value, terminalLigatures: terminalLigatures.value, monoFontName: monoFontName.value, cursorStyle: cursorStyle.value, cursorBlink: cursorBlink.value, diffPalette: diffPalette.value }))
    apply()
  }

  function apply() {
    // 界面字体族经 data 属性切换（base.css 按属性覆写 --font-ui/--font-display）
    document.documentElement.dataset.uiFont = uiFont.value
    document.documentElement.dataset.ligatures = terminalLigatures.value
    // diff 色板档经 data 属性暴露（P-20261006-5）：e2e/调试读取档位锚点；
    // 实际色值写 --diff-added/--diff-removed 由 theme store apply() 单点负责
    document.documentElement.dataset.diffPalette = diffPalette.value
    const root = document.documentElement.style
    // 自定义等宽字体名（P-20261005-227）：写 --font-mono-lead 前插段（带尾逗号
    // 保回退链），空值删内联回 base.css :root 缺省空——removeProperty 而非写空串，
    // 让「清空 = 内置栈」与「从未设置」同路径
    if (monoFontName.value) root.setProperty('--font-mono-lead', `'${monoFontName.value}', `)
    else root.removeProperty('--font-mono-lead')
    const b = sizes.value.base
    root.setProperty('--fs-base', `${b}px`)
    root.setProperty('--fs-small', `${b - 1}px`)
    root.setProperty('--fs-tiny', `${b - 2}px`)
    root.setProperty('--fs-editor', `${editorFontSize.value}px`)
    root.setProperty('--fs-terminal', `${terminalFontSize.value}px`)
    root.setProperty('--fs-diff', `${sizes.value.diff}px`)
    root.setProperty('--fs-sidebar', `${sizes.value.sidebar}px`)
    root.setProperty('--fs-bottom', `${sizes.value.bottom}px`)
  }

  function setUiFont(f: UIFontFamily) {
    uiFont.value = f
    save()
  }

  function setTerminalLigatures(v: TerminalLigatures) {
    terminalLigatures.value = v
    save()
  }

  /** 自定义等宽字体名（P-20261005-227）：消毒后走 save 统一落盘 + apply；
   *  同值重复写无副作用（ref 赋值同值不触发下游 watch） */
  function setMonoFontName(v: string) {
    monoFontName.value = sanitizeMonoFontName(v)
    save()
  }

  /** 光标形态/闪烁设置（设置页直写行与设置迁移导入共用正门）：save 落盘后
   *  运行中会话由 useTerminalInstances / TerminalPane 的 watch 直写
   *  term.options 即时生效；同值重复写无副作用 */
  function setCursorStyle(v: TerminalCursorStyle) {
    cursorStyle.value = v
    save()
  }

  function setCursorBlink(v: boolean) {
    cursorBlink.value = v
    save()
  }

  /** diff 色板档切换（P-20261006-5）：落盘后 theme store 对本档的 watch 重写
   *  --diff-added/--diff-removed，编辑器侧 watch 联动 applyMonacoTheme 重注入 */
  function setDiffPalette(v: DiffPalette) {
    diffPalette.value = v
    save()
  }

  function setSize(section: FontSection, size: number) {
    sizes.value[section] = size
    save()
  }

  /** 投屏演示模式字号缩放入口（usePresentMode enter/exit 调用）：只改内存
   *  缩放系数并重应用 CSS 变量，持久 sizes 与 font-settings 存储原样不动；
   *  Monaco/xterm 消费方各自 watch 生效字号随动 */
  function setPresentScale(scale: number) {
    presentScale.value = scale
    apply()
  }

  /** 终端字号步进 ±1 的共用漏斗（工具栏按钮 / Ctrl+=、- 快捷键 / Ctrl+滚轮手势）：
   *  上下限钳制沿用设置页滑条约束，越界步进静默忽略 */
  function stepTerminalSize(delta: number) {
    const next = Math.min(TERMINAL_FONT_SIZE_MAX, Math.max(TERMINAL_FONT_SIZE_MIN, sizes.value.terminal + delta))
    if (next !== sizes.value.terminal) setSize('terminal', next)
  }

  function updateEditor<K extends keyof EditorConfig>(key: K, value: EditorConfig[K]) {
    editor.value[key] = value
    save()
  }

  /** 自动保存停手延时设置（设置页输入）：钳制 [MIN, MAX] 取整后走 updateEditor */
  function setAutoSaveDelay(ms: number) {
    const v = Math.min(AUTOSAVE_DELAY_MAX, Math.max(AUTOSAVE_DELAY_MIN, Math.round(ms)))
    updateEditor('autoSaveDelayMs', v)
  }

  function reset() {
    sizes.value = { ...FONT_DEFAULTS }
    editor.value = { ...EDITOR_DEFAULTS }
    save()
  }

  load()

  // FONT_DEFAULTS/EDITOR_DEFAULTS/UI_FONT_DEFAULT/TERMINAL_LIGATURES_DEFAULT/DIFF_PALETTE_DEFAULT 随 store
  // 暴露：设置页行级「已修改」标记以它们（load 合并前 defaults）为对比基准（P-20261003-171）
  return { sizes, editor, uiFont, terminalLigatures, monoFontName, monoFontFamily, cursorStyle, cursorBlink, diffPalette, setUiFont, setTerminalLigatures, setMonoFontName, setCursorStyle, setCursorBlink, setDiffPalette, setSize, setPresentScale, stepTerminalSize, updateEditor, setAutoSaveDelay, reset, load, presentScale, editorFontSize, terminalFontSize, editorLineHeight, FONT_DEFAULTS, EDITOR_DEFAULTS, UI_FONT_DEFAULT, TERMINAL_LIGATURES_DEFAULT, DIFF_PALETTE_DEFAULT, MONO_FONT_NAME_DEFAULT, TERMINAL_CURSOR_STYLE_DEFAULT, TERMINAL_CURSOR_BLINK_DEFAULT }
})
