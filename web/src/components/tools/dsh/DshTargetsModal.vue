<script setup lang="ts">
import { NButton, NInput, NModal } from 'naive-ui'
import { ref } from 'vue'
import { useI18n } from '../../../composables/useI18n'
import { confirmDialog } from '../../../composables/useDialog'
import { settingsApi } from '../../../api/client'
import type { DshTarget } from './types'

/**
 * 外部 dsh 目标管理弹层（P-20261001-20 从 DshConsoleView 拆出）：
 * 列表 + 添加/编辑/删除表单。目标列表本体由宿主持有（工具栏下拉同源），
 * 增删改完成后经 changed 通知宿主重载；删除的是当前激活目标时经
 * active-removed 通知宿主回落本机目标并重新探测。
 */
const props = defineProps<{
  show: boolean
  targets: DshTarget[]
  activeTargetId: string
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  /** 目标列表发生变化：宿主重载 targets */
  (e: 'changed'): void
  /** 被删除的是当前激活目标：宿主回落本机目标并重新探测 */
  (e: 'active-removed'): void
}>()

const { t } = useI18n()

const targetSaving = ref(false)
const targetForm = ref<{ id: string; name: string; base: string; token: string }>({
  id: '', name: '', base: '', token: '',
})

function editTarget(tg: DshTarget) {
  targetForm.value = { id: tg.id, name: tg.name, base: tg.base, token: tg.token || '' }
}

async function saveTarget() {
  if (targetSaving.value) return
  targetSaving.value = true
  try {
    const payload = {
      name: targetForm.value.name,
      base: targetForm.value.base,
      token: targetForm.value.token,
    }
    if (targetForm.value.id) {
      await settingsApi.dshTargetUpdate(targetForm.value.id, payload)
    } else {
      await settingsApi.dshTargetCreate(payload)
    }
    emit('changed')
    targetForm.value = { id: '', name: '', base: '', token: '' }
  } catch { /* 拦截器统一处理 */ } finally {
    targetSaving.value = false
  }
}

async function removeTarget(tg: DshTarget) {
  const ok = await confirmDialog({
    title: t('dshConsole.targetDeleteTitle'),
    content: t('dshConsole.targetDeleteConfirm', { name: tg.name }),
  })
  if (!ok) return
  try {
    await settingsApi.dshTargetDelete(tg.id)
    emit('changed')
    if (props.activeTargetId === tg.id) {
      emit('active-removed') // 回落本机目标（后端未知 ID 同语义）
    }
    if (targetForm.value.id === tg.id) {
      targetForm.value = { id: '', name: '', base: '', token: '' } // 正在编辑的被删：清空表单
    }
  } catch { /* 拦截器统一处理 */ }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="t('dshConsole.targetsTitle')"
    style="width: var(--modal-w-md); max-width: 94vw"
    @update:show="emit('update:show', $event)"
  >
    <div class="tgt-list">
      <div
        v-for="tg in targets"
        :key="tg.id"
        class="tgt-item"
      >
        <span class="tgt-name">{{ tg.name }}</span>
        <span class="tgt-base">{{ tg.base }}</span>
        <span class="tgt-actions">
          <n-button
            size="tiny"
            quaternary
            @click="editTarget(tg)"
          >
            {{ t('common.edit') }}
          </n-button>
          <n-button
            size="tiny"
            quaternary
            type="error"
            @click="removeTarget(tg)"
          >
            {{ t('common.delete') }}
          </n-button>
        </span>
      </div>
      <div
        v-if="targets.length === 0"
        class="tgt-empty"
      >
        {{ t('dshConsole.targetsEmpty') }}
      </div>
    </div>
    <div class="tgt-form">
      <div class="tgt-form-title">
        {{ targetForm.id ? t('dshConsole.editTarget') : t('dshConsole.addTarget') }}
      </div>
      <div class="tgt-form-row">
        <n-input
          v-model:value="targetForm.name"
          size="small"
          :placeholder="t('dshConsole.targetName')"
          style="width: 150px"
        />
        <n-input
          v-model:value="targetForm.base"
          size="small"
          placeholder="http://192.168.1.10:3080"
          style="flex: 1"
        />
        <n-input
          v-model:value="targetForm.token"
          size="small"
          type="password"
          :placeholder="t('dshConsole.targetToken')"
          style="width: 130px"
        />
        <n-button
          size="small"
          type="primary"
          :loading="targetSaving"
          :disabled="!targetForm.name || !targetForm.base"
          @click="saveTarget"
        >
          {{ targetForm.id ? t('common.save') : t('dshConsole.addTarget') }}
        </n-button>
      </div>
      <div class="tgt-form-hint">
        {{ t('dshConsole.targetFormHint') }}
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
/* 目标管理面板 */
.tgt-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.tgt-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid var(--bg-border);
  border-radius: 6px;
}
.tgt-name { font-size: 12px; color: var(--text-primary); flex-shrink: 0; }
.tgt-base { font-size: 11px; color: var(--text-dim); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tgt-actions { display: flex; gap: 2px; flex-shrink: 0; }
.tgt-empty { padding: 12px 0; font-size: 12px; color: var(--text-dim); text-align: center; }
.tgt-form { border-top: 1px solid var(--bg-border); padding-top: 10px; }
.tgt-form-title { font-size: 12px; color: var(--text-secondary); margin-bottom: 8px; }
.tgt-form-row { display: flex; gap: 6px; align-items: center; }
.tgt-form-hint { font-size: 11px; color: var(--text-dim); margin-top: 6px; }
</style>
