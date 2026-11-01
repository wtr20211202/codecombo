import { describe, it, expect, vi } from 'vitest'
import * as monaco from 'monaco-editor'
import {
  comboToMonacoKeybinding, attachEditorKeymapBindings,
  type EditorKeymapBindingSpec,
} from '@/views/editor/editorKeymapBindings'
import type { KeymapAction } from '@/stores/keymap'

// jsdom 未实现 document.queryCommandSupported，而 monaco clipboard contrib 在模块
// 顶层探测该 API——须在 monaco（及其传递依赖 editorKeymapBindings）求值前补 stub
vi.hoisted(() => {
  if (typeof document !== 'undefined' && !(document as unknown as Record<string, unknown>).queryCommandSupported) {
    (document as unknown as Record<string, unknown>).queryCommandSupported = () => false
  }
})

// 编辑器域键位注册（P-20261008-14）：规范 combo → Monaco 键码编码 + 注册/重注册/
// 摘除生命周期。Monaco standalone 无运行时改绑 API——addAction 返回的 Disposable
// 是官方摘除面（vendored standaloneCodeEditor.addAction 的 toDispose 聚合键绑定/
// 命令/菜单项），dispose→重注册即改绑。本测试以假 editor 钉住该契约面：
// 挂载全量注册、refresh 摘旧注新、dispose 全摘、多实例互不串扰、编码失败降级。

/** 假 editor：记录 addAction 描述符（键位解码断言用）与 disposable 摘除次数 */
function fakeEditor() {
  const added: Array<{ id: string; keybindings: number[]; precondition?: string }> = []
  let disposed = 0
  const editor = {
    addAction: (d: monaco.editor.IActionDescriptor): monaco.IDisposable => {
      added.push({ id: d.id, keybindings: d.keybindings ?? [], precondition: d.precondition })
      return { dispose: () => { disposed++ } }
    },
  }
  return {
    editor: editor as unknown as monaco.editor.IStandaloneCodeEditor,
    added,
    disposedCount: () => disposed,
  }
}

const SPECS: EditorKeymapBindingSpec[] = [
  { id: 'save-file', action: 'editorSave', descriptor: { label: 'save', run: () => {} } },
  { id: 'sc-bookmark.toggle', action: 'editorBookmarkToggle', descriptor: { label: 'bm', run: () => {} } },
  { id: 'sc-ask.inline-edit', action: 'editorInlineEdit', descriptor: { label: 'inline', precondition: 'editorHasSelection', run: () => {} } },
]

const COMBOS: Partial<Record<KeymapAction, string>> = {
  editorSave: 'ctrl+s',
  editorBookmarkToggle: 'ctrl+alt+b',
  editorInlineEdit: 'ctrl+k',
}
const comboOf = (a: KeymapAction) => COMBOS[a] ?? ''

describe('comboToMonacoKeybinding 编码', () => {
  it('规范 combo → KeyMod|KeyCode（ctrl / alt / shift 组合与主键）', () => {
    expect(comboToMonacoKeybinding('ctrl+s')).toBe(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS)
    expect(comboToMonacoKeybinding('ctrl+alt+b')).toBe(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB)
    expect(comboToMonacoKeybinding('ctrl+k')).toBe(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK)
    expect(comboToMonacoKeybinding('ctrl+shift+pagedown')).toBe(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.PageDown)
    expect(comboToMonacoKeybinding('f12')).toBe(monaco.KeyCode.F12)
  })

  it('非规范形先规范化（meta 并入 ctrl、修饰序无关）', () => {
    expect(comboToMonacoKeybinding('Meta+S')).toBe(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS)
    expect(comboToMonacoKeybinding('ALT+CTRL+B')).toBe(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB)
  })

  it('无法编码的输入 → 0（空 combo / 纯修饰符 / 表外主键）', () => {
    expect(comboToMonacoKeybinding('')).toBe(0)
    expect(comboToMonacoKeybinding('ctrl')).toBe(0)
    expect(comboToMonacoKeybinding('ctrl+ø')).toBe(0)
  })
})

describe('attachEditorKeymapBindings 生命周期', () => {
  it('挂载按生效值全量注册：键位编码、precondition 透传', () => {
    const { editor, added } = fakeEditor()
    const handle = attachEditorKeymapBindings(editor, SPECS, comboOf)
    expect(added.map(a => a.id)).toEqual(['save-file', 'sc-bookmark.toggle', 'sc-ask.inline-edit'])
    expect(added[0].keybindings).toEqual([monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS])
    expect(added[1].keybindings).toEqual([monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB])
    expect(added[2].keybindings).toEqual([monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK])
    expect(added[2].precondition).toBe('editorHasSelection')
    handle.dispose()
  })

  it('键位变更 refresh：摘除全部旧注册后按新生效值重建（重注册即改绑）', () => {
    const { editor, added, disposedCount } = fakeEditor()
    const handle = attachEditorKeymapBindings(editor, SPECS, comboOf)
    expect(disposedCount()).toBe(0)
    // editorSave 改绑 ctrl+alt+n：refresh 后旧 ctrl+s 摘除、新键位生效
    COMBOS.editorSave = 'ctrl+alt+n'
    handle.refresh()
    expect(disposedCount()).toBe(3)               // 旧三条整体回滚
    expect(added).toHaveLength(6)                 // 新三条重新注册
    expect(added.slice(3).map(a => a.id)).toEqual(['save-file', 'sc-bookmark.toggle', 'sc-ask.inline-edit'])
    expect(added[3].keybindings).toEqual([monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyN])
    // 收尾摘除的是 refresh 后在册的新三条
    handle.dispose()
    expect(disposedCount()).toBe(6)
  })

  it('多编辑器组（分屏双实例）：各 handle 独立，摘除一个不误伤另一个', () => {
    const a = fakeEditor()
    const b = fakeEditor()
    const handleA = attachEditorKeymapBindings(a.editor, SPECS, comboOf)
    const handleB = attachEditorKeymapBindings(b.editor, SPECS, comboOf)
    expect(a.added).toHaveLength(3)
    expect(b.added).toHaveLength(3)
    handleA.dispose()
    expect(a.disposedCount()).toBe(3)
    expect(b.disposedCount()).toBe(0)
    handleB.dispose()
    expect(b.disposedCount()).toBe(3)
  })

  it('键位编码失败降级：以无键位形态注册（keybindings 空数组，动作本体照常在册）', () => {
    const { editor, added } = fakeEditor()
    // 表外主键（移位字符形 'ctrl+ø'）→ 编码 0 → 空键位数组而非抛错
    const handle = attachEditorKeymapBindings(editor, [SPECS[0]], () => 'ctrl+ø')
    expect(added[0].keybindings).toEqual([])
    handle.dispose()
  })
})
