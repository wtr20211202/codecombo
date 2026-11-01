import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import { useUIStateStore } from './uiState'

/**
 * 布局锁定（P-20261003-180）：「防误拖」toggle——锁定时分隔条拖拽（侧栏宽/
 * 底栏高/分屏比/Git 侧栏/终端分屏/agent 侧栏）、编辑器与终端/远程控制台 tab
 * 拖拽、文件树内拖拽（含多选拖拽移动）、会话树重分组拖拽在各自 handler 入口
 * 经 interceptDrag 统一短路；点击与键盘交互（含 separator 键盘 resize）不受
 * 影响。场景：窄屏/触屏误触拖拽破坏布局、演示时防误操作。
 *
 * - 持久化走 uiState 独立命名空间 layoutLock（低频用户动作即时写，dshConsole
 *   同款）——collectCurrentUIState 不认识本键，auto-save 浅合并天然保留
 *   （editorPrefs 同款教训：塞进会被整键替换的命名空间必被静默抹掉）；
 *   布局重置（P-74 resetLayoutState 只动 layout/fileTree）不波及本开关——
 *   锁定是用户偏好而非布局几何
 * - 恢复挂在 Layout bootstrap 的布局命名空间恢复点（restoreLayoutOnly），
 *   复用同一份已拉取的 uiState 快照，零额外请求
 * - body.sc-layout-locked 是锁定态的唯一 CSS 挂点（assets/main.css 里各分隔
 *   条把手 cursor 归位做「不可拖」观感；body.sc-locked 系统锁定同款惯例）
 */
export const useLayoutLockStore = defineStore('layoutLock', () => {
  const locked = ref(false)

  /** 锁定态落盘（键级补丁只动 layoutLock 字段；失败静默——会话内仍生效，
   *  下次 toggle 重试，dshConsole 开关同款容错） */
  async function persist() {
    try {
      await useUIStateStore().saveLayoutLocked(locked.value)
    } catch { /* pinia 未激活等环境问题静默 */ }
  }

  function setLocked(v: boolean) {
    locked.value = v
    void persist()
  }

  function toggle() {
    setLocked(!locked.value)
  }

  /** 拖拽类 handler 统一短路入口：锁定时取消事件默认行为并返回 true，调用方
   *  据此提前 return。HTML5 dragstart 上 preventDefault = 整个拖拽不启动（无
   *  拖影、不触发 dragover/drop）；mousedown 上则阻断文本选择副作用 */
  function interceptDrag(e?: { preventDefault(): void }): boolean {
    if (!locked.value) return false
    e?.preventDefault()
    return true
  }

  /** 从 bootstrap 已拉取的 uiState 快照恢复（形状防御：非 true 一律回落未
   *  锁定）。只改内存不回写——恢复出的初始值不是本页变更（P-20261002-8
   *  alignBaseline 同源语义） */
  function restoreFromState(state: { layoutLock?: { locked?: boolean } } | null | undefined) {
    locked.value = state?.layoutLock?.locked === true
  }

  // body 类随动：immediate 首跑覆盖「恢复晚于 store 激活」的时序差——
  // bootstrap 恢复只改 locked，类同步统一由本 watch 承担
  watch(locked, (v) => {
    document.body.classList.toggle('sc-layout-locked', v)
  }, { immediate: true })

  return { locked, setLocked, toggle, interceptDrag, restoreFromState }
})
