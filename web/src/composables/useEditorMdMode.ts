import { ref } from 'vue'
import { useUIStateStore, type EditorMdMode } from '../stores/uiState'

/**
 * Markdown 模式偏好（P-20261003-18）：md 三态（source/preview/split）「上次使用
 * 的模式」持久化——写 uiState editorPrefs 命名空间，打开 .md 时恢复；无记录回落
 * split（与历史默认一致，既有「切到 md 强制 split」的硬重置由此取代）。
 *
 * 模块级单例（useEditorBookmarks 同款协作模式）：分屏双组编辑器共享同一偏好，
 * 卸载/重挂不丢；宿主（MonacoEditor）持本地三态 ref，此处只管「偏好 ↔ 持久化」，
 * 不替代宿主的 per-实例显示状态。uiState boot 异步——宿主以 ensureLoaded().then
 * 承接加载完成后的一致化（书签装饰同款时序）。
 */

/** 循环切换序（Ctrl+Shift+M / mdModeCycle 动作）：source→preview→split→source */
const MD_MODE_CYCLE: readonly EditorMdMode[] = ['source', 'preview', 'split']

/** 已恢复（或用户此后设置）的偏好；初始 split = 无记录时的历史默认 */
const preferredMode = ref<EditorMdMode>('split')

let loaded = false
let loadPromise: Promise<void> | null = null

/** 惰性拉取偏好（幂等，仅一次）：uiState 缺记录/脏值保留 split 默认不写回 */
function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve()
  if (!loadPromise) {
    loadPromise = useUIStateStore().getEditorMdModePreference()
      .then((m) => {
        if (m) preferredMode.value = m
        loaded = true
      })
      .catch(() => { loaded = true })
  }
  return loadPromise
}

/** 用户动作入口（模式按钮/快捷键）：更新偏好并即时持久化（低频写，命名空间
 *  setter 同款；程序化恢复走 preferredMode 直读，不经此处——避免把「无记录的
 *  split 默认」写成记录） */
function setMdMode(mode: EditorMdMode): void {
  preferredMode.value = mode
  void useUIStateStore().saveEditorMdModePreference(mode)
}

/** 循环切换：返回下一模式（调用方落显示态），偏好更新与持久化在此闭环 */
function cycleMdMode(current: EditorMdMode): EditorMdMode {
  // 当前模式恒在表内（表即 EditorMdMode 全集）；?? 兜底 noUncheckedIndexedAccess
  const next = MD_MODE_CYCLE[(MD_MODE_CYCLE.indexOf(current) + 1) % MD_MODE_CYCLE.length] ?? 'split'
  setMdMode(next)
  return next
}

/** 组件桥（useEditorBookmarks 同款返回形状）：MonacoEditor 双实例共享同一单例 */
export function useEditorMdMode() {
  return { preferredMode, ensureLoaded, setMdMode, cycleMdMode }
}
