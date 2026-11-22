<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import type { EditorMdMode } from '../../stores/uiState'
import { enhanceMdTables } from './mdTableResize'
import { closeMdLightbox } from '../../utils/mdLightbox'

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
// 灯箱挂 body 不随本面板 v-if（随 md 模式切换挂摘）摘除，卸载时主动收口
//（P-20261120-3：切回源码态/关编辑器组时灯箱残留会盖住全应用）
onBeforeUnmount(closeMdLightbox)

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
