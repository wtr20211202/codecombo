<script setup lang="ts">
// 笔记预览面（P-20261107-5 自 NotesPanel 拆出的呈现子组件）：markdown →
// 消毒 HTML 渲染。marked+DOMPurify 管线与 changelog/帮助中心同源——笔记是
// agent 也可写的内容，消毒不可省。纯呈现件：内容经 props 注入，无数据面。
import { computed } from 'vue'
import { marked } from 'marked'
import DOMPurify from 'dompurify'

const props = defineProps<{ content: string }>()

const html = computed(() => {
  const parsed = marked.parse(props.content || '', { async: false }) as string
  return DOMPurify.sanitize(parsed)
})
</script>

<template>
  <!-- eslint-disable vue/no-v-html —— marked+DOMPurify 消毒后渲染（agent 亦可写，消毒不可省） -->
  <div
    class="np-preview"
    data-testid="notes-preview"
    v-html="html"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>

<style scoped>
.np-preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}
.np-preview :deep(h1),
.np-preview :deep(h2),
.np-preview :deep(h3) {
  font-size: 13px;
  margin: 8px 0 4px;
}
.np-preview :deep(p) {
  margin: 4px 0;
}
.np-preview :deep(ul),
.np-preview :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}
.np-preview :deep(code) {
  background: var(--bg-hover);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}
.np-preview :deep(pre) {
  background: var(--bg-hover);
  padding: 8px;
  border-radius: 4px;
  overflow: auto;
}
.np-preview :deep(a) {
  color: var(--accent-blue);
}
</style>
