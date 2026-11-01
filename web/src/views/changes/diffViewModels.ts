/**
 * DiffViewer 两视图（统一/并排）共享的视图模型类型与行槽逻辑（自 DiffViewer
 * 拆出，纯搬运零逻辑改动）。父组件产出行序列、两视图子组件消费渲染。
 */
import { computed } from 'vue'
import { useFontStore } from '../../stores/font'

/** Unified 视图扁平化行序列（hunk 头/文件头作为行类型混排），供虚拟列表消费。
 *  大 diff（格式化扫描/生成文件）可达数十万行，逐行渲染会冻结面板；行高 = diff
 *  字号 × 1.5（DIFF_LINE_HEIGHT，white-space: pre 钉死行槽），可安全虚拟化 */
export interface FlatUnifiedLine {
  type: string
  content: string
  oldLineNo?: number
  newLineNo?: number
  hunkIndex?: number
}

/** 为 side-by-side 模式准备的数据：将连续的 add/del 配对 */
export interface SideBySideLine {
  type: 'hunk' | 'add' | 'del' | 'context' | 'header' | 'pair' | 'fold'
  leftContent: string
  rightContent: string
  leftLineNo?: number
  rightLineNo?: number
  hunkIndex?: number
  // 折叠占位行（type='fold'）携带：区域键/展开恢复行数/展开态（unified 与并排
  // 两模式消费同一份槽位序列，占位行语义一致）
  regionId?: number
  restoreCount?: number
  expanded?: boolean
}

export type UnifiedRow = FlatUnifiedLine & Pick<SideBySideLine, 'regionId' | 'restoreCount' | 'expanded'>

/** ── 行槽基准（P-20261004-104）：行高 = diff 字号档 × 1.5 既有行距比例。
 *  字号源 = font store 的 diff 档（设置→外观「差异对比」滑条持久档，--fs-diff
 *  的数值源）——提案 MVP 拟借 terminalFontSize 同源，时效核查发现独立 diff 档
 *  早已在位（store/设置页/CSS 变量三处齐全，根节点 font-size 已消费但被模式
 *  容器 12px 硬编码压住），直读之。Math.round 保证整数行槽（scrollTop↔行下标
 *  定距换算与显式钉高一致，无亚像素累积）。两视图虚拟化各建各的 useVirtualList，
 *  行槽换算同源自此处，字号联动不散点 */
export function useDiffLineSlots() {
  const fontStore = useFontStore()
  // 字号消毒：手改存储的损坏值（NaN/≤0）回退默认档，不炸虚拟化几何
  const diffFontSize = computed(() => {
    const px = Number(fontStore.sizes.diff)
    return Number.isFinite(px) && px > 0 ? px : fontStore.FONT_DEFAULTS.diff
  })
  const DIFF_LINE_HEIGHT = computed(() => Math.round(diffFontSize.value * 1.5))
  // 行号列宽随字号等比放大（默认档恰为既有 50px）：字号真正跟随设置后，固定
  // 50px 在大字档会截断 5 位数行号（弱视用户正是大字档人群）；并排 colgroup 的
  // calc(50% - var) 同源换算，默认档像素级不变
  const DIFF_LINE_NO_WIDTH = computed(() => Math.round(diffFontSize.value * 50 / fontStore.FONT_DEFAULTS.diff))
  return { diffFontSize, DIFF_LINE_HEIGHT, DIFF_LINE_NO_WIDTH }
}

// 预定义样式常量，避免每次渲染创建新对象（两视图 hunk/header 行共用）。
// added/removed 语义色走 diff 色板变量（P-20261006-5）——theme store 按当前主题
// × 色板档（设置·外观「diff 色板」）解析写入，色弱档切换时与 Monaco diff 编辑器
// 同源换蓝橙；不直引 --accent-green/--accent-red（全局成功/失败语义色防涟漪）
const STYLE_BG_ADD: Record<string, string> = { background: 'color-mix(in srgb, var(--diff-added) 15%, transparent)' }
const STYLE_BG_DEL: Record<string, string> = { background: 'color-mix(in srgb, var(--diff-removed) 15%, transparent)' }
const STYLE_BG_HUNK: Record<string, string> = { background: 'color-mix(in srgb, var(--accent-vs-blue) 10%, transparent)', color: 'var(--accent-blue-light)' }
const STYLE_BG_HEADER: Record<string, string> = { color: 'var(--text-dim)' }
const STYLE_EMPTY: Record<string, string> = {}

export function lineBgStyle(type: string): Record<string, string> {
  switch (type) {
    case 'add': return STYLE_BG_ADD
    case 'del': return STYLE_BG_DEL
    case 'hunk': return STYLE_BG_HUNK
    case 'header': return STYLE_BG_HEADER
    default: return STYLE_EMPTY
  }
}
