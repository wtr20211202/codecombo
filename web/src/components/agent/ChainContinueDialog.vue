<script setup lang="ts">
/**
 * 「完成后接续…」弹层（P-20261004-38）：为源会话建一条接续链——源会话上报
 * task.progress 终态（done，onFailure 开档含 failed）时服务端自动拉起下一棒
 * agent 会话并注入 prompt 模板。源会话/开合状态在 useAgentChain 模块级单例
 * （入口：会话行右键），本组件全局唯一挂载（AgentTerminalView，同
 * CrossReviewDialog 范式）。
 * 模板占位符 {prevTask}/{prevStatus}/{prevStep} 服务端触发时替换，这里只透传；
 * 字节配额客户端先行校验（服务端 500 字节同口径），错误 toast 由 http 拦截器
 * 统一入账。
 */
import { computed, ref, watch } from 'vue'
// 应用未全局注册 naive-ui：模板里用到的组件必须显式 import（历史回归教训）
import { NButton, NCheckbox, NForm, NFormItem, NInput, NModal, NSelect } from 'naive-ui'
import { terminalApi } from '@/api/client'
import { useI18n } from '../../composables/useI18n'
import { useAgentChain } from '../../composables/useAgentChain'

interface RuntimeItem {
  name: string
  /** 自定义智能体的展示名（内置运行时为空，展示回落 name） */
  displayName?: string
  available: boolean
}

const { t } = useI18n()
const { chainSource, chainShow, creating, create } = useAgentChain()

const template = ref('')
const dir = ref('')
const runtime = ref('auto')
const onFailure = ref(false)

const showRef = computed(() => chainShow.value && !!chainSource.value)

/** 选项 = auto（服务端按可用性选型）+ shell（纯终端接力也是合法形态：
 * 源会话跑完命令，下一棒是个人看输出的终端）+ 已注册智能体运行时。
 * 探测不可用不禁用（NewSessionDialog 同理由：自定义启动命令可自救） */
const runtimes = ref<RuntimeItem[]>([])
const runtimeOptions = computed(() => [
  { label: t('agentTerminal.runtimeAuto'), value: 'auto' },
  { label: t('agentTerminal.runtimeShell'), value: 'shell' },
  ...runtimes.value.map(r => ({
    label: r.available
      ? runtimeLabel(r)
      : `${runtimeLabel(r)} (${t('agentTerminal.runtimeUnavailable')})`,
    value: r.name,
  })),
])

/** 运行时展示名：自定义智能体用 displayName，其余回落注册名（NewSessionDialog 同款） */
function runtimeLabel(r: RuntimeItem): string {
  return r.displayName || r.name
}

async function loadRuntimes() {
  try {
    const res = await terminalApi.listAgentRuntimes()
    runtimes.value = ((res.data || []) as RuntimeItem[])
      .filter(r => r.name !== 'shell' && r.name !== 'auto')
  } catch {
    runtimes.value = [] // 清单拉取失败仍可用 auto 发起（服务端按可用性选型）
  }
}

function close(): void {
  chainShow.value = false
  chainSource.value = null
}

async function onConfirm(): Promise<void> {
  const src = chainSource.value
  if (!src) return
  const ok = await create({
    sourceTerminalId: src.id,
    promptTemplate: template.value,
    runtime: runtime.value === 'auto' ? undefined : runtime.value,
    dir: dir.value.trim() || undefined,
    onFailure: onFailure.value,
  })
  if (ok) close()
}

watch(showRef, (v) => {
  if (!v) return
  template.value = ''
  dir.value = chainSource.value?.dir || ''
  runtime.value = 'auto'
  onFailure.value = false
  void loadRuntimes()
})
</script>

<template>
  <n-modal
    :show="showRef"
    preset="card"
    :title="t('agentchain.dialogTitle')"
    style="width: var(--modal-w-md); max-width: 94vw"
    :mask-closable="true"
    data-testid="agentchain-dialog"
    @update:show="close"
  >
    <n-form
      label-placement="top"
      size="small"
    >
      <n-form-item :label="t('agentchain.sourceLabel')">
        <span
          class="ac-source"
          :title="chainSource?.name"
        >{{ chainSource?.name }}<span
          v-if="chainSource?.runtime"
          class="ac-runtime"
        >{{ chainSource.runtime }}</span></span>
      </n-form-item>
      <n-form-item :label="t('agentchain.fieldTemplate')">
        <n-input
          v-model:value="template"
          type="textarea"
          :rows="4"
          :maxlength="500"
          show-count
          data-testid="agentchain-template"
          :placeholder="t('agentchain.fieldTemplatePlaceholder')"
        />
      </n-form-item>
      <div class="ac-hint">
        {{ t('agentchain.templateHint') }}
      </div>
      <div class="ac-row">
        <n-form-item
          :label="t('agentchain.fieldRuntime')"
          class="ac-runtime-item"
        >
          <n-select
            v-model:value="runtime"
            :options="runtimeOptions"
            data-testid="agentchain-runtime"
          />
        </n-form-item>
        <n-form-item
          :label="t('agentchain.fieldDir')"
          class="ac-dir-item"
        >
          <n-input
            v-model:value="dir"
            :placeholder="t('agentchain.fieldDirPlaceholder')"
            clearable
          />
        </n-form-item>
      </div>
      <n-checkbox
        v-model:checked="onFailure"
        data-testid="agentchain-on-failure"
      >
        {{ t('agentchain.fieldOnFailure') }}
      </n-checkbox>
      <div class="ac-hint">
        {{ t('agentchain.gateHint') }}
      </div>
    </n-form>
    <template #footer>
      <div class="ac-footer">
        <n-button
          size="small"
          quaternary
          @click="close"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          data-testid="agentchain-confirm"
          :loading="creating"
          @click="() => { void onConfirm() }"
        >
          {{ t('agentchain.confirm') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.ac-source {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.ac-runtime {
  flex-shrink: 0;
  font-size: 0.78em;
  padding: 0 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--accent-purple) 16%, transparent);
  color: var(--accent-purple);
}
.ac-hint {
  margin: 4px 0 10px;
  font-size: 0.8em;
  color: var(--text-muted);
  line-height: 1.5;
}
.ac-row {
  display: grid;
  grid-template-columns: 160px 1fr;
  gap: 10px;
}
.ac-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
