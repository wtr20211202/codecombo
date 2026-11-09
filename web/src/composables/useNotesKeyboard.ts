import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import { matchLayoutCombo, useKeymapStore, type KeymapActionCombo } from '../stores/keymap'

/**
 * 笔记面板焦点域快捷键（P-20261107-5，keymap 注册表 notes 域的消费方）：
 * 保存（notesSave）/新建（notesCreate）/重命名（notesRename）。
 *
 * 生效语义 = 焦点域：document capture 相位监听 + 事件 target 在笔记面板根节点
 * 内才接管——焦点在面板外（Monaco/终端/其他输入框）零影响，面板未挂载即无
 * 监听（与 editor Monaco 聚焦域 / terminal xterm 焦点域同族的物理互斥边界）。
 * capture 相位先于布局链的 document bubble 监听触发，命中即
 * stopImmediatePropagation——布局链收不到已消费的按键（用户把笔记动作改绑到
 * 与全局动作同键时，面板内是笔记动作优先，面板外全局动作照常）。
 *
 * 键位读取走 keymap store 生效值（默认表 + 用户覆盖），改绑即时生效。
 */

export type NotesKeyAction = 'save' | 'create' | 'rename'

/** 事件 → 笔记动作（纯函数，单测面）：按注册表生效值精确匹配（无移位变体
 *  容差——notes 三键默认全无移位字符歧义） */
export function notesActionFor(
  e: KeyboardEvent,
  combos: Pick<KeymapActionCombo, 'notesSave' | 'notesCreate' | 'notesRename'>,
): NotesKeyAction | null {
  if (matchLayoutCombo(e, combos.notesSave)) return 'save'
  if (matchLayoutCombo(e, combos.notesCreate)) return 'create'
  if (matchLayoutCombo(e, combos.notesRename)) return 'rename'
  return null
}

export function useNotesKeyboard(
  root: Ref<HTMLElement | null>,
  handlers: { save: () => void; create: () => void; rename: () => void },
): void {
  const keymap = useKeymapStore()

  function onKeydown(e: KeyboardEvent): void {
    const el = root.value
    const target = e.target as Node | null
    // 焦点域边界：target 不在面板根节点内（面板外/浮层 body 挂载点）不接管
    if (!el || !target || !el.contains(target)) return
    const action = notesActionFor(e, keymap.combos)
    if (!action) return
    e.preventDefault()
    e.stopImmediatePropagation() // 布局链（document bubble）不再收到该按键
    handlers[action]()
  }

  onMounted(() => document.addEventListener('keydown', onKeydown, true))
  onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown, true))
}
