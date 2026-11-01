import { defineStore } from 'pinia'
import { ref } from 'vue'
import { safeStorage } from '../utils/storage'

/**
 * 提交拓扑泳道上限（P-20261006-29）：BranchGraph 渲染封顶档位。超宽拓扑（活跃
 * 泳道数超上限）并入末道绘制——图形近似但提交行区宽度有界（0ef3374b 实证 47 道
 * 744px 把提交行挤到 11px 宽，封顶见 BranchGraph.vue）。档位 8/16/24/32，默认
 * 16 = 历史硬编码行为零变化；封顶生效时图区出诚实注记（不再静默失真）。
 *
 * 每设备视觉偏好（宽屏放宽/小屏收紧），ui-zoom 同哲学：safeStorage 自有键、
 * 不入设置迁移包（utils/settingsTransfer per-device 差异不入包口径）、跨标签
 * 分发经 utils/settingsSync 按键寻址。
 */

/** 可选档位：8 = 窄面板收紧 / 16 = 历史默认 / 24·32 = 宽拓扑放宽（32 保守封顶） */
export const GRAPH_LANE_LIMITS = [8, 16, 24, 32] as const

export type GraphLaneLimit = (typeof GRAPH_LANE_LIMITS)[number]

/** 出厂默认档（16 = 0ef3374b 引入的硬编码值）：设置页行级「已修改」标记的对比基准 */
export const GRAPH_LANE_LIMIT_DEFAULT: GraphLaneLimit = 16

/** 自有 localStorage 键：ui-zoom-settings 同款隔离惯例——设置域各自独立演进互不干扰 */
export const GRAPH_LANE_STORAGE_KEY = 'graph-lane-settings'

export const useGraphLanesStore = defineStore('graph-lanes', () => {
  const limit = ref<GraphLaneLimit>(GRAPH_LANE_LIMIT_DEFAULT)

  /** 从 safeStorage 静默重读（启动恢复 / settingsSync 跨标签回读共用，有值才覆盖） */
  function load() {
    try {
      const saved = safeStorage.getItem(GRAPH_LANE_STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved) as { limit?: number }
        if (GRAPH_LANE_LIMITS.includes(parsed.limit as GraphLaneLimit)) {
          limit.value = parsed.limit as GraphLaneLimit
        }
      }
    } catch { /* ignore：脏值回落默认档 */ }
  }

  function setLimit(v: GraphLaneLimit) {
    limit.value = v
    try {
      safeStorage.setItem(GRAPH_LANE_STORAGE_KEY, JSON.stringify({ limit: limit.value }))
    } catch { /* 持久化失败不阻断会话内生效（safeStorage 已兜底内存） */ }
  }

  // store 首次激活即恢复：BranchGraph 首帧渲染前读取到已存档位（无档位跳变）
  load()

  return { limit, setLimit, load }
})
