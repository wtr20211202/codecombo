<script setup lang="ts">
// 编辑器光标位置徽标（P-20261004-141）：Breadcrumb extra 槽尾展示当前光标
// 「Ln N, Col N」（VS Code 状态栏同款位置感知——对照终端报错行号人工定位、
// agent open-file-at 落位确认、协作口述「第 N 行」互相对齐），选区非空追加
// 「(N selected)」。点击触发 Monaco 内建 editor.action.gotoLine（与 Ctrl+G 同
// 入口的 quick access，复用不重造）。位置是编辑器状态非文件属性：untitled
// 草稿/远程伪路径/离线只读同样适用（凡 Monaco 编辑器在场即有光标），可见性
// 由宿主控制（pos 传 null 即不渲染）：diff 伪文件/元信息卡/载入中无编辑器
// 形态不渲染。Ln/Col 为通用缩写惯例不加 i18n 键（VS Code 同款原文），仅
// selected 文案入键
import { useI18n } from '../../composables/useI18n'

const props = defineProps<{
  /** 当前光标状态（宿主从编辑器事件透传；null = 不可显示不渲染） */
  pos: { line: number; column: number; selected: number } | null
}>()

const emit = defineEmits<{
  (e: 'goto'): void
}>()

const { t } = useI18n()
</script>

<template>
  <button
    v-if="props.pos"
    class="cursor-pos-badge"
    data-testid="cursor-pos-badge"
    :title="t('editor.cursorPos.gotoTip')"
    @click="emit('goto')"
  >
    Ln {{ props.pos.line }}, Col {{ props.pos.column }}<span
      v-if="props.pos.selected > 0"
      class="cursor-pos-selected"
      data-testid="cursor-pos-selected"
    >({{ t('editor.cursorPos.selected', { n: props.pos.selected }) }})</span>
  </button>
</template>

<style scoped>
/* 徽标视觉与 EncodingBadge/EolBadge 同一套语言（scoped 隔离各自成套，随组件走） */
.cursor-pos-badge {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  height: 20px;
  padding: 0 7px;
  border-radius: 4px;
  font-size: 10px;
  font-family: var(--font-mono);
  line-height: 1;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  cursor: pointer;
  transition: all var(--motion-base);
  flex-shrink: 0;
  white-space: nowrap;
}
.cursor-pos-badge:hover {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}

.cursor-pos-selected {
  color: var(--text-muted);
}
.cursor-pos-badge:hover .cursor-pos-selected {
  color: inherit;
}
</style>
