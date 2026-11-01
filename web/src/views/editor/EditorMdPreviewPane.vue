<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { EditorMdMode } from '../../stores/uiState'
import { enhanceMdTables } from './mdTableResize'

/**
 * Markdown 预览面板（P-20261003-301 拆分、run15 修复落位）：
 * DOM 落位 = editor-body 内、源码编辑器右侧（split 态各占 50%）——与模式栏
 * （MdModeBar，wrapper 第一个子项）不同位。此前以 fragment 一次导出曾把本面板
 * 挤成 wrapper 列方向子项，height:100% 吃光列高把 editor-body 压成 0 高、
 * split 态源码面只剩 5px 视口。打印 / 导出 PDF（P-20261003-244）：打印标记类
 * 的挂/摘随本组件自包含——<html> md-printing + 本组面板 md-printing-pane
 * （多分屏时打印样式只留本组预览）后走原生 window.print；打印入口经宿主
 * 转调（模式栏按钮 → MdModeBar print 事件 → 宿主调本组件 printPreview）。
 * 预览内容 HTML 走 marked + DOMPurify 渲染管线（useEditorMdPreview，宿主持有），
 * 链接点击导航分流上抛宿主（P-20261003-108）。md 表格列宽保护与拖拽
 * （P-20261010-1）：CSS 下限在本组件样式，拖拽增强在 mdTableResize.ts。
 */
const props = defineProps<{
  mdMode: 'source' | 'preview' | 'split'
  renderedHtml: string
}>()
const emit = defineEmits<{
  /** 预览容器 click 委托（v-html 内容绑不了组件事件）：链接分流归宿主管线 */
  (e: 'preview-click', event: MouseEvent): void
}>()

// ── 打印标记类生命周期（P-20261003-244）──
const mdPreviewEl = ref<HTMLElement | null>(null)
let mdPrintCleanupTimer: number | undefined

// ── md 表格列宽拖拽增强（P-20261010-1）：v-html 每次替换 DOM 后新表不带手柄，
// renderedHtml 变化（含 150ms 防抖渲染）下一拍补挂；enhanceMdTables 幂等
//（dataset 守卫），无表时零开销。仅靠 watch 会漏「挂载时 renderedHtml 已就绪
// 且此后不变」的入口（本面板 v-if 随模式切换挂载，源码切预览后内容稳定即此态；
// watch immediate 在 setup 期触发，mdPreviewEl 尚未绑 ref）——首挂 onMounted 补
// 一拍，与 watch 双入口同落幂等 enhance ──
function enhanceTablesNextTick() {
  void nextTick(() => {
    if (mdPreviewEl.value) enhanceMdTables(mdPreviewEl.value)
  })
}
onMounted(enhanceTablesNextTick)
watch(() => props.renderedHtml, enhanceTablesNextTick)

function cleanupMdPrintMarkers() {
  document.documentElement.classList.remove('md-printing')
  mdPreviewEl.value?.closest('.editor-pane')?.classList.remove('md-printing-pane')
  if (mdPrintCleanupTimer !== undefined) {
    window.clearTimeout(mdPrintCleanupTimer)
    mdPrintCleanupTimer = undefined
  }
}

/** afterprint（打印窗关闭，含取消）摘标记；60s 定时兜底防个别环境 afterprint
 *  不触发时标记残留——残留会让之后的 Ctrl+P 误入「只印预览」形态 */
function printPreview() {
  if (!mdPreviewEl.value) return
  document.documentElement.classList.add('md-printing')
  mdPreviewEl.value.closest('.editor-pane')?.classList.add('md-printing-pane')
  window.addEventListener('afterprint', cleanupMdPrintMarkers, { once: true })
  mdPrintCleanupTimer = window.setTimeout(cleanupMdPrintMarkers, 60_000)
  window.print()
}

// 打印标记类/兜底定时器随卸载清掉（打印窗开着时卸载编辑器组的极端时序，
// 残留标记会让之后的 Ctrl+P 误入预览打印形态）
onBeforeUnmount(cleanupMdPrintMarkers)

defineExpose({ printPreview })
</script>

<template>
  <!-- 预览面板 -->
  <div
    ref="mdPreviewEl"
    class="md-preview"
    :style="{ width: mdMode === 'split' ? '50%' : '100%' }"
  >
    <div
      class="md-preview-content"
      v-html="renderedHtml"
      @click="emit('preview-click', $event)"
    />
  </div>
</template>

<style scoped>
/* Markdown 预览 */
.md-preview {
  height: 100%;
  overflow-y: auto;
  /* 多列表格的短列下限（4em×列数）可能超出面板宽：横滚承接，不撑破布局 */
  overflow-x: auto;
  border-left: 1px solid var(--border-default);
  background: var(--bg-primary);
}
.md-preview-content {
  padding: 16px 24px;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.6;
  max-width: 800px;
}
.md-preview-content :deep(h1) { font-size: 1.8em; border-bottom: 1px solid var(--border-default); padding-bottom: 8px; margin: 16px 0 12px; color: var(--text-primary); }
.md-preview-content :deep(h2) { font-size: 1.4em; border-bottom: 1px solid var(--border-default); padding-bottom: 6px; margin: 14px 0 10px; color: var(--text-primary); }
.md-preview-content :deep(h3) { font-size: 1.2em; margin: 12px 0 8px; color: var(--text-primary); }
.md-preview-content :deep(h4) { font-size: 1.1em; margin: 10px 0 6px; color: var(--text-primary); }
.md-preview-content :deep(p) { margin: 8px 0; }
.md-preview-content :deep(a) { color: var(--accent-blue); text-decoration: none; }
.md-preview-content :deep(a:hover) { text-decoration: underline; }
.md-preview-content :deep(code) { background: var(--bg-panel); padding: 2px 6px; border-radius: 3px; font-family: var(--font-mono); font-size: 0.9em; color: var(--accent-orange); }
.md-preview-content :deep(pre) { background: var(--bg-panel); padding: 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; border: 1px solid var(--border-default); }
.md-preview-content :deep(pre code) { background: none; padding: 0; color: var(--text-primary); }
.md-preview-content :deep(blockquote) { border-left: 3px solid var(--accent-blue); padding: 4px 12px; color: var(--text-secondary); margin: 8px 0; background: color-mix(in srgb, var(--accent-blue) 6%, transparent); border-radius: 0 4px 4px 0; }
.md-preview-content :deep(blockquote p) { margin: 4px 0; }
.md-preview-content :deep(ul), .md-preview-content :deep(ol) { padding-left: 24px; margin: 8px 0; }
.md-preview-content :deep(li) { margin: 4px 0; }
.md-preview-content :deep(li input[type="checkbox"]) { margin-right: 6px; vertical-align: middle; accent-color: var(--brand-accent); }
.md-preview-content :deep(table) { border-collapse: collapse; width: 100%; margin: 8px 0; }
.md-preview-content :deep(th), .md-preview-content :deep(td) { border: 1px solid var(--border-default); padding: 6px 12px; text-align: left; }
.md-preview-content :deep(th) { background: var(--bg-panel); font-weight: 500; }
/* ── md 表格列宽（P-20261010-1）：自动布局按内容分配，长文本列贪婪扩张会把
   短列压到内容最小宽以下（中文无空格可断 →「待回复」逐字竖排）。
   ① min-width 短列下限：四字以内短词（待回复/已完成等）在挤压下保证单行
   （base.css 全局 border-box，calc 补回单元格 padding/边框壳——内容区 4em
   才是短词单行的语义基准）；
   ② overflow-wrap:anywhere 长列上限兜底：窄屏下长列仍可断行不撑破容器
   （下限/上限正交——前者保短词单行，后者保容器不横溢）；拖拽手柄交互逻辑
   在 mdTableResize.ts（分享访客页同形态独立实现，语义保持一致） ── */
.md-preview-content :deep(th), .md-preview-content :deep(td) { min-width: calc(4em + 26px); overflow-wrap: anywhere; }
.md-preview-content :deep(th) { position: relative; }
.md-preview-content :deep(.col-handle) { position: absolute; top: 0; right: 0; width: 4px; height: 100%; cursor: col-resize; touch-action: none; user-select: none; z-index: 1; }
.md-preview-content :deep(.col-handle:hover), .md-preview-content :deep(.col-handle.dragging) { background: var(--brand-accent); opacity: .55; }
/* 切 fixed 后超长内容单元格按管理列表同款纪律收敛（ellipsis + title 悬浮全文，
   title 由 JS 只落在实际截断的单元格上，见 mdTableResize.syncClipTitles） */
.md-preview-content :deep(table.sc-cols-fixed) { table-layout: fixed; }
.md-preview-content :deep(table.sc-cols-fixed th), .md-preview-content :deep(table.sc-cols-fixed td) { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.md-preview-content :deep(tr:nth-child(even)) { background: color-mix(in srgb, var(--bg-panel) 50%, transparent); }
.md-preview-content :deep(img) { max-width: 100%; border-radius: 4px; }
.md-preview-content :deep(hr) { border: none; border-top: 1px solid var(--border-default); margin: 16px 0; }
.md-preview-content :deep(strong) { color: var(--text-primary); font-weight: 600; }
.md-preview-content :deep(em) { color: var(--text-primary); }
/* ── 页内锚点跳转命中高亮（P-20261007-7）：时间线 is-focus 呼吸高亮同款惯例
   （0.8s ease-in-out × 2 轮 ≈ 1.6s，末态=初态无跳变；reduced-motion 静态底色
   回落）。类的挂/摘在 mdAnchorNav.ts——v-html 重渲染整体换 DOM，类挂在新树上 ── */
.md-preview-content :deep(.md-anchor-hit) { animation: md-anchor-breathe 0.8s ease-in-out 2; border-radius: 4px; }
@keyframes md-anchor-breathe {
  0%, 100% { background: transparent; }
  50% { background: var(--bg-hover); }
}
@media (prefers-reduced-motion: reduce) {
  .md-preview-content :deep(.md-anchor-hit) { animation: none; background: var(--bg-hover); }
}
</style>
