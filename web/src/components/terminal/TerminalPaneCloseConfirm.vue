<script setup lang="ts">
import { NButton, NModal } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

/**
 * split 取消拆分的运行中进程保全弹层（P-20261004-145）：secondary pane 有命令
 * 在跑时两选——「关闭（终止命令）」沿用原取消拆分语义 / 「转为独立 tab 保留」
 * 把拆分变并列。刻意不提供「不再提示」（与单 pane 关闭确认独立）：误拆
 * watcher 的代价（进程冷启动 + 滚回上下文）不对称，不给一键永久放行
 */
defineProps<{
  show: boolean
  paneName: string
  command: string
}>()

const emit = defineEmits<{
  (e: 'kill'): void
  (e: 'keep'): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()
</script>

<template>
  <n-modal
    :show="show"
    preset="dialog"
    :title="t('terminal.paneCloseTitle')"
    type="warning"
    :mask-closable="false"
    @close="emit('cancel')"
    @update:show="(v: boolean) => { if (!v) emit('cancel') }"
  >
    <div style="color: var(--text-body); font-size: 13px; line-height: 1.6">
      <p style="margin: 0">
        {{ t('terminal.paneCloseBody', { name: paneName, command }) }}
      </p>
    </div>
    <template #action>
      <div style="display: flex; gap: 8px; justify-content: flex-end">
        <n-button @click="emit('keep')">
          {{ t('terminal.paneCloseKeep') }}
        </n-button>
        <n-button type="warning" @click="emit('kill')">
          {{ t('terminal.paneCloseKill', { command }) }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>
