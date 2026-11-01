<template>
  <div
    class="crash-fallback"
    role="alert"
  >
    <div class="crash-card">
      <div
        class="crash-icon"
        aria-hidden="true"
      >
        !
      </div>
      <h1 class="crash-title">
        {{ title }}
      </h1>
      <p class="crash-hint">
        {{ hint }}
      </p>
      <pre
        v-if="summary"
        class="crash-summary"
      >{{ summary }}</pre>
      <div class="crash-actions">
        <button
          type="button"
          class="crash-btn crash-btn-primary"
          @click="emit('goHome')"
        >
          {{ goHomeLabel }}
        </button>
        <button
          type="button"
          class="crash-btn"
          @click="reload"
        >
          {{ reloadLabel }}
        </button>
        <button
          type="button"
          class="crash-btn"
          @click="copyDetail"
        >
          {{ copied ? copiedLabel : copyLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
// 渲染兜底降级页（P-20261002-26）：零依赖设计——不引组件库/store/i18n，
// 文案经 props 由 App.vue 传入，样式内联且主题 CSS 变量自带硬编码回退
// （变量缺失时仍是完整可读的暗色页面）；组件树大面积故障时也能独立渲染。
// 复制详情走 copyText 红线（非 secure context 自动降级 execCommand 已内置）
import { ref } from 'vue'
import { copyText } from '../../utils/clipboard'

const props = defineProps<{
  /** 页面标题 */
  title: string
  /** 说明文案（已切降级模式的提示） */
  hint: string
  /** 错误摘要（已截断，空则不展示） */
  summary: string
  /** 复制详情负载（完整报告） */
  detail: string
  copyLabel: string
  copiedLabel: string
  reloadLabel: string
  goHomeLabel: string
}>()

const emit = defineEmits<{ goHome: [] }>()

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | undefined

async function copyDetail(): Promise<void> {
  const ok = await copyText(props.detail)
  if (!ok) return
  copied.value = true
  clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 2000)
}

function reload(): void {
  window.location.reload()
}
</script>

<style scoped>
.crash-fallback {
  position: fixed;
  inset: 0;
  /* 压过锁屏（10000）与 boot loading（10001）：降级页是最终兜底面 */
  z-index: 10002;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background-color: var(--bg-primary, #0d1117);
  color: var(--text-primary, #e6edf3);
  box-sizing: border-box;
}

.crash-card {
  width: 100%;
  max-width: 520px;
  padding: 32px;
  border: 1px solid var(--border-subtle, #30363d);
  border-radius: 12px;
  background-color: var(--bg-panel, #161b22);
  text-align: center;
}

.crash-icon {
  width: 44px;
  height: 44px;
  margin: 0 auto 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 2px solid var(--accent-red, #f44747);
  color: var(--accent-red, #f44747);
  font-size: 24px;
  font-weight: 600;
  line-height: 1;
}

.crash-title {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary, #e6edf3);
}

.crash-hint {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-secondary, #8b949e);
}

.crash-summary {
  margin: 0 0 20px;
  padding: 10px 12px;
  max-height: 120px;
  overflow: auto;
  text-align: left;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-secondary, #8b949e);
  background-color: var(--bg-primary, #0d1117);
  border: 1px solid var(--border-subtle, #30363d);
  border-radius: 8px;
}

.crash-actions {
  display: flex;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}

.crash-btn {
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid var(--border-subtle, #30363d);
  background: transparent;
  color: var(--text-primary, #e6edf3);
  font-size: 13px;
  cursor: pointer;
}

.crash-btn:hover {
  border-color: var(--accent-blue, #58a6ff);
  color: var(--accent-blue, #58a6ff);
}

.crash-btn:focus-visible {
  outline: 2px solid var(--accent-blue, #58a6ff);
  outline-offset: 2px;
}

.crash-btn-primary {
  background-color: var(--accent-blue, #58a6ff);
  border-color: transparent;
  color: #fff;
}

.crash-btn-primary:hover {
  background-color: var(--accent-blue-hover, #79c0ff);
  color: #fff;
}
</style>
