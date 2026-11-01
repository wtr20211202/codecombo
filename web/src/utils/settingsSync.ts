// 多标签本地设置实时同步（P-20261002-36）：主题/语言/字体/缩放等本地设置族只落
// localStorage，锁状态有 WS 通道跨页推送，它们却无任何传播——A 标签切浅色后 B 标签
// 保持暗色直到手动刷新。这里补「读回」链路：监听 storage 事件按 key 分发到对应
// store 的静默重读；写入侧仍在各 store，本模块零状态、零后端改动。
//
// 浏览器语义保证只响应「其他标签页/窗口」的写入（本页写入不向本页派发 storage
// 事件），无需自行去重；localStorage 屏蔽（隐私模式）时 safeStorage 落内存兜底、
// 本就不产生 storage 事件，同步静默降级为各自独立——与既有降级口径一致。

import { useThemeStore, THEME_SETTINGS_KEY } from '../stores/theme'
import { useLocaleStore } from '../stores/locale'
import { useFontStore, FONT_SETTINGS_KEY } from '../stores/font'
import { useUiZoomStore, UI_ZOOM_STORAGE_KEY } from '../stores/ui-zoom'
import { useGraphLanesStore, GRAPH_LANE_STORAGE_KEY } from '../stores/graph-lanes'
import { useFileNestingStore, FILE_NESTING_STORAGE_KEY } from '../stores/file-nesting'
import { useTerminalThemeStore, TERMINAL_THEME_FOLLOW_KEY } from '../stores/terminal-theme'
import { LOCALE_STORAGE_KEY } from '../stores/locale-constants'

/** 本地设置存储键 → 静默重读入口（键与各 store 写入侧一一对应，新设置域在此加一行） */
function buildHandlers(): Record<string, () => void> {
  const themeStore = useThemeStore()
  const localeStore = useLocaleStore()
  const fontStore = useFontStore()
  const uiZoomStore = useUiZoomStore()
  const graphLanesStore = useGraphLanesStore()
  const fileNestingStore = useFileNestingStore()
  const terminalThemeStore = useTerminalThemeStore()
  return {
    [THEME_SETTINGS_KEY]: () => themeStore.syncFromStorage(),
    [LOCALE_STORAGE_KEY]: () => localeStore.syncFromStorage(),
    [FONT_SETTINGS_KEY]: () => fontStore.load(),
    [UI_ZOOM_STORAGE_KEY]: () => uiZoomStore.load(),
    [GRAPH_LANE_STORAGE_KEY]: () => graphLanesStore.load(),
    [FILE_NESTING_STORAGE_KEY]: () => fileNestingStore.load(),
    [TERMINAL_THEME_FOLLOW_KEY]: () => terminalThemeStore.syncFollowFromStorage(),
  }
}

/** 注册跨标签设置同步监听，返回卸载函数（App 挂载一次注册、卸载时摘除）。
 *  须在 pinia 激活后调用（App.vue setup 期满足）。 */
export function initSettingsSync(): () => void {
  const handlers = buildHandlers()
  const onStorage = (e: StorageEvent) => {
    // e.key === null 是 localStorage.clear() 事件（项目零调用，仅浏览器级「清除
    // 站点数据」触发，伴随页面生命周期重置）——font/zoom 的读回语义是「有值才
    // 覆盖」，强撑全量重读需改各 store 口径，超出本条只加「读回」链路的边界，忽略
    if (e.key === null) return
    handlers[e.key]?.()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
