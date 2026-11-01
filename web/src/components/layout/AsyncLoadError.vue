<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useI18n } from '@/composables/useI18n'

defineEmits<{ (e: 'retry'): void }>()
const { t } = useI18n()
</script>

<template>
  <div class="async-load-error">
    <span class="async-load-error-text">{{ t('common.asyncLoadFailed') }}</span>
    <NButton
      size="tiny"
      @click="$emit('retry')"
    >
      {{ t('common.retry') }}
    </NButton>
  </div>
</template>

<style scoped>
.async-load-error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 100%;
  min-height: 80px;
  padding: 16px;
  font-size: 13px;
  color: var(--accent-red, #f44747);
}

.async-load-error-text {
  opacity: 0.9;
}
</style>
