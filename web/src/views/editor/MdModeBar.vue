<script setup lang="ts">
import { useI18n } from '../../composables/useI18n'
import type { EditorMdMode } from '../../stores/uiState'

/**
 * Markdown 模式切换栏（P-20261003-301 拆分、run15 修复落位）：
 * source/preview/split 三态按钮 + 打印按钮（打印逻辑在预览面板组件，
 * 经宿主转调）。DOM 落位 = editor-body 之上（wrapper 第一个 flex 子项）——
 * 预览面板（EditorMdPreviewPane）则落位在 editor-body 内右侧，两者不可
 * 同位：此前以 fragment 一次导出曾把预览挤到 wrapper 列方向子项，height:100%
 * 吃光列高把源码编辑器压成 0 高（split 态源码面不可见），故拆为两件各归各位。
 */
defineProps<{
  isMarkdown: boolean
  mdMode: EditorMdMode
}>()
const emit = defineEmits<{
  (e: 'change-mode', mode: EditorMdMode): void
  /** 打印按钮（P-20261003-244）：逻辑在预览面板组件，宿主转调其 printPreview */
  (e: 'print'): void
}>()
const { t } = useI18n()
</script>

<template>
  <div
    v-if="isMarkdown"
    class="md-mode-bar"
    :title="t('editor.mdModeTip')"
  >
    <button
      class="md-mode-btn"
      :class="{ active: mdMode === 'source' }"
      @click="emit('change-mode', 'source')"
    >
      {{ t('editor.source') }}
    </button>
    <button
      class="md-mode-btn"
      :class="{ active: mdMode === 'preview' }"
      @click="emit('change-mode', 'preview')"
    >
      {{ t('editor.preview') }}
    </button>
    <button
      class="md-mode-btn"
      :class="{ active: mdMode === 'split' }"
      @click="emit('change-mode', 'split')"
    >
      {{ t('editor.sourcePreview') }}
    </button>
    <!-- 打印 / 导出 PDF（P-20261003-244）：预览可见（preview/split 态）才可用，
         源码态无渲染内容可印；右对齐与模式钮区分 -->
    <button
      v-if="mdMode !== 'source'"
      class="md-mode-btn md-print-btn"
      data-testid="md-print-btn"
      :title="t('editor.mdPrint')"
      :aria-label="t('editor.mdPrint')"
      @click="emit('print')"
    >
      <svg
        class="md-print-icon"
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <!-- 打印机：出纸托盘 + 机身 + 进纸（独立绘制的基础三件形） -->
        <path d="M6 9V3h12v6" />
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
        <rect
          x="6"
          y="14"
          width="12"
          height="7"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* Markdown 模式切换栏 */
.md-mode-bar {
  height: 30px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-default);
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 0 8px;
  flex-shrink: 0;
}
.md-mode-btn {
  height: 24px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 0.85em;
  border-radius: 3px;
  transition: all var(--motion-fast);
}
.md-mode-btn:hover { background: var(--border-default); color: var(--text-hover); }
.md-mode-btn.active { background: var(--border-default); color: var(--text-primary); font-weight: 500; }
/* 打印 / 导出 PDF 按钮（P-20261003-244）：右对齐与模式钮区分，图标继承文字色 */
.md-print-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
