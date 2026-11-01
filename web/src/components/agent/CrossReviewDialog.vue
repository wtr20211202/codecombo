<script setup lang="ts">
/**
 * 交叉审查目标弹层（P-20261003-6）：展示源会话 + 单选目标 runtime，确认后经
 * useCrossReview.launch 发起。源会话/开合状态在 useCrossReview 模块级单例
 * （入口：会话行右键 / 产出面板操作区），本组件只做选项加载与模板——由
 * AgentTerminalView 挂一份实例（两入口共享，不随入口重复挂载）。
 * 目标默认值 = 非源 runtime 的设置默认值（defaultCrossReviewTarget：首个可用
 * 且 ≠ 源 runtime，无则 auto 交服务端选型）。
 */
import { computed, ref, watch } from 'vue'
// 应用未全局注册 naive-ui：模板里用到的组件必须显式 import（历史回归教训）
import { NButton, NForm, NFormItem, NModal, NSelect } from 'naive-ui'
import { terminalApi } from '@/api/client'
import { useI18n } from '../../composables/useI18n'
import { defaultCrossReviewTarget, useCrossReview } from '../../composables/useCrossReview'

interface RuntimeItem {
  name: string
  /** 自定义智能体的展示名（内置运行时为空，展示回落 name） */
  displayName?: string
  available: boolean
}

const { t } = useI18n()
const { show, source, launching, close, launch } = useCrossReview()

const runtimes = ref<RuntimeItem[]>([])
const target = ref('auto')

/** 选项 = auto（服务端按可用性选型）+ 已注册智能体运行时。纯终端（shell）
 *  不参与——无智能体可承担审查；探测不可用不禁用（与 NewSessionDialog 同
 *  理由：自定义启动命令可自救，禁用会把自救路径堵死），仅文案提示 */
const runtimeOptions = computed(() => [
  { label: t('agentTerminal.runtimeAuto'), value: 'auto' },
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
      // shell 是纯终端一等选项但无审查能力；auto 不在清单（独立置顶项）
      .filter(r => r.name !== 'shell' && r.name !== 'auto')
  } catch {
    runtimes.value = [] // 清单拉取失败仍可用 auto 发起（服务端按可用性选型）
  }
  // 默认目标：非源 runtime 的设置默认值（首个可用且 ≠ 源 runtime，无则 auto）
  target.value = defaultCrossReviewTarget(runtimes.value, source.value?.runtime || '')
}

watch(show, (v) => {
  if (!v) return
  target.value = 'auto'
  void loadRuntimes()
})

function onConfirm() {
  void launch(target.value)
}
</script>

<template>
  <n-modal
    :show="show && !!source"
    preset="card"
    :title="t('review.cross.title')"
    style="width: var(--modal-w-sm); max-width: 94vw"
    :mask-closable="true"
    @update:show="close"
  >
    <n-form
      label-placement="left"
      label-width="auto"
      size="small"
    >
      <n-form-item :label="t('review.cross.sourceLabel')">
        <span
          class="crd-source"
          :title="source?.name"
        >{{ source?.name }}<span
          v-if="source?.runtime"
          class="crd-runtime"
        >{{ source.runtime }}</span></span>
      </n-form-item>
      <n-form-item :label="t('review.cross.runtimeLabel')">
        <n-select
          v-model:value="target"
          :options="runtimeOptions"
        />
      </n-form-item>
    </n-form>
    <div class="crd-hint">
      {{ t('review.cross.runtimeHint') }}
    </div>
    <template #footer>
      <div class="crd-footer">
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
          data-testid="cross-review-confirm"
          :loading="launching"
          @click="onConfirm"
        >
          {{ t('common.confirm') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.crd-source {
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
.crd-runtime {
  flex-shrink: 0;
  font-size: 0.78em;
  padding: 0 4px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--accent-purple) 16%, transparent);
  color: var(--accent-purple);
}
.crd-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.crd-hint {
  margin-top: -6px;
  padding: 0 2px;
  font-size: 0.82em;
  color: var(--text-muted);
}
</style>
