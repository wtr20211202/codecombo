<script setup lang="ts">
/**
 * 舰队批量发起对话框（P-20261003-291，命令面板「批量 agent 任务」入口）：
 * 多选项目 + 选运行时 + 一段任务指令，一次给每个项目根目录起一个 agent
 * 会话（「给全部项目跑依赖审计/修 lint」类批量作业的编队入口）。
 *   - 服务端顺序创建（cap 20），runtime 预检失败/项目缺失逐条回告跳过不中断
 *   - prompt 超 500 字节服务端保尾截断（LAUNCH_ARGS_MAX_BYTES 口径，输入侧
 *     只提示不硬拦——截断保的是尾部指令，发起仍是用户意图）
 *   - 发起成功激活首个会话（dock 管理页），其余会话经 terminals.changed
 *     广播进悬浮窗/值班大屏自然聚合，本组件不逐个接管
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
// 应用未全局注册 naive-ui：模板里用到的组件必须显式 import（历史回归教训）
import { NButton, NForm, NFormItem, NInput, NModal, NSelect } from 'naive-ui'
import { terminalApi } from '@/api/client'
import type { FleetBulkAgentResult } from '@/api/domains/terminal'
import { useProjectStore } from '@/stores/project'
import { useAgentTerminal } from '@/composables/useAgentTerminal'
import { LAUNCH_ARGS_MAX_BYTES, byteLength } from '@/utils/promptFit'

interface RuntimeItem {
  name: string
  /** 自定义智能体的展示名（内置运行时为空，展示回落 name） */
  displayName?: string
  available: boolean
  defaultCommand: string
  customCommand: string
}

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const { t } = useI18n()
const projectStore = useProjectStore()

const busy = ref(false)
const selectedIds = ref<string[]>([])
const runtimes = ref<RuntimeItem[]>([])
const runtime = ref('auto')
const prompt = ref('')
const result = ref<FleetBulkAgentResult | null>(null)

const projectOptions = computed(() =>
  projectStore.projects.map(p => ({ label: p.name, value: p.id })),
)

// 运行时选项与 NewSessionDialog 同族：auto / shell 一等选项 + 注册清单；
// 探测不可用不禁用（自定义启动命令覆盖场景与探测无关，禁用会把「配命令
// 自救」一并堵死），仅加后缀提示
const runtimeOptions = computed(() => [
  { label: t('agentTerminal.runtimeAuto'), value: 'auto' },
  { label: t('agentTerminal.runtimeShell'), value: 'shell' },
  ...runtimes.value.map(r => ({
    label: r.available ? runtimeLabel(r) : `${runtimeLabel(r)} (${t('agentTerminal.runtimeUnavailable')})`,
    value: r.name,
  })),
])

/** 运行时展示名：自定义智能体用 displayName，其余回落注册名 */
function runtimeLabel(r: RuntimeItem): string {
  return r.displayName || r.name
}

const promptBytes = computed(() => byteLength(prompt.value))
const promptOver = computed(() => promptBytes.value > LAUNCH_ARGS_MAX_BYTES)

const canLaunch = computed(() => selectedIds.value.length > 0 && prompt.value.trim() !== '' && !busy.value)

async function loadRuntimes() {
  try {
    const res = await terminalApi.listAgentRuntimes()
    runtimes.value = (res.data || []) as RuntimeItem[]
  } catch {
    runtimes.value = [] // 清单拉取失败：仍可用 auto/shell 发起
  }
}

watch(() => props.show, (v) => {
  if (!v) return
  // 打开即重置：编队是一次性动作，残留上一次的选区/指令易误发起
  selectedIds.value = []
  runtime.value = 'auto'
  prompt.value = ''
  result.value = null
  void loadRuntimes()
  void projectStore.fetchProjects() // 幂等；列表就绪是选项目的前提
})

/** 跳过原因本地化：服务端逐条回告的是稳定标记原文（与 KNOWN_ERROR_I18N 同一
 *  契约），这里对编队链可能出现的封闭集合做最小映射，未命中回退原文 */
function skipReason(reason: string): string {
  if (/project not found/i.test(reason)) return t('errors.known.projectNotFound')
  const m = reason.match(/runtime (\S+) is not installed or not in the service process path/i)
  if (m) return t('agent.runtime.errorMissing', { name: m[1] })
  const v = reason.match(/runtime (\S+) failed version quick check/i)
  if (v) return t('agent.runtime.errorVersionCheck', { name: v[1] })
  if (/path does not exist or is not a directory/i.test(reason)) return t('errors.known.pathNotExist')
  return reason
}

function projectName(id: string): string {
  return projectStore.projects.find(p => p.id === id)?.name || id
}

async function launch() {
  if (!canLaunch.value) return
  busy.value = true
  result.value = null
  try {
    // 响应拦截器已解包 axios 层：res 即响应体，data 为 {created, skipped}
    //（TerminalSettings 同款断言口径）
    const res = await terminalApi.bulkAgent([...selectedIds.value], prompt.value.trim(), runtime.value) as unknown as { data?: FleetBulkAgentResult }
    const summary = res.data
    result.value = summary ?? null
    // 发起成功激活首个会话：列表先对账（terminals.changed 广播与本地 refresh
    // 幂等），再选中 + 展开管理页；其余会话由悬浮窗/值班大屏自然聚合
    const first = summary?.created[0]
    if (first) {
      const at = useAgentTerminal()
      await at.refresh()
      at.activeId.value = first.terminalId
      await at.open('docked')
    }
  } catch {
    // 拦截器已 toast 友好文案（KNOWN_ERROR_I18N）；弹层与已填内容保留供修正重试
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <n-modal
    :show="show"
    preset="card"
    :title="t('agentTerminal.fleet.title')"
    style="width: var(--modal-w-md); max-width: 94vw"
    :mask-closable="true"
    data-testid="fleet-bulk-dialog"
    @update:show="emit('update:show', $event)"
  >
    <n-form
      label-placement="left"
      label-width="auto"
      size="small"
    >
      <n-form-item :label="t('agentTerminal.fleet.fieldProjects')">
        <n-select
          v-model:value="selectedIds"
          multiple
          filterable
          :max-tag-count="5"
          :options="projectOptions"
          :placeholder="t('agentTerminal.fleet.fieldProjectsPlaceholder')"
          data-testid="fleet-bulk-projects"
        />
      </n-form-item>
      <n-form-item :label="t('agentTerminal.fieldRuntime')">
        <n-select
          v-model:value="runtime"
          :options="runtimeOptions"
          data-testid="fleet-bulk-runtime"
        />
      </n-form-item>
      <n-form-item
        :label="t('agentTerminal.fleet.fieldPrompt')"
        :show-feedback="false"
      >
        <div class="fleet-prompt">
          <n-input
            v-model:value="prompt"
            type="textarea"
            :rows="5"
            :placeholder="t('agentTerminal.fleet.fieldPromptPlaceholder')"
            data-testid="fleet-bulk-prompt"
          />
          <div
            class="fleet-prompt-hint"
            :class="{ over: promptOver }"
          >
            {{ promptOver ? t('agentTerminal.fleet.promptTruncated') : t('agentTerminal.fleet.promptBytes', { n: promptBytes }) }}
          </div>
        </div>
      </n-form-item>
    </n-form>
    <!-- 逐条回告区（P-20261003-291）：发起后内联呈现 created/skipped 明细，
         跳过原因本地化映射，弹层保持打开可复制项目名排查 -->
    <div
      v-if="result"
      class="fleet-result"
      data-testid="fleet-bulk-result"
    >
      <div class="fleet-result-line">
        <span
          v-if="result.created.length"
          class="fleet-result-ok"
        >{{ t('agentTerminal.fleet.createdSummary', { n: result.created.length }) }}</span>
        <span
          v-if="result.skipped.length"
          class="fleet-result-skip"
        >{{ t('agentTerminal.fleet.skippedSummary', { n: result.skipped.length }) }}</span>
      </div>
      <div
        v-for="s in result.skipped"
        :key="s.projectId"
        class="fleet-skip-row"
      >
        <span class="fleet-skip-name">{{ projectName(s.projectId) }}</span>
        <span class="fleet-skip-reason">{{ skipReason(s.reason) }}</span>
      </div>
    </div>
    <template #footer>
      <div class="fleet-footer">
        <n-button
          size="small"
          quaternary
          @click="emit('update:show', false)"
        >
          {{ t('agentTerminal.fleet.close') }}
        </n-button>
        <n-button
          size="small"
          type="primary"
          :loading="busy"
          :disabled="!canLaunch"
          data-testid="fleet-bulk-launch"
          @click="launch"
        >
          {{ t('agentTerminal.fleet.launch') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.fleet-prompt {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.fleet-prompt-hint {
  font-size: 12px;
  color: var(--text-muted);
}
.fleet-prompt-hint.over {
  color: var(--accent-yellow-warm);
}
.fleet-result {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
  padding: 8px 10px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-panel);
  font-size: 12px;
}
.fleet-result-line {
  display: flex;
  gap: 12px;
}
.fleet-result-ok {
  color: var(--accent-green);
}
.fleet-result-skip {
  color: var(--accent-yellow-warm);
}
.fleet-skip-row {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding-left: 8px;
  border-left: 2px solid var(--border-default);
}
.fleet-skip-name {
  color: var(--text-primary);
}
.fleet-skip-reason {
  color: var(--text-muted);
  word-break: break-all;
}
.fleet-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
