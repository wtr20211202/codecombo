<script setup lang="ts">
// 统一的图标按钮：支持 size、active 状态、tooltip、loading
import { NSpin } from 'naive-ui'

const props = withDefaults(defineProps<{
  title?: string
  active?: boolean
  disabled?: boolean
  loading?: boolean
  size?: 'tiny' | 'small' | 'default'
  variant?: 'default' | 'ghost' | 'primary'
}>(), {
  size: 'default',
  variant: 'default',
})

defineEmits<{
  (e: 'click', ev: MouseEvent): void
}>()
</script>

<template>
  <button
    class="tool-btn"
    :class="[`size-${props.size}`, `variant-${props.variant}`, { active: props.active }]"
    :title="props.title"
    :disabled="props.disabled || props.loading"
    @click="(ev) => !props.disabled && !props.loading && $emit('click', ev)"
  >
    <n-spin
      v-if="props.loading"
      :size="14"
    />
    <slot v-else />
  </button>
</template>

<style scoped>
.tool-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 6px;
  font-family: var(--font-ui);
  transition: all var(--motion-base);
  user-select: none;
  /* 最小热区（P-20261019-5）：图标视觉尺寸由 size-* 档决定不变，命中区统一
     不低于全局底线（fine 28 / coarse 40），tiny 档 24px 由此补足 */
  min-width: var(--hit-target-min, 28px);
  min-height: var(--hit-target-min, 28px);
}

.tool-btn:hover:not(:disabled) {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.tool-btn:active:not(:disabled) {
  transform: scale(0.94);
  transition-duration: var(--motion-fast);
}

.tool-btn:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 1px;
}

.tool-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 尺寸 */
.size-tiny { width: 24px; height: 24px; font-size: 12px; }
.size-small { width: 28px; height: 28px; font-size: 13px; }
.size-default { width: 32px; height: 32px; font-size: 14px; }

/* 变体 */
.variant-ghost {
  background: transparent;
}
.variant-ghost:hover:not(:disabled) {
  background: var(--bg-hover);
}

.variant-primary {
  background: var(--brand-accent);
  color: var(--bg-primary);
}
.variant-primary:hover:not(:disabled) {
  background: var(--brand-accent-hover);
  color: var(--bg-primary);
}

/* 激活状态 */
.tool-btn.active {
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}
.tool-btn.active:hover:not(:disabled) {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
}
</style>
