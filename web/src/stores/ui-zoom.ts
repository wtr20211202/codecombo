import { defineStore } from 'pinia'
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'

/**
 * 界面缩放（P-20261002-2）：应用内 zoom 档位，对标 VS Code window.zoomLevel。
 * 远端访问/高分屏小屏下元素过小时无需动浏览器整页缩放（地址栏不跟随、跨设备各自记忆）。
 *
 * 实现走 CSS 标准化 zoom 属性（Chrome 128+/Firefox 126+/Safari 已标准化）：
 * 本 store 只负责把档位写入 `--ui-zoom` 变量（base.css 的 html { zoom: var(--ui-zoom) }
 * 消费），布局 px 单位零改造。持久化经 safeStorage 自有键（font store 同款链路），
 * 不并入 theme-settings/font-settings 键——主题/字体设置域各自独立演进互不干扰。
 */

/** 缩放档位（比例值）：UI 以 90%/100%/110%/125% 分段选择呈现 */
export const UI_ZOOM_LEVELS = [0.9, 1, 1.1, 1.25] as const

export type UiZoomLevel = (typeof UI_ZOOM_LEVELS)[number]

/** 出厂默认档（100%）：设置页行级「已修改」标记的对比基准（P-20261003-171） */
export const UI_ZOOM_DEFAULT: UiZoomLevel = 1

/** 自有 localStorage 键：与 theme-settings（P-20261002-1 同域在途）隔离；
 *  跨标签分发（utils/settingsSync）按此寻址 */
export const UI_ZOOM_STORAGE_KEY = 'ui-zoom-settings'

export const useUiZoomStore = defineStore('ui-zoom', () => {
  const level = ref<UiZoomLevel>(UI_ZOOM_DEFAULT)

  function load() {
    try {
      const saved = safeStorage.getItem(UI_ZOOM_STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as { level?: number }
        if (UI_ZOOM_LEVELS.includes(parsed.level as UiZoomLevel)) {
          level.value = parsed.level as UiZoomLevel
        }
      }
    } catch { /* ignore */ }
    apply()
  }

  function save() {
    safeStorage.setItem(UI_ZOOM_STORAGE_KEY, JSON.stringify({ level: level.value }))
    apply()
  }

  function apply() {
    // 注入根元素内联变量（:root 兜底 1），base.css 的 html zoom 规则即全界面缩放；
    // fixed 定位弹层坐标由标准化 zoom 语义保证，无需组件各自适配
    document.documentElement.style.setProperty('--ui-zoom', String(level.value))
  }

  function setLevel(v: UiZoomLevel) {
    level.value = v
    save()
  }

  // store 首次激活即恢复并注入（App.vue setup 引用，早于任何视图挂载，无缩放跳变）
  load()

  return { level, setLevel, load }
})
