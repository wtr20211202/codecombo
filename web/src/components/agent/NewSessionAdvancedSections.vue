<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NCollapse, NCollapseItem, NCheckbox, NFormItem, NInput, NSelect, useMessage } from 'naive-ui'
import { useI18n } from '@/composables/useI18n'
import { useAgentTerminal } from '@/composables/useAgentTerminal'
import { openHelpEntry } from '@/utils/openHelp'
import { HELP_RUNTIME_ENTRY } from '@/utils/runtimeAvailability'
import { terminalApi } from '@/api/client'
import type { ShellCandidate, ExternalTmuxSession } from '@/api/client'
import type { RuntimeItem } from '@/composables/useAgentRuntimeOptions'

/**
 * 新建会话对话框的高级/条件表单区（自 NewSessionDialog 按表单区拆分，纯搬运
 * 零逻辑改动），三个互不重叠的条件节：
 *   - 会话级 shell 覆盖（P-20261004-57，仅纯终端形态）：缺省「跟随设置」，
 *     展开折叠区时惰性拉取候选（不展开零请求）
 *   - 自定义启动命令（本机直建路径）：随运行时联动预填，可改可存默认；
 *     单项不可用附检测说明与指引链接（P-20261003-296）
 *   - 外部 tmux 会话接管（P-20261005-189）：tmux 可用性打开时探测，选择即
 *     接管（立即生效，不经底部创建按钮）
 * 折叠展开/候选清单/接管选择等 UI 态自持——n-modal 默认 display-directive="if"
 * 内容随开关重建（GeneralSettings 同款既有结论），复开即复位，等价原 show
 * watch 的显式重置；提交所需的三个值经 v-model 交付父面板。
 */
const props = defineProps<{
  /** 当前运行时（决定 shell 覆盖节显隐与命令联动预填） */
  runtime: string
  /** 运行时清单（生效命令解析 / 不可用标注的数据源） */
  runtimes: RuntimeItem[]
  /** 派发到从实例时命令/接管两节隐藏（对端按其对端设置启动，防误配 P-101） */
  dispatching: boolean
  /** shell 候选清单（缓存归父面板——存活期 = 对话框组件实例，复开不重拉） */
  shellCandidates: ShellCandidate[]
  /** 当前生效缺省 shell 展示名（「跟随设置」档预览） */
  shellDefaultLabel: string
  /** 展开折叠区时惰性拉取候选（父面板持有一次拉取守卫） */
  loadShellCandidates: () => void
  /** 运行时重探在途（P-20261005-167）：说明行「重新检测」钮的 loading/禁用态 */
  redetecting: boolean
  /** 就地重探运行时清单（状态机在 useAgentRuntimeOptions，经 props 下发同款先例） */
  redetectRuntimes: () => void
}>()

const emit = defineEmits<{
  (e: 'update:launchCommand', v: string): void
  (e: 'update:saveDefault', v: boolean): void
  (e: 'update:shellOverride', v: string): void
  (e: 'created', session: { id: string; name: string; runtime: string }): void
}>()

const { t } = useI18n()
const message = useMessage()
const agentTerminal = useAgentTerminal()

// ── 自定义启动命令（本机直建路径）──
const launchCommand = defineModel<string>('launchCommand', { default: '' })
const saveAsDefault = defineModel<boolean>('saveDefault', { default: false })
/** 用户是否手动改过命令（切运行时时未改过才联动预填） */
const commandTouched = ref(false)

/** 当前运行时的生效命令：自定义覆盖 > 官方默认 */
const effectiveCommand = computed(() => {
  const rt = props.runtimes.find(r => r.name === props.runtime)
  if (!rt) return ''
  return rt.customCommand || rt.defaultCommand
})

/** 当前选中运行时的不可用标注（展示名；可用项 / auto / shell 为空串） */
const selectedUnavailableLabel = computed(() => {
  const rt = props.runtimes.find(r => r.name === props.runtime)
  return rt && !rt.available ? rt.displayName || rt.name : ''
})

// 切运行时：命令联动预填（用户已手改则不覆盖）
watch([() => props.runtime, () => props.runtimes], () => {
  if (!commandTouched.value) launchCommand.value = effectiveCommand.value
})

function onCommandInput() {
  commandTouched.value = true
}

function showInstallGuide() {
  openHelpEntry(HELP_RUNTIME_ENTRY)
}

// ── 会话级 shell 覆盖（P-20261004-57，仅纯终端形态）──
// 缺省「跟随设置」（不携带字段），显式选择经 POST /terminals 的 shell 字段透传
// （服务端 LookPath 校验，不存在 400）。候选与设置页共用 shell-candidates 端点
const shellOverride = defineModel<string>('shellOverride', { default: '' })
const advancedExpanded = ref<string[]>([])

/** shell 下拉选项：「跟随设置」（预览当前生效值）+ 可用候选（不可用项置灰
 *  展示，注明未检测到——探测是服务进程 PATH 视角，置灰不隐藏保可发现性）。
 *  候选值取解析后的完整路径（跨 PATH 差异确定性） */
const shellOptions = computed(() => [
  {
    label: props.shellDefaultLabel
      ? t('agentTerminal.shellFollowSettingWith', { shell: props.shellDefaultLabel })
      : t('agentTerminal.shellFollowSetting'),
    value: '',
  },
  ...props.shellCandidates.map(c => ({
    label: c.path ? `${c.name} · ${c.path}` : `${c.name} (${t('agentTerminal.shellNotFound')})`,
    value: c.path || `__unavailable__:${c.name}`,
    disabled: !c.available,
  })),
])

// 展开高级区时惰性拉取候选（拉取守卫与缓存在父面板——对话框复开不重复请求）
watch(advancedExpanded, (v) => {
  if (v.length > 0) props.loadShellCandidates()
})

// ── 外部 tmux 会话接管（P-20261005-189）──
// 服务器上用户自建的 tmux 会话（SSH attach 的那种、nohup 挂着的任务）从盲区
// 变可管：高级折叠区列出外部会话，选择即接管（attach 模式创建变体，服务端
// 跳过 new-session/环境注入）。tmux 不可用（Windows 后端）整节隐藏；派发到
// 从实例时同样隐藏（接管面在本实例服务端，与目标实例选择正交防误导）
const takeoverExpanded = ref<string[]>([])
const takeoverLoading = ref(false)
const takeoverAttaching = ref(false)
const takeoverSelected = ref('')
const externalSessions = ref<ExternalTmuxSession[]>([])
/** tmux 可用性（挂载时随运行时清单顺取一次；失败按不可用隐藏整节） */
const tmuxAvailable = ref(false)
let takeoverLoaded = false

const takeoverOptions = computed(() =>
  externalSessions.value.map(s => ({
    label: s.takenOver
      ? `${s.name} · ${t('agentTerminal.takeover.takenOverSuffix')}`
      : s.attached > 0
        ? `${s.name} · ${t('agentTerminal.takeover.attachedSuffix', { n: s.attached })}`
        : s.name,
    value: s.name,
    disabled: s.takenOver,
  })),
)

async function loadExternalSessions() {
  if (takeoverLoaded) return
  takeoverLoaded = true
  takeoverLoading.value = true
  try {
    // 响应解包约定：axios 拦截器已返回 gin body（{data:[...],available}），
    // 业务负载在 res.data（terminal-sessions store 同款）
    const res = await terminalApi.listExternalSessions() as unknown as { data?: ExternalTmuxSession[] }
    externalSessions.value = res.data || []
  } catch {
    externalSessions.value = [] // 列举失败按空集呈现（展开重试由复开对话框触发）
  } finally {
    takeoverLoading.value = false
  }
}

watch(takeoverExpanded, (v) => {
  if (v.length > 0) void loadExternalSessions()
})

/** 选择即接管：成功反馈（多端附着追加 tmux 同屏特性提示）→ 通知宿主选中 →
 *  关闭对话框；失败保持弹层可重试（拦截器已 toast 服务端原文） */
async function onTakeoverSelect(sessionName: string) {
  if (!sessionName || takeoverAttaching.value) return
  const target = externalSessions.value.find(s => s.name === sessionName)
  takeoverAttaching.value = true
  try {
    const info = await agentTerminal.attachExternal(sessionName)
    if (!info) {
      message.error(t('agentTerminal.createFailed'))
      takeoverSelected.value = ''
      return
    }
    if (target && target.attached > 0) {
      message.info(t('agentTerminal.takeover.multiClient', { n: target.attached }))
    }
    message.success(t('agentTerminal.takeover.success', { name: info.name }))
    // runtime 恒空串（外部会话无运行时概念，store 视图同值——emit 契约是
    // 创建结果快照，不虚构字段值）
    emit('created', { id: info.id, name: info.name, runtime: '' })
  } finally {
    takeoverAttaching.value = false
  }
}

// tmux 可用性探测：本组件随对话框内容挂载（display-directive="if"），复开
// 即重探——等价原 show watch 的 tmuxInfo 预取与跨复开强制重拉语义
void terminalApi.tmuxInfo()
  .then((res) => {
    const info = (res as unknown as { data?: { available?: boolean } }).data
    tmuxAvailable.value = !!info?.available
  })
  .catch(() => { tmuxAvailable.value = false })
</script>

<template>
  <!-- 高级折叠区（P-20261004-57）：仅纯终端形态提供会话级 shell 覆盖。
      默认折叠 = 「跟随设置」缺省不可达（P-213 force 高级区同款哲学）；
      agent 运行时会话不展示（运行时自管启动 shell） -->
  <n-collapse
    v-if="runtime === 'shell'"
    v-model:expanded-names="advancedExpanded"
    class="nsd-advanced"
  >
    <n-collapse-item
      :title="t('agentTerminal.shellAdvancedTitle')"
      name="shell"
    >
      <n-form-item :label="t('agentTerminal.shellField')">
        <n-select
          v-model:value="shellOverride"
          :options="shellOptions"
          data-testid="agent-shell-select"
        />
      </n-form-item>
      <div class="nsd-prompt-hint">
        {{ t('agentTerminal.shellHint') }}
      </div>
    </n-collapse-item>
  </n-collapse>
  <!-- 自定义启动命令（本机直建路径）：派发到从实例时对端按其对端设置
       启动，本端命令/存为默认不适用——隐藏防误配（P-20261004-101） -->
  <n-form-item
    v-if="runtime !== 'auto' && runtime !== 'shell' && !dispatching"
    :label="t('agentTerminal.fieldCommand')"
  >
    <div class="nsd-command">
      <!-- 单项不可用检测说明（P-20261003-296）：按 defaultCommand 口径措辞
       （检测原理=启动命令可执行），附指引链接防「标灰即死路」 -->
      <div
        v-if="selectedUnavailableLabel"
        class="nsd-runtime-note"
        data-testid="agent-runtime-note"
      >
        {{ t('agentTerminal.runtimeUnavailableNote', { name: selectedUnavailableLabel }) }}
        <button
          type="button"
          class="nsd-runtime-guide-link"
          data-testid="agent-runtime-note-link"
          @click="showInstallGuide"
        >{{ t('agentTerminal.runtimeInstallGuide') }}</button>
        <!-- 同款重探入口（P-20261005-167 ③）：单项缺失路径不落到卡片，
             说明行就地受益于清单刷新 -->
        <button
          type="button"
          class="nsd-runtime-guide-link nsd-runtime-redetect"
          data-testid="agent-runtime-note-redetect"
          :disabled="redetecting"
          @click="redetectRuntimes"
        >{{ redetecting ? t('agentTerminal.runtimeRedetecting') : t('agentTerminal.runtimeRedetect') }}</button>
      </div>
      <n-input
        v-model:value="launchCommand"
        :placeholder="effectiveCommand || t('agentTerminal.fieldCommandPlaceholder')"
        @input="onCommandInput"
      />
      <n-checkbox v-model:checked="saveAsDefault">
        {{ t('agentTerminal.saveAsDefault') }}
      </n-checkbox>
    </div>
  </n-form-item>
  <!-- 外部 tmux 会话接管（P-20261005-189）：tmux 可用且本机直建时提供，
  派发到从实例时隐藏（接管面在本实例服务端）。默认折叠——主链路（新建）
  视角它是高级动作；展开惰性列举，选择即接管（立即生效，不经底部创建按钮） -->
  <n-collapse
    v-if="tmuxAvailable && !dispatching"
    v-model:expanded-names="takeoverExpanded"
    class="nsd-advanced"
  >
    <n-collapse-item
      :title="t('agentTerminal.takeover.title')"
      name="takeover"
    >
      <n-form-item :label="t('agentTerminal.takeover.field')">
        <n-select
          v-model:value="takeoverSelected"
          :options="takeoverOptions"
          :loading="takeoverLoading"
          :disabled="takeoverAttaching"
          clearable
          :placeholder="t('agentTerminal.takeover.placeholder')"
          data-testid="agent-takeover-select"
          @update:value="onTakeoverSelect"
        />
      </n-form-item>
      <div
        v-if="!takeoverLoading && externalSessions.length === 0"
        class="nsd-prompt-hint"
        data-testid="agent-takeover-empty"
      >
        {{ t('agentTerminal.takeover.empty') }}
      </div>
      <div class="nsd-prompt-hint">
        {{ t('agentTerminal.takeover.hint') }}
      </div>
    </n-collapse-item>
  </n-collapse>
</template>

<style scoped>
/* 与对话框其余区块共用的 .nsd-prompt-hint（跨组件 scoped 边界各自带同值规则，
   改动需与 NewSessionDialog / NewSessionPromptSection 同步） */
.nsd-prompt-hint {
  font-size: 11px;
  color: var(--accent-yellow);
}
.nsd-command {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}
.nsd-runtime-note {
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.6;
}
/* 运行时选项可用态徽标（P-20261004-85）的样式内联在 renderRuntimeOptionLabel
 * （portal 渲染上下文吃不到 scoped data-v），此处无规则 */
.nsd-advanced {
  margin-bottom: 12px;
}
.nsd-runtime-guide-link {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--accent-blue);
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.nsd-runtime-guide-link:hover { text-decoration: underline; }
/* 重新检测小钮（P-20261005-167）：与指引链接同族链式小钮，邻位隔开；禁用
   （探测在途）降透明度给载入反馈 */
.nsd-runtime-redetect { margin-left: 10px; }
.nsd-runtime-redetect:disabled { cursor: default; opacity: 0.6; }
</style>
