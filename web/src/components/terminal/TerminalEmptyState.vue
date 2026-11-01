<script setup lang="ts">
import { NButton } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

/** 终端空态（无终端 tab）：ASCII 装饰 + 新建按钮 + 快捷键提示（自 TerminalView 抽出） */
defineProps<{ showSplitHint?: boolean }>()

const emit = defineEmits<{ (e: 'create'): void }>()
const { t } = useI18n()
</script>

<template>
  <div class="term-empty-state">
    <div class="term-empty-ascii">
      <div class="term-empty-line">
        ┌──────────────────────────┐
      </div>
      <div class="term-empty-line">
        │&nbsp;&nbsp;<span class="term-empty-cmd">$</span> codecombo <span class="term-empty-cursor" />&nbsp;&nbsp;│
      </div>
      <div class="term-empty-line">
        └──────────────────────────┘
      </div>
    </div>
    <div class="term-empty-title">
      {{ t('terminal.noTerminal') }}
    </div>
    <n-button
      size="small"
      type="primary"
      @click="emit('create')"
    >
      {{ t('terminal.newTerminal') }}
    </n-button>
    <div class="term-empty-hints">
      <div class="term-empty-hint">
        <kbd class="term-kbd">{{ t('terminal.shortcutNew') }}</kbd>
        <span>{{ t('terminal.newTerminal') }}</span>
      </div>
      <div
        v-if="showSplitHint !== false"
        class="term-empty-hint"
      >
        <kbd class="term-kbd">Ctrl+Shift+D</kbd>
        <span>{{ t('terminal.splitHorizontal') }}</span>
      </div>
      <div class="term-empty-hint">
        <kbd class="term-kbd">Alt+1…9</kbd>
        <span>{{ t('terminal.switchTab') }}</span>
      </div>
      <div class="term-empty-hint">
        <kbd class="term-kbd">{{ t('terminal.shortcutRename') }}</kbd>
        <span>{{ t('terminal.renameHint') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.term-empty-state {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
}
.term-empty-ascii {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  line-height: 1.3;
  color: var(--text-dim);
  user-select: none;
}
.term-empty-line { display: block; }
.term-empty-cmd { color: var(--accent-green); font-weight: 600; }
.term-empty-cursor {
  display: inline-block;
  width: 7px;
  height: 12px;
  background: var(--accent-green);
  vertical-align: text-bottom;
  animation: term-empty-cursor-blink 1s steps(2) infinite;
}
@keyframes term-empty-cursor-blink { 50% { opacity: 0; } }
.term-empty-title {
  font-size: 13px;
  color: var(--text-secondary);
}
.term-empty-hints {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: center;
}
.term-empty-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-dim);
}
.term-kbd {
  font-family: var(--font-mono, monospace);
  font-size: 10px;
  line-height: 1.4;
  color: var(--text-secondary);
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  border-radius: 3px;
  box-shadow: 0 1px 0 var(--border-default);
  padding: 1px 5px;
}
</style>
