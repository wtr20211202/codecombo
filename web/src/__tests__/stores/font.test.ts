import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach } from 'vitest'
import { useFontStore } from '@/stores/font'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('fontStore', () => {
  it('默认字体大小为 FONT_DEFAULTS', () => {
    const store = useFontStore()
    expect(store.sizes.base).toBe(13)
    expect(store.sizes.editor).toBe(14)
    expect(store.sizes.terminal).toBe(14)
  })

  it('setSize 设置特定区域字体并持久化', () => {
    const store = useFontStore()
    store.setSize('editor', 18)
    expect(store.sizes.editor).toBe(18)
    // 验证 localStorage 已写入
    const saved = localStorage.getItem('font-settings')
    expect(saved).toBeTruthy()
  })

  it('setSize 多次设置后读取正确', () => {
    const store = useFontStore()
    store.setSize('base', 15)
    store.setSize('sidebar', 12)
    expect(store.sizes.base).toBe(15)
    expect(store.sizes.sidebar).toBe(12)
  })

  it('stepTerminalSize 步进并钳制在设置页滑条上下限内（10–32）', () => {
    const store = useFontStore()
    // 上限钳制：Ctrl+滚轮/快捷键连步不越界（与 TerminalSettings 滑条 max 一致）
    store.setSize('terminal', 31)
    store.stepTerminalSize(1)
    expect(store.sizes.terminal).toBe(32)
    store.stepTerminalSize(1)
    expect(store.sizes.terminal).toBe(32)
    // 下限钳制（与滑条 min 一致）
    store.setSize('terminal', 11)
    store.stepTerminalSize(-1)
    expect(store.sizes.terminal).toBe(10)
    store.stepTerminalSize(-1)
    expect(store.sizes.terminal).toBe(10)
    // 区间内正常步进
    store.setSize('terminal', 14)
    store.stepTerminalSize(1)
    expect(store.sizes.terminal).toBe(15)
  })

  it('reset 恢复默认值', () => {
    const store = useFontStore()
    store.setSize('editor', 20)
    expect(store.sizes.editor).toBe(20)
    store.reset()
    expect(store.sizes.editor).toBe(14)
    expect(store.sizes.base).toBe(13)
  })

  it('updateEditor 更新编辑器配置', () => {
    const store = useFontStore()
    store.updateEditor('tabSize', 2)
    expect(store.editor.tabSize).toBe(2)
    store.updateEditor('minimap', false)
    expect(store.editor.minimap).toBe(false)
  })

  // 自动保存档位（P-20261002-129）：默认关（存量行为不变）、持久化、延时钳制、
  // 存量缺档由 load 合并默认兜底、损坏值消毒
  it('autoSave 默认 off 且停手延时默认 1000', () => {
    const store = useFontStore()
    expect(store.editor.autoSave).toBe('off')
    expect(store.editor.autoSaveDelayMs).toBe(1000)
  })

  it('切 afterDelay 档持久化；setAutoSaveDelay 取整并钳制在 [500, 10000]', () => {
    const store = useFontStore()
    store.updateEditor('autoSave', 'afterDelay')
    expect(store.editor.autoSave).toBe('afterDelay')
    const saved = JSON.parse(localStorage.getItem('font-settings') || '{}') as { editor?: { autoSave?: string } }
    expect(saved.editor?.autoSave).toBe('afterDelay')

    store.setAutoSaveDelay(1500)
    expect(store.editor.autoSaveDelayMs).toBe(1500)
    store.setAutoSaveDelay(1234.6)
    expect(store.editor.autoSaveDelayMs).toBe(1235)
    store.setAutoSaveDelay(1)
    expect(store.editor.autoSaveDelayMs).toBe(500)
    store.setAutoSaveDelay(99999)
    expect(store.editor.autoSaveDelayMs).toBe(10000)
  })

  it('load 合并默认值：存量配置缺自动保存字段时兜底 off/1000', () => {
    localStorage.setItem('font-settings', JSON.stringify({ sizes: { base: 12 }, editor: { tabSize: 2 } }))
    const store = useFontStore()
    expect(store.editor.tabSize).toBe(2) // 存量字段原样保留
    expect(store.editor.autoSave).toBe('off')
    expect(store.editor.autoSaveDelayMs).toBe(1000)
  })

  it('load 消毒损坏的自动保存字段：未知档位回 off，非法延时钳回安全区间', () => {
    localStorage.setItem('font-settings', JSON.stringify({ editor: { autoSave: 'bogus', autoSaveDelayMs: 'oops' } }))
    const corrupt = useFontStore()
    expect(corrupt.editor.autoSave).toBe('off')
    expect(corrupt.editor.autoSaveDelayMs).toBe(1000)

    // 新 pinia 触发重新 load（同 pinia 内 useFontStore 返回缓存实例）
    setActivePinia(createPinia())
    localStorage.setItem('font-settings', JSON.stringify({ editor: { autoSave: 'afterDelay', autoSaveDelayMs: 99999 } }))
    const outOfRange = useFontStore()
    expect(outOfRange.editor.autoSave).toBe('afterDelay')
    expect(outOfRange.editor.autoSaveDelayMs).toBe(10000)
  })

  // 保存时格式化（P-20261003-83）：默认关（存量行为不变）、持久化、存量缺档兜底、损坏值消毒
  it('formatOnSave 默认 false；切换后持久化 font-settings', () => {
    const store = useFontStore()
    expect(store.editor.formatOnSave).toBe(false)
    store.updateEditor('formatOnSave', true)
    expect(store.editor.formatOnSave).toBe(true)
    const saved = JSON.parse(localStorage.getItem('font-settings') || '{}') as { editor?: { formatOnSave?: boolean } }
    expect(saved.editor?.formatOnSave).toBe(true)
  })

  it('load 合并默认值：存量配置缺 formatOnSave 字段时兜底 false；非布尔消毒回 false', () => {
    localStorage.setItem('font-settings', JSON.stringify({ editor: { tabSize: 2 } }))
    const legacy = useFontStore()
    expect(legacy.editor.tabSize).toBe(2)
    expect(legacy.editor.formatOnSave).toBe(false)

    setActivePinia(createPinia())
    localStorage.setItem('font-settings', JSON.stringify({ editor: { formatOnSave: 'yes' } }))
    const corrupt = useFontStore()
    expect(corrupt.editor.formatOnSave).toBe(false)
  })

  // tab 按 git 状态着色（P-20261003-242）：默认关（视觉克制，存量 tab 形态不变）、
  // 持久化、存量缺档兜底、损坏值消毒
  it('gitStatusTabs 默认 false；切换后持久化 font-settings', () => {
    const store = useFontStore()
    expect(store.editor.gitStatusTabs).toBe(false)
    store.updateEditor('gitStatusTabs', true)
    expect(store.editor.gitStatusTabs).toBe(true)
    const saved = JSON.parse(localStorage.getItem('font-settings') || '{}') as { editor?: { gitStatusTabs?: boolean } }
    expect(saved.editor?.gitStatusTabs).toBe(true)
  })

  it('load 合并默认值：存量配置缺 gitStatusTabs 字段时兜底 false；非布尔消毒回 false', () => {
    localStorage.setItem('font-settings', JSON.stringify({ editor: { tabSize: 2 } }))
    const legacy = useFontStore()
    expect(legacy.editor.tabSize).toBe(2)
    expect(legacy.editor.gitStatusTabs).toBe(false)

    setActivePinia(createPinia())
    localStorage.setItem('font-settings', JSON.stringify({ editor: { gitStatusTabs: 'on' } }))
    const corrupt = useFontStore()
    expect(corrupt.editor.gitStatusTabs).toBe(false)
  })

  // 括号对彩色化（P-20261006-9）：默认开（存量行为不变）、持久化、存量缺档兜底、
  // 损坏值消毒；派生函数与 markdown 语言差异正交组合
  it('bracketColor 默认 true；切换后持久化 font-settings', () => {
    const store = useFontStore()
    expect(store.editor.bracketColor).toBe(true)
    store.updateEditor('bracketColor', false)
    expect(store.editor.bracketColor).toBe(false)
    const saved = JSON.parse(localStorage.getItem('font-settings') || '{}') as { editor?: { bracketColor?: boolean } }
    expect(saved.editor?.bracketColor).toBe(false)
  })

  it('load 合并默认值：存量配置缺 bracketColor 字段时兜底 true；非布尔消毒回 true', () => {
    localStorage.setItem('font-settings', JSON.stringify({ editor: { tabSize: 2 } }))
    const legacy = useFontStore()
    expect(legacy.editor.tabSize).toBe(2)
    expect(legacy.editor.bracketColor).toBe(true)

    setActivePinia(createPinia())
    localStorage.setItem('font-settings', JSON.stringify({ editor: { bracketColor: 'yes' } }))
    const corrupt = useFontStore()
    expect(corrupt.editor.bracketColor).toBe(true)
  })

  it('bracketColorizationEnabled：开关与 markdown 语言差异正交组合（md 恒关）', async () => {
    const { bracketColorizationEnabled } = await import('@/stores/font')
    // 非markdown 语言跟随开关
    expect(bracketColorizationEnabled(true, 'typescript')).toBe(true)
    expect(bracketColorizationEnabled(false, 'typescript')).toBe(false)
    // markdown 恒关（散文括号着色是噪音）
    expect(bracketColorizationEnabled(true, 'markdown')).toBe(false)
    expect(bracketColorizationEnabled(false, 'markdown')).toBe(false)
    // 语言未知（undefined）视同非 md，跟随开关
    expect(bracketColorizationEnabled(true, undefined)).toBe(true)
  })

  it('reset 恢复编辑器默认值', () => {
    const store = useFontStore()
    store.updateEditor('tabSize', 8)
    store.reset()
    expect(store.editor.tabSize).toBe(4)
    expect(store.editor.insertSpaces).toBe(true)
  })

  // 行高倍率（P-20261006-7）：默认 1.5 ≈ 硬编码 22px/14px 既有观感；生效行高 =
  // 生效字号 × 倍率（随字号/演示缩放联动重算）、持久化、存量缺档兜底、损坏值消毒
  describe('行高倍率（lineHeightMultiplier）', () => {
    it('默认 1.5，editorLineHeight = 生效字号 × 倍率取整', () => {
      const store = useFontStore()
      expect(store.editor.lineHeightMultiplier).toBe(1.5)
      expect(store.editorLineHeight).toBe(21) // round(14 × 1.5)
    })

    it('切 2.0 档持久化并即时重算行高', () => {
      const store = useFontStore()
      store.updateEditor('lineHeightMultiplier', 2.0)
      expect(store.editorLineHeight).toBe(28)
      const saved = JSON.parse(localStorage.getItem('font-settings') || '{}') as { editor?: { lineHeightMultiplier?: number } }
      expect(saved.editor?.lineHeightMultiplier).toBe(2)
    })

    it('字号变更联动重算：字号 16 × 1.5 = 24', () => {
      const store = useFontStore()
      store.setSize('editor', 16)
      expect(store.editorLineHeight).toBe(24)
    })

    it('演示态缩放联动：presentScale 1.5 时行高随生效字号重算', () => {
      const store = useFontStore()
      // 生效字号 round(14×1.5)=21 → 行高 round(21×1.5)=32（行高跟随生效字号而非持久字号）
      store.setPresentScale(1.5)
      expect(store.editorFontSize).toBe(21)
      expect(store.editorLineHeight).toBe(32)
    })

    it('load 存量缺档兜底 1.5；损坏值（档位外/非数）消毒回 1.5', () => {
      localStorage.setItem('font-settings', JSON.stringify({ editor: { tabSize: 2 } }))
      const legacy = useFontStore()
      expect(legacy.editor.tabSize).toBe(2)
      expect(legacy.editor.lineHeightMultiplier).toBe(1.5)

      setActivePinia(createPinia())
      localStorage.setItem('font-settings', JSON.stringify({ editor: { lineHeightMultiplier: 9.9 } }))
      const corrupt = useFontStore()
      expect(corrupt.editor.lineHeightMultiplier).toBe(1.5)

      setActivePinia(createPinia())
      localStorage.setItem('font-settings', JSON.stringify({ editor: { lineHeightMultiplier: 'big' } }))
      const nonNumber = useFontStore()
      expect(nonNumber.editor.lineHeightMultiplier).toBe(1.5)
    })
  })

  // 投屏演示模式（P-20261002-45）：生效字号出口 = 持久字号 × presentScale
  describe('演示态字号缩放（presentScale）', () => {
    it('默认缩放 1：生效字号等于持久字号', () => {
      const store = useFontStore()
      expect(store.presentScale).toBe(1)
      expect(store.editorFontSize).toBe(store.sizes.editor)
      expect(store.terminalFontSize).toBe(store.sizes.terminal)
    })

    it('setPresentScale 缩放生效字号，持久 sizes 与存储不动', () => {
      const store = useFontStore()
      store.setSize('editor', 15)
      store.setSize('terminal', 14)
      const savedBefore = localStorage.getItem('font-settings')

      store.setPresentScale(1.5)
      // 四舍五入取整（15×1.5=22.5→23；Monaco/xterm 期望整数 px）
      expect(store.editorFontSize).toBe(23)
      expect(store.terminalFontSize).toBe(21)
      // 持久层原样：sizes 是缩放基数、font-settings 未被演示态改写
      expect(store.sizes.editor).toBe(15)
      expect(localStorage.getItem('font-settings')).toBe(savedBefore)

      store.setPresentScale(1)
      expect(store.editorFontSize).toBe(15)
      expect(store.terminalFontSize).toBe(14)
    })
  })

  // 自定义等宽字体名（P-20261005-227）：默认空、消毒、持久化、--font-mono-lead
  // 覆写/清空回内置栈
  describe('自定义等宽字体名（monoFontName）', () => {
    it('默认空 = 内置栈；未设置时不写 --font-mono-lead 内联', () => {
      const store = useFontStore()
      expect(store.monoFontName).toBe('')
      expect(store.MONO_FONT_NAME_DEFAULT).toBe('')
      expect(store.monoFontFamily).toBe('var(--font-mono)')
      expect(document.documentElement.style.getPropertyValue('--font-mono-lead')).toBe('')
    })

    it('setMonoFontName 消毒（剥引号/反斜杠/声明终结符 + trim + 截长）并持久化', () => {
      const store = useFontStore()
      store.setMonoFontName("  'JetBrains'; Mono\"  ")
      expect(store.monoFontName).toBe('JetBrains Mono')
      const saved = JSON.parse(localStorage.getItem('font-settings') || '{}') as { monoFontName?: string }
      expect(saved.monoFontName).toBe('JetBrains Mono')
      // 64 截长
      store.setMonoFontName('x'.repeat(100))
      expect(store.monoFontName.length).toBe(64)
      // 非字符串（导入消毒前置类型不符）回空
      store.setMonoFontName(undefined as unknown as string)
      expect(store.monoFontName).toBe('')
    })

    it('设置后写 --font-mono-lead 前插段（带尾逗号），清空删内联回内置栈', () => {
      const store = useFontStore()
      store.setMonoFontName('Fira Code')
      expect(store.monoFontFamily).toBe("'Fira Code', var(--font-mono)")
      // toContain：jsdom/浏览器对值串尾随空白序列化有差异，语义锚是「名+逗号分隔」
      // （与 base.css 内置栈的拼接空格共同保证回退链形态）
      expect(document.documentElement.style.getPropertyValue('--font-mono-lead')).toContain("'Fira Code',")
      store.setMonoFontName('')
      expect(store.monoFontFamily).toBe('var(--font-mono)')
      expect(document.documentElement.style.getPropertyValue('--font-mono-lead')).toBe('')
    })

    it('load 存量缺档兜底空名；损坏值（非字符串）消毒回空', () => {
      localStorage.setItem('font-settings', JSON.stringify({ sizes: { base: 12 } }))
      const legacy = useFontStore()
      expect(legacy.monoFontName).toBe('')

      setActivePinia(createPinia())
      localStorage.setItem('font-settings', JSON.stringify({ monoFontName: 42 }))
      const corrupt = useFontStore()
      expect(corrupt.monoFontName).toBe('')
    })
  })

  // 终端光标偏好（P-20261005-212）：默认 block+闪烁（= 旧硬编码同值，存量零迁移）、
  // 持久化、存量缺档兜底、损坏值（档位外样式/非布尔闪烁）消毒回缺省
  describe('终端光标偏好（cursorStyle/cursorBlink）', () => {
    it('默认 block + 闪烁开（与 xterm 默认一致）；切换后持久化 font-settings', () => {
      const store = useFontStore()
      expect(store.cursorStyle).toBe('block')
      expect(store.TERMINAL_CURSOR_STYLE_DEFAULT).toBe('block')
      expect(store.TERMINAL_CURSOR_BLINK_DEFAULT).toBe(true)
      store.setCursorStyle('bar')
      store.setCursorBlink(false)
      expect(store.cursorStyle).toBe('bar')
      expect(store.cursorBlink).toBe(false)
      const saved = JSON.parse(localStorage.getItem('font-settings') || '{}') as { cursorStyle?: string; cursorBlink?: boolean }
      expect(saved.cursorStyle).toBe('bar')
      expect(saved.cursorBlink).toBe(false)
    })

    it('load 存量缺档兜底 block+闪烁；损坏值消毒回缺省', () => {
      localStorage.setItem('font-settings', JSON.stringify({ sizes: { base: 12 } }))
      const legacy = useFontStore()
      expect(legacy.cursorStyle).toBe('block')
      expect(legacy.cursorBlink).toBe(true)

      setActivePinia(createPinia())
      localStorage.setItem('font-settings', JSON.stringify({ cursorStyle: 'dotted', cursorBlink: 'yes' }))
      const corrupt = useFontStore()
      expect(corrupt.cursorStyle).toBe('block')
      expect(corrupt.cursorBlink).toBe(true)

      setActivePinia(createPinia())
      localStorage.setItem('font-settings', JSON.stringify({ cursorStyle: 'underline', cursorBlink: false }))
      const valid = useFontStore()
      expect(valid.cursorStyle).toBe('underline')
      expect(valid.cursorBlink).toBe(false)
    })
  })
})
