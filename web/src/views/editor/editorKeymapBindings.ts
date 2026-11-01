import * as monaco from 'monaco-editor'
import { canonicalCombo, type KeymapAction } from '../../stores/keymap'

/**
 * 编辑器域键位注册（P-20261008-14）：Monaco 自定义动作（save-file /
 * sc-bookmark.toggle / sc-ask.inline-edit）键位从硬编码接入 keymap 注册表——
 * 挂载按生效值 addAction、改键后 dispose→重注册。Monaco standalone 无运行时
 * 改绑 API，addAction 返回的 Disposable 是官方摘除面（键绑定/命令/右键菜单项
 * 随它整体回滚，vendored standaloneCodeEditor.addAction 的 toDispose 聚合），
 * 重注册即改绑，不留死键位。
 *
 * 生命周期注记（单测钉住 editorKeymapBindings.test.ts）：
 * - 多编辑器组（分屏双 MonacoEditor 实例）各持独立 handle，Monaco 内部以
 *   editorId + action id 为 uniqueId，实例间互不串扰
 * - 键绑定注册面在编辑器实例而非 model——换签/model 切换不影响，无需重注册
 * - 宿主卸载前须 dispose（MonacoEditor onBeforeUnmount），防编辑器已灭句柄复活
 */

/** keymap 规范 combo 的主键 → Monaco KeyCode 显式查表（键域与审计脚本
 *  check-keybindings.mjs 的 MONACO_KEYS 解码面同口径——反差对，任一侧扩键域
 *  须同步）。表外主键返回 undefined：改绑录入面（normalizeLayoutCombo 捕获
 *  KeyboardEvent.key）可能产出 Monaco 无对应键码的值，编码失败按下方降级 */
const MAIN_KEY_CODES: Readonly<Record<string, monaco.KeyCode>> = {
  a: monaco.KeyCode.KeyA, b: monaco.KeyCode.KeyB, c: monaco.KeyCode.KeyC,
  d: monaco.KeyCode.KeyD, e: monaco.KeyCode.KeyE, f: monaco.KeyCode.KeyF,
  g: monaco.KeyCode.KeyG, h: monaco.KeyCode.KeyH, i: monaco.KeyCode.KeyI,
  j: monaco.KeyCode.KeyJ, k: monaco.KeyCode.KeyK, l: monaco.KeyCode.KeyL,
  m: monaco.KeyCode.KeyM, n: monaco.KeyCode.KeyN, o: monaco.KeyCode.KeyO,
  p: monaco.KeyCode.KeyP, q: monaco.KeyCode.KeyQ, r: monaco.KeyCode.KeyR,
  s: monaco.KeyCode.KeyS, t: monaco.KeyCode.KeyT, u: monaco.KeyCode.KeyU,
  v: monaco.KeyCode.KeyV, w: monaco.KeyCode.KeyW, x: monaco.KeyCode.KeyX,
  y: monaco.KeyCode.KeyY, z: monaco.KeyCode.KeyZ,
  0: monaco.KeyCode.Digit0, 1: monaco.KeyCode.Digit1, 2: monaco.KeyCode.Digit2,
  3: monaco.KeyCode.Digit3, 4: monaco.KeyCode.Digit4, 5: monaco.KeyCode.Digit5,
  6: monaco.KeyCode.Digit6, 7: monaco.KeyCode.Digit7, 8: monaco.KeyCode.Digit8,
  9: monaco.KeyCode.Digit9,
  f1: monaco.KeyCode.F1, f2: monaco.KeyCode.F2, f3: monaco.KeyCode.F3,
  f4: monaco.KeyCode.F4, f5: monaco.KeyCode.F5, f6: monaco.KeyCode.F6,
  f7: monaco.KeyCode.F7, f8: monaco.KeyCode.F8, f9: monaco.KeyCode.F9,
  f10: monaco.KeyCode.F10, f11: monaco.KeyCode.F11, f12: monaco.KeyCode.F12,
  arrowup: monaco.KeyCode.UpArrow, arrowdown: monaco.KeyCode.DownArrow,
  arrowleft: monaco.KeyCode.LeftArrow, arrowright: monaco.KeyCode.RightArrow,
  pageup: monaco.KeyCode.PageUp, pagedown: monaco.KeyCode.PageDown,
  home: monaco.KeyCode.Home, end: monaco.KeyCode.End,
  enter: monaco.KeyCode.Enter, escape: monaco.KeyCode.Escape,
  tab: monaco.KeyCode.Tab, space: monaco.KeyCode.Space,
  backspace: monaco.KeyCode.Backspace, delete: monaco.KeyCode.Delete,
  insert: monaco.KeyCode.Insert,
  // 符号键（canonicalCombo 的主键 = KeyboardEvent.key 小写；US 物理键为主，
  // 移位字符形如 '~' 不入表——改键到移位字符形时编码失败走降级，主键位照常）
  '`': monaco.KeyCode.Backquote, '-': monaco.KeyCode.Minus, '=': monaco.KeyCode.Equal,
  '\\': monaco.KeyCode.Backslash, '[': monaco.KeyCode.BracketLeft, ']': monaco.KeyCode.BracketRight,
  ';': monaco.KeyCode.Semicolon, '\'': monaco.KeyCode.Quote,
  ',': monaco.KeyCode.Comma, '.': monaco.KeyCode.Period, '/': monaco.KeyCode.Slash,
}

/**
 * keymap 规范 combo → Monaco 键码（addAction keybindings 元素）。
 * 修饰符 ctrl 用 KeyMod.CtrlCmd——注册表规范形把 meta 并入 ctrl（mac 上
 * Cmd/Ctrl 均可触发，keymap.ts 归一化语义），CtrlCmd 在 mac 映射 Cmd 语义同源。
 * 无法编码（空 combo / 主键无键码映射）返回 0，调用方按「无键位」降级。
 */
export function comboToMonacoKeybinding(combo: string): number {
  const canonical = canonicalCombo(combo)
  if (!canonical) return 0
  let kb = 0
  let main = 0
  for (const part of canonical.split('+')) {
    if (part === 'ctrl') kb |= monaco.KeyMod.CtrlCmd
    else if (part === 'alt') kb |= monaco.KeyMod.Alt
    else if (part === 'shift') kb |= monaco.KeyMod.Shift
    else {
      const code = MAIN_KEY_CODES[part]
      if (code === undefined) return 0
      main = code
    }
  }
  return main ? kb | main : 0
}

/** 单个编辑器域动作的注册规格：Monaco 动作 id 沿用既有（右键菜单/命令面板/
 *  getAction 触发面不变），键位源是 keymap 注册表动作 id */
export interface EditorKeymapBindingSpec {
  /** Monaco 动作 id（save-file / sc-bookmark.toggle / sc-ask.inline-edit） */
  id: string
  /** keymap 注册表动作 id（键位来源，生效值经 combosOf 现场读取） */
  action: KeymapAction
  /** 动作描述符（不含 id/keybindings——id 由 spec 顶层统一，键位按注册表生效值注入） */
  descriptor: Omit<monaco.editor.IActionDescriptor, 'id' | 'keybindings'>
}

export interface EditorKeymapBindingsHandle {
  /** 键位变更后重注册（dispose 全部旧注册 → 按当前生效值重建）；编辑器已
   *  dispose 后调用由宿主保证不发生（卸载顺序：先 handle.dispose 再 editor） */
  refresh: () => void
  /** 摘除全部本 handle 注册的动作（宿主卸载前调用） */
  dispose: () => void
}

/**
 * 按注册表生效值注册全部规格动作并返回句柄。键位编码失败的规格以「无键位」
 * 形态注册（keybindings: []）——动作本体（右键菜单/命令面板/宿主 expose 链）
 * 照常可用，键位静默缺席是诚实降级而非抛错（改键录入面与 Monaco 键码表的
 * 差集只在罕见符号键上出现）
 */
export function attachEditorKeymapBindings(
  editor: monaco.editor.IStandaloneCodeEditor,
  specs: readonly EditorKeymapBindingSpec[],
  comboOf: (action: KeymapAction) => string,
): EditorKeymapBindingsHandle {
  let handles: monaco.IDisposable[] = []
  const unregisterAll = (): void => {
    for (const h of handles) h.dispose()
    handles = []
  }
  const registerAll = (): void => {
    unregisterAll()
    for (const spec of specs) {
      const kb = comboToMonacoKeybinding(comboOf(spec.action))
      // spec.id 合入描述符（Monaco 动作 id = 右键菜单/命令面板/getAction 触发面）
      handles.push(editor.addAction({ ...spec.descriptor, id: spec.id, keybindings: kb ? [kb] : [] }))
    }
  }
  registerAll()
  return {
    refresh: registerAll,
    dispose: unregisterAll,
  }
}
