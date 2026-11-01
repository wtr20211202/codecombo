<script setup lang="ts">
import { NCheckbox, NModal } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'

/** 关闭终端二次确认：tmux 模式强调释放底层 session（自 TerminalView 抽出的纯 UI）。
 *  pendingApproval（P-20261003-275）：目标会话有等待裁决的审批时附加警示——
 *  关闭即裁决永不到来（agent 白等至 TTL 兜底），归属判定在宿主视图层 */
defineProps<{
  show: boolean
  effectiveBackend: 'tmux' | 'native'
  closeNoPrompt: boolean
  pendingApproval?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:closeNoPrompt', v: boolean): void
  (e: 'confirm'): void
  (e: 'cancel'): void
}>()

const { t } = useI18n()
</script>

<template>
  <n-modal
    :show="show"
    preset="dialog"
    :title="t('terminal.closeConfirmTitle')"
    type="warning"
    :mask-closable="false"
    :positive-text="t('common.confirm')"
    :negative-text="t('common.cancel')"
    @positive-click="emit('confirm')"
    @negative-click="emit('cancel')"
    @close="emit('cancel')"
  >
    <div style="color: var(--text-body); font-size: 13px; line-height: 1.6">
      <p
        v-if="effectiveBackend === 'tmux'"
        style="margin: 0 0 10px"
      >
        {{ t('terminal.closeConfirmTmux') }}
      </p>
      <p
        v-else
        style="margin: 0 0 10px"
      >
        {{ t('terminal.closeConfirmNative') }}
      </p>
      <p
        v-if="pendingApproval"
        style="margin: 0 0 10px; color: var(--accent-orange); font-weight: 600"
      >
        {{ t('terminal.closeConfirmPendingApproval') }}
      </p>
      <n-checkbox
        :checked="closeNoPrompt"
        @update:checked="(v: boolean) => emit('update:closeNoPrompt', v)"
      >
        {{ t('terminal.closeConfirmNoPrompt') }}
      </n-checkbox>
    </div>
  </n-modal>
</template>
