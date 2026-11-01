<script setup lang="ts">
import { computed, ref, watch } from 'vue'
// 应用未全局注册 naive-ui：模板里用到的组件必须显式 import（历史回归教训）
import { NButton, NForm, NFormItem, NInput, NModal, NSelect, NSpin } from 'naive-ui'
import { GitCompareOutline, RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { terminalApi } from '../../api/client'
import {
  defaultRuntimesPair, openCompareExperiment, useCompareExperiment,
} from '../../composables/useCompareExperiment'
import type { CompareExperiment } from '../../api/domains/compare'
import CompareExperimentDetail from './CompareExperimentDetail.vue'

/**
 * 对比实验面板（P-20261003-46）：双 agent 同题竞写的发起与对比视图。
 * 可见性是模块级单例（useCompareExperiment），本组件全局唯一挂载（Layout.vue），
 * 命令面板 / agent 管理页头部入口零 props 直开。
 * 左列 = 发起表单 + 实验列表；右列 = 选中实验详情（CompareExperimentDetail）。
 */
const { t } = useI18n()
const {
  show, selectedId,
  experiments, detail, detailLoading, launching,
  refreshList, loadDetail, select, launch, adopt, applyAdoption, removeExperiment, fetchClaudeUsage,
} = useCompareExperiment()

const showRef = computed({
  get: () => show.value,
  set: (v: boolean) => { show.value = v },
})

// ── 发起表单 ──
const prompt = ref('')
const dir = ref('')
const runtimeA = ref('auto')
const runtimeB = ref('auto')
const formExpanded = ref(true)

interface RuntimeItem {
  name: string
  /** 自定义智能体的展示名（内置运行时为空，展示回落 name） */
  displayName?: string
  available: boolean
}

const runtimes = ref<RuntimeItem[]>([])
const runtimeOptions = computed(() => [
  { label: t('agentTerminal.runtimeAuto'), value: 'auto' },
  ...runtimes.value
    // shell 是纯终端无智能体可竞写，不进选项（CrossReviewDialog 同口径）
    .filter(r => r.name !== 'shell' && r.name !== 'auto')
    .map(r => ({
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
    // 首次打开按可用性预填一对互异运行时（auto 仍可选）
    if (runtimeA.value === 'auto' && runtimeB.value === 'auto') {
      const pair = defaultRuntimesPair(runtimes.value)
      runtimeA.value = pair.a
      runtimeB.value = pair.b
    }
  } catch {
    runtimes.value = [] // 清单拉取失败仍可用 auto 发起（服务端按可用性选型）
  }
}

// 选 A 与 B 撞值时把 B 挪到下一个可用项（便利引导而非规则：同 runtime
// 两版挑好是合法形态，用户仍可手动把 B 选回同值）
function onRuntimeAChange(v: string) {
  runtimeA.value = v
  if (runtimeB.value === v) {
    const alt = runtimeOptions.value.find(o => o.value !== v)
    if (alt) runtimeB.value = alt.value
  }
}

async function submit() {
  const ok = await launch({
    prompt: prompt.value,
    dir: dir.value.trim() || undefined,
    runtimeA: runtimeA.value,
    runtimeB: runtimeB.value,
  })
  if (ok) {
    prompt.value = ''
    formExpanded.value = false
  }
}

// ── 实验列表 ──
const statusDot = (e: CompareExperiment) => (e.status === 'ready' ? 'ready' : 'running')
const promptSummary = (e: CompareExperiment) => {
  const first = (e.prompt || '').split('\n')[0] || ''
  return first.length > 40 ? `${first.slice(0, 40)}…` : first
}
const pairLabel = (e: CompareExperiment) =>
  `${e.a.runtime || 'auto'} × ${e.b.runtime || 'auto'}`

function onExperimentClick(e: CompareExperiment) {
  if (e.id === selectedId.value) return
  select(e.id)
}

async function onDelete(e: CompareExperiment) {
  await removeExperiment(e.id)
}

// ── token 用量对账：仅在实验 id / 底层会话 id 变化时拉一次索引列表并按
// agentSessionId 匹配——详情轮询每 5s 换新对象，按对象 watch 会把 stat 级
// 列表拉取放大成常驻流量（回执捕获 agentSessionId 是唯一值得重取的变化点） ──
const usage = ref(new Map<string, number>())
const usageKey = computed(() => {
  const exp = detail.value?.experiment
  if (!exp) return ''
  return `${exp.id}|${exp.a.agentSessionId || ''}|${exp.b.agentSessionId || ''}`
})
watch(usageKey, async (key) => {
  usage.value = new Map()
  const exp = detail.value?.experiment
  if (!key || !exp) return
  const ids = [exp.a, exp.b]
    .filter(s => s.runtime === 'claude' && s.agentSessionId)
    .map(s => s.agentSessionId!) as string[]
  if (ids.length > 0) usage.value = await fetchClaudeUsage(ids)
})

// 打开即对账列表 + 运行时清单（选中详情由 refreshList→select 链或既有值承担）
watch(show, (v) => {
  if (!v) return
  void refreshList().then(() => {
    if (selectedId.value) void loadDetail(selectedId.value)
  })
  void loadRuntimes()
})
</script>

<template>
  <n-modal
    v-model:show="showRef"
    preset="card"
    :title="t('experiment.title')"
    style="width: var(--modal-w-xl); max-width: 94vw"
    :content-style="{ display: 'flex', flexDirection: 'column', gap: '12px', minHeight: '480px', height: '70vh' }"
    :mask-closable="true"
    data-testid="compare-experiment-panel"
  >
    <div class="cep-root">
      <!-- 左列：发起表单 + 实验列表 -->
      <div class="cep-left">
        <div class="cep-form">
          <div
            class="cep-form-head"
            role="button"
            @click="formExpanded = !formExpanded"
          >
            <n-icon size="14"><GitCompareOutline /></n-icon>
            <span>{{ t('experiment.newTitle') }}</span>
          </div>
          <n-form
            v-if="formExpanded"
            size="small"
            label-placement="top"
            class="cep-form-body"
          >
            <n-form-item :label="t('experiment.fieldPrompt')">
              <n-input
                v-model:value="prompt"
                type="textarea"
                :rows="3"
                :maxlength="500"
                show-count
                data-testid="compare-prompt"
                :placeholder="t('experiment.fieldPromptPlaceholder')"
              />
            </n-form-item>
            <n-form-item :label="t('experiment.fieldDir')">
              <n-input
                v-model:value="dir"
                :placeholder="t('experiment.fieldDirPlaceholder')"
                clearable
              />
            </n-form-item>
            <div class="cep-runtime-row">
              <n-form-item :label="t('experiment.fieldRuntimeA')">
                <n-select
                  :value="runtimeA"
                  :options="runtimeOptions"
                  data-testid="compare-runtime-a"
                  @update:value="onRuntimeAChange"
                />
              </n-form-item>
              <n-form-item :label="t('experiment.fieldRuntimeB')">
                <n-select
                  v-model:value="runtimeB"
                  :options="runtimeOptions"
                  data-testid="compare-runtime-b"
                />
              </n-form-item>
            </div>
            <n-button
              type="primary"
              block
              :loading="launching"
              data-testid="compare-launch"
              @click="submit"
            >
              {{ t('experiment.launch') }}
            </n-button>
          </n-form>
        </div>

        <div class="cep-list">
          <div class="cep-list-head">
            <span>{{ t('experiment.listTitle') }}</span>
            <n-button
              size="tiny"
              quaternary
              :title="t('common.refresh')"
              data-testid="compare-refresh"
              @click="() => { void refreshList(); if (selectedId) void loadDetail(selectedId) }"
            >
              <template #icon>
                <n-icon><RefreshOutline /></n-icon>
              </template>
            </n-button>
          </div>
          <div
            v-if="experiments.length === 0"
            class="cep-empty"
          >
            {{ t('experiment.listEmpty') }}
          </div>
          <div
            v-for="e in experiments"
            :key="e.id"
            class="cep-item"
            :class="{ active: e.id === selectedId }"
            data-testid="compare-experiment-item"
            @click="onExperimentClick(e)"
          >
            <span
              class="cep-dot"
              :class="statusDot(e)"
              :title="t(e.status === 'ready' ? 'experiment.statusReady' : 'experiment.statusRunning')"
            />
            <div class="cep-item-main">
              <div
                class="cep-item-prompt"
                :title="e.prompt"
              >{{ promptSummary(e) }}</div>
              <div class="cep-item-sub">
                <span>{{ pairLabel(e) }}</span>
                <span
                  v-if="e.adopted"
                  class="cep-adopted"
                >{{ t('experiment.adoptedBadge', { side: e.adopted.toUpperCase() }) }}</span>
              </div>
            </div>
            <n-button
              size="tiny"
              quaternary
              class="cep-item-del"
              :title="t('common.delete')"
              @click.stop="() => { void onDelete(e) }"
            >
              {{ t('common.delete') }}
            </n-button>
          </div>
        </div>
      </div>

      <!-- 右列：详情 -->
      <div class="cep-right">
        <div
          v-if="detailLoading && !detail"
          class="cep-center"
        >
          <n-spin size="small" />
        </div>
        <div
          v-else-if="!detail"
          class="cep-center"
        >
          {{ t('experiment.pickExperiment') }}
        </div>
        <CompareExperimentDetail
          v-else
          :detail="detail"
          :usage="usage"
          @adopt="(side) => { void adopt(detail!.experiment.id, side) }"
          @apply="(side) => { void applyAdoption(detail!.experiment.id, side) }"
        />
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.cep-root { display: flex; gap: 12px; flex: 1; min-height: 0; }
.cep-left {
  width: 320px; flex-shrink: 0; display: flex; flex-direction: column;
  gap: 10px; min-height: 0;
}
.cep-form { border: 1px solid var(--border-default); border-radius: 6px; padding: 8px 10px; flex-shrink: 0; }
.cep-form-head {
  display: flex; align-items: center; gap: 6px; font-size: 0.82em; font-weight: 600;
  color: var(--text-primary); cursor: pointer; user-select: none;
}
.cep-form-body { margin-top: 8px; }
.cep-runtime-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.cep-list {
  flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border-default);
  border-radius: 6px; display: flex; flex-direction: column;
}
.cep-list-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 6px 10px; font-size: 0.78em; color: var(--text-muted);
  border-bottom: 1px solid var(--border-default); position: sticky; top: 0; background: var(--bg-panel);
}
.cep-empty { padding: 16px 10px; font-size: 0.8em; color: var(--text-muted); text-align: center; }
.cep-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer;
  border-bottom: 1px solid var(--border-default); min-width: 0;
}
.cep-item:hover { background: var(--bg-hover); }
.cep-item.active { background: var(--bg-active, var(--bg-hover)); }
.cep-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; background: var(--text-tertiary); }
/* 状态点走语义色四档（P-20261003-285）：ready=就绪待跑归等待档（原绿与成功
   终态撞色）、running=进行中蓝档（原黄——running 同义异色主嫌之一） */
.cep-dot.ready { background: var(--status-waiting); }
.cep-dot.running { background: var(--status-running); }
.cep-item-main { flex: 1; min-width: 0; }
.cep-item-prompt { font-size: 0.8em; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cep-item-sub {
  display: flex; align-items: center; gap: 6px;
  font-size: 0.72em; color: var(--text-muted);
}
.cep-adopted { color: var(--accent-green); }
.cep-item-del { flex-shrink: 0; opacity: 0; }
.cep-item:hover .cep-item-del { opacity: 1; }
.cep-right {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  border: 1px solid var(--border-default); border-radius: 6px; padding: 10px; min-height: 0;
}
.cep-center {
  flex: 1; display: flex; align-items: center; justify-content: center;
  font-size: 0.85em; color: var(--text-muted);
}
</style>
