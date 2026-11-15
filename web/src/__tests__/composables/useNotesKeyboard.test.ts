import { describe, it, expect } from 'vitest'
import { notesActionFor } from '@/composables/useNotesKeyboard'
import { KEYMAP_DEFAULTS } from '@/stores/keymap'

// 笔记面板域快捷键匹配（P-20261107-5）：事件 → 动作纯函数分支表。
function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: 's', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init,
  } as KeyboardEvent
}

describe('notesActionFor', () => {
  it('默认键位五动作各自命中', () => {
    expect(notesActionFor(keyEvent({ key: 's', ctrlKey: true }), KEYMAP_DEFAULTS)).toBe('save')
    expect(notesActionFor(keyEvent({ key: 'm', ctrlKey: true, altKey: true }), KEYMAP_DEFAULTS)).toBe('create')
    expect(notesActionFor(keyEvent({ key: 'r', ctrlKey: true, altKey: true }), KEYMAP_DEFAULTS)).toBe('rename')
    // tab 键盘循环（P-20261112-9-S2）：ctrl+alt+方向键（textarea 内原生 Ctrl+方向
    // 光标按块导航不加 alt，精确匹配不会误吞）
    expect(notesActionFor(keyEvent({ key: 'ArrowRight', ctrlKey: true, altKey: true }), KEYMAP_DEFAULTS)).toBe('nextTab')
    expect(notesActionFor(keyEvent({ key: 'ArrowLeft', ctrlKey: true, altKey: true }), KEYMAP_DEFAULTS)).toBe('prevTab')
  })

  it('tab 循环键不吞编辑语义近邻：裸 Ctrl+方向（textarea 光标按块导航）与 Ctrl+Shift+方向 不命中', () => {
    expect(notesActionFor(keyEvent({ key: 'ArrowRight', ctrlKey: true }), KEYMAP_DEFAULTS)).toBeNull()
    expect(notesActionFor(keyEvent({ key: 'ArrowLeft', ctrlKey: true }), KEYMAP_DEFAULTS)).toBeNull()
    expect(notesActionFor(keyEvent({ key: 'ArrowRight', ctrlKey: true, shiftKey: true }), KEYMAP_DEFAULTS)).toBeNull()
    expect(notesActionFor(keyEvent({ key: 'ArrowLeft', ctrlKey: true, shiftKey: true }), KEYMAP_DEFAULTS)).toBeNull()
  })

  it('无修饰/纯修饰/未绑定键 → null（不消费）', () => {
    expect(notesActionFor(keyEvent({ key: 's' }), KEYMAP_DEFAULTS)).toBeNull()
    expect(notesActionFor(keyEvent({ key: 'Shift', shiftKey: true }), KEYMAP_DEFAULTS)).toBeNull()
    expect(notesActionFor(keyEvent({ key: 'x', ctrlKey: true }), KEYMAP_DEFAULTS)).toBeNull()
  })

  it('meta 归并为 ctrl（mac Cmd+S 等价）', () => {
    expect(notesActionFor(keyEvent({ key: 's', metaKey: true }), KEYMAP_DEFAULTS)).toBe('save')
  })

  it('移位字符歧义键精确匹配（ctrl+alt+m 不命中 shift 变体 M）', () => {
    expect(notesActionFor(keyEvent({ key: 'M', ctrlKey: true, altKey: true, shiftKey: true }), KEYMAP_DEFAULTS)).toBeNull()
  })
})
