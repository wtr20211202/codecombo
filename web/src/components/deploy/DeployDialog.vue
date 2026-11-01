<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import {
  NModal, NButton, NSpace, NTag, NEmpty, NSelect, NDropdown,
  NInput, NForm, NFormItem, NIcon, NProgress, NScrollbar, NAlert, NCheckbox, useMessage,
} from 'naive-ui'
import { CloseOutline, CopyOutline, AddOutline, DownloadOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { copyText } from '../../utils/clipboard'
import { useRemoteHostStore } from '../../stores/remoteHost'
import { useDeployConfigStore } from '../../stores/deployConfig'
import { useDeployTaskStore, type DeployLogEntry } from '../../stores/deployTask'
import { useRemoteOpsStore } from '../../stores/remoteOps'
import { useDeployLogDownload } from '../../composables/useDeployLogDownload'
import type { DeployerInstance, DeployerInfo, DeployTask } from '../../api/client'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const { t } = useI18n()
const message = useMessage()

const remoteHostStore = useRemoteHostStore()
const deployConfigStore = useDeployConfigStore()
const deployTaskStore = useDeployTaskStore()
const remoteOps = useRemoteOpsStore()
// 部署日志留档下载（P-20261003-142）：进度区/历史行共用下载链（过期语义在
// composable 内就地提示）
const { downloadLog } = useDeployLogDownload()

const selectedHostId = ref<string | null>(null)
const instances = ref<DeployerInstance[]>([])
const running = ref(false)
// 不等候（P-20261004-36）：同主机已有在途任务时直接报错而非排队，默认关
// （排队是默认行为——多 agent 场景被拒即断流的问题就此消除）
const noWait = ref(false)
// 历史任务（最近 20 条，服务端按 StartedAt 降序）：相同配置重跑的入口
const recentTasks = ref<DeployTask[]>([])

const hostOptions = computed(() =>
  remoteHostStore.hosts.map(h => ({ label: `${h.name} (${h.user}@${h.host})`, value: h.id })))

// 「+ 添加工具」下拉选项：按 category 分组，AllowMultiple=false 且已加的禁用
const addToolOptions = computed(() => {
  const groups: Record<string, Array<{ id: string; label: string; disabled: boolean }>> = {}
  for (const d of deployConfigStore.deployers) {
    const cat = d.category || 'other'
    if (!groups[cat]) groups[cat] = []
    groups[cat].push({
      id: d.id,
      label: t(`deploy.tools.${d.id}.name`),
      disabled: !d.allowMultiple && instances.value.some(i => i.deployerId === d.id),
    })
  }
  const catOrder = ['init', 'dev_tool', 'self_host', 'other']
  const out: any[] = []
  for (const cat of catOrder) {
    if (!groups[cat]) continue
    out.push({
      type: 'group',
      label: t(`deploy.category.${cat}`),
      key: cat,
      children: groups[cat].map(item => ({
        label: item.label,
        key: item.id,
        disabled: item.disabled,
      })),
    })
  }
  return out
})

const progressPercent = computed(() => {
  if (!deployTaskStore.currentTask) return 0
  if (deployTaskStore.finished) return 100
  const total = deployTaskStore.progressTotal
  if (!total || total === 0) return 0
  const idx = deployTaskStore.progressIndex
  // 纯比例：idx=0 时 0%，idx=total 时 100%；避免 +50/total 偏移让用户误以为卡在某进度
  return Math.min(99, Math.round((idx / total) * 100))
})

// 同主机排队信息（P-20261004-36）：queued 排队态展示「等谁 + 第几位」，
// waitingFor 清空（取到锁/终态）即消失
const queueInfo = computed(() => {
  const t = deployTaskStore.currentTask
  if (!t || t.status !== 'queued' || !t.waitingFor) return null
  return { task: t.waitingFor, pos: t.queuePosition || 0 }
})

// 排队态低频轮询（3s）：队列位次随前方任务完成前移，WS 在排队期无日志流量，
// 轮询是位次活性的最小代价来源。状态离开 queued（取到锁/取消）即停
let queuePollTimer: ReturnType<typeof setInterval> | null = null
function startQueuePoll() {
  if (!queuePollTimer) queuePollTimer = setInterval(() => { void deployTaskStore.refreshCurrent() }, 3000)
}
function stopQueuePoll() {
  if (queuePollTimer) {
    clearInterval(queuePollTimer)
    queuePollTimer = null
  }
}
watch(() => deployTaskStore.currentTask?.status, (s) => {
  if (s === 'queued' && props.show) startQueuePoll()
  else stopQueuePoll()
})
// 弹窗开关与状态是两个独立维度：关闭即停；重开时任务仍在排队要补启
//（状态未变，status watcher 不会再触发）
watch(() => props.show, (s) => {
  if (!s) {
    stopQueuePoll()
    return
  }
  if (deployTaskStore.currentTask?.status === 'queued') startQueuePoll()
})
onUnmounted(stopQueuePoll)

// 把日志条目本地化：优先用 messageKey + params 调 t()，无 key 时回退原始 message
function localizedLogMessage(log: DeployLogEntry): string {
  if (log.messageKey) {
    return t(log.messageKey, log.messageParams || {})
  }
  return log.message
}

// 日志级别本地化
function localizedLevel(level: DeployLogEntry['level']): string {
  const key = `deploy.log.level.${level}`
  const translated = t(key)
  // t 找不到 key 时返回 key 本身，此时回退到原始 level
  return translated === key ? level : translated
}

function findDeployer(id: string): DeployerInfo | undefined {
  return deployConfigStore.deployers.find(d => d.id === id)
}

function handleAddTool(key: string) {
  const d = findDeployer(key)
  if (!d) return
  if (!d.allowMultiple && instances.value.some(i => i.deployerId === d.id)) {
    message.warning(t('deploy.dialog.notAllowMultiple'))
    return
  }
  const params: Record<string, string> = {}
  for (const p of d.paramsSchema) {
    if (p.default) params[p.key] = p.default
  }
  instances.value.push({ deployerId: d.id, params })
}

function removeInstance(idx: number) {
  instances.value.splice(idx, 1)
}

function canStart() {
  return !!selectedHostId.value && instances.value.length > 0 && !running.value
}

// 选中 claude_code 时，Anthropic 配置（token/baseUrl/model）缺一不可——启动前本地预检，
// 后端 Trigger 仍有一层校验兜底（并发清空配置等罕见场景）
function validateClaudeCfg(): string | null {
  if (!instances.value.some(i => i.deployerId === 'claude_code')) return null
  const c = deployConfigStore.config
  if (!c?.hasAnthropicToken) return t('deploy.dialog.missingToken')
  if (!c?.anthropicBaseUrl) return t('deploy.dialog.missingBaseUrl')
  if (!c?.model) return t('deploy.dialog.missingModel')
  return null
}

async function startDeploy() {
  if (!selectedHostId.value || instances.value.length === 0) return
  const cfgErr = validateClaudeCfg()
  if (cfgErr) {
    message.error(cfgErr)
    return
  }
  running.value = true
  try {
    await deployTaskStore.trigger(selectedHostId.value, [...instances.value], noWait.value)
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('deploy.dialog.startFailed'))
    running.value = false
  }
}

async function cancelDeploy() {
  // 任务已结束（failed/completed/cancelled）：cancel 接口会返回 "not running"
  // 这是预期行为，不报错，直接让 UI 进入结束态
  if (deployTaskStore.finished) {
    message.info(t('deploy.dialog.taskAlreadyFinished'))
    return
  }
  // 并行触发两条取消通道，任一失败不影响另一条
  // HTTP: POST /deploy/:taskId/cancel → mgr.Cancel(id) 调 rt.cancel()
  // WS:   发送 "cancel" 文本 → deploy_ws.go 读到后调 mgr.Cancel(id)
  // 两条通道最终都走 ctx.Cancel()，exec.go 的 <-ctx.Done() 会强制 Close session
  try { await deployTaskStore.cancel() } catch { /* 静默：WS 通道兜底 */ }
  deployTaskStore.sendCancel()
}

function closeDialog() {
  if (running.value && !deployTaskStore.finished) {
    message.warning(t('deploy.dialog.cannotCloseRunning'))
    return
  }
  emit('update:show', false)
  setTimeout(() => {
    instances.value = []
    running.value = false
    deployTaskStore.reset()
  }, 300)
}

async function copyPublicKey(pub: string) {
  if (await copyText(pub)) {
    message.success(t('deploy.dialog.copied'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

function levelTagType(level: DeployLogEntry['level']) {
  switch (level) {
    case 'ok': return 'success'
    case 'warn': return 'warning'
    case 'fail': return 'error'
    default: return 'default'
  }
}

function categoryTagType(cat?: string) {
  switch (cat) {
    case 'init': return 'info'
    case 'dev_tool': return 'success'
    default: return 'warning'
  }
}

function statusTagType(s?: string) {
  switch (s) {
    case 'running': return 'info'
    case 'completed': return 'success'
    case 'failed': return 'error'
    case 'cancelled': return 'warning'
    default: return 'default'
  }
}

function onDeployTarget() {
  // D4：打开参数从 window CustomEvent 改 remoteOps store 字段——
  // 弹窗未挂载/监听器晚注册时事件会静默丢失，store 字段则始终可读
  selectedHostId.value = remoteOps.deployHostId || null
  instances.value = []
  deployTaskStore.reset()
}

// ============== 历史任务 · 相同配置重跑（P-20261002-60） ==============

async function loadHistory() {
  try {
    recentTasks.value = (await deployTaskStore.listRecent()) || []
  } catch { /* 历史为辅助信息，加载失败静默（不打扰主流程） */ }
}

function findHost(hostId: string) {
  return remoteHostStore.hosts.find(h => h.id === hostId)
}

// 行内主机名：记录还在的主机显示名称，已删的回退任务里冗余的 host 字段
function taskHostLabel(task: DeployTask): string {
  return findHost(task.hostId)?.name || task.host || task.hostId
}

// 工具清单摘要：已从注册表移除的 deployer 回退显示原始 id（t() 查不到 key 会直出 key 串）
function taskToolSummary(task: DeployTask): string {
  return task.instances
    .map(i => (findDeployer(i.deployerId) ? t(`deploy.tools.${i.deployerId}.name`) : i.deployerId))
    .join(' + ')
}

function formatTaskTime(task: DeployTask): string {
  return task.startedAt ? new Date(task.startedAt).toLocaleString() : ''
}

// 「下载日志」（P-20261003-142）：当前任务从进度区直下（有日志才出按钮）；
// 历史行整行可下——1h 内存窗内出文件，窗外服务端 410 由下载链给过期提示
//（不做事前禁用：服务重启也会提前清内存，客户端时间推算不可靠）
function downloadCurrentLog() {
  const cur = deployTaskStore.currentTask
  if (!cur) return
  void downloadLog(cur.id, taskHostLabel(cur))
}

function downloadHistoryLog(task: DeployTask) {
  void downloadLog(task.id, taskHostLabel(task))
}

// 可重跑：主机还在 + 至少一个工具仍在部署器清单 + 无进行中的部署
function canRerun(task: DeployTask): boolean {
  return !!findHost(task.hostId)
    && task.instances.some(i => !!findDeployer(i.deployerId))
    && !running.value
}

// 「相同配置重跑」：把历史任务的 hostId + 实例清单预填进表单直达确认步——
// 不直接盲触发，部署是高危面，保留人工确认环节。
// 历史清单是后端 ResolvePlan 解析后的结果（含自动补齐的依赖），重跑再次
// trigger 服务端会幂等去重；产生的是全新任务（不复用旧 taskId，日志独立）。
// 降级：主机已删 → 行内「主机已删除」且按钮禁用；工具清单变化 → 预填时剔除并提示
function handleRerun(task: DeployTask) {
  if (!findHost(task.hostId)) {
    message.warning(t('deploy.rerun.hostGone'))
    return
  }
  const known = task.instances.filter(i => !!findDeployer(i.deployerId))
  if (known.length === 0) {
    message.warning(t('deploy.rerun.noValidTools'))
    return
  }
  if (known.length < task.instances.length) {
    message.warning(t('deploy.rerun.toolsDropped', { count: task.instances.length - known.length }))
  }
  selectedHostId.value = task.hostId
  instances.value = known.map(i => ({ deployerId: i.deployerId, params: { ...(i.params || {}) } }))
  // 若当前展示着上次任务的进度区，清回表单确认步（预填的勾选直接可见）
  deployTaskStore.reset()
  message.success(t('deploy.rerun.prefilled'))
}

watch(() => props.show, async (s) => {
  if (s) {
    // store 里带着目标主机（openDeploy 设置）则应用；无目标（其他入口直接开）保持当前选择
    if (remoteOps.showDeploy && remoteOps.deployHostId) onDeployTarget()
    // 打开时强制刷新主机列表 + deployers（避免因之前 fetch 失败导致列表为空）
    try {
      await Promise.all([
        remoteHostStore.fetch(),
        deployConfigStore.fetchDeployers(),
        deployConfigStore.fetchConfig(),
      ])
    } catch (e: any) {
      message.error(e?.userMessage || e?.message || t('deploy.dialog.fetchFailed'))
    }
    // 历史任务在主机/deployers 刷新后拉取：canRerun 的主机/工具判定依赖两者就绪
    void loadHistory()
  }
})

watch(() => deployTaskStore.finished, (f) => {
  if (f) {
    running.value = false
    // 刚结束的任务进入历史，刷新让「相同配置重跑」立即对最新任务可用
    void loadHistory()
  }
}, { immediate: true })

onMounted(() => {
  // 防御性：mount 时也拉一次，避免 props.show watcher 因 show 初始已是 true 而错过
  deployConfigStore.fetchDeployers().catch(() => {})
})
</script>

<template>
  <!-- 宽度特例白名单（P-20261003-295）：部署日志宽内容类需 800px，不并入 --modal-w-lg(760px) -->
  <n-modal
    :show="show"
    preset="card"
    :title="t('deploy.dialog.title')"
    :mask-closable="false"
    :close-on-esc="!running"
    style="width: 800px; max-width: 94vw"
    @update:show="(v) => emit('update:show', v)"
  >
    <template #header-extra>
      <n-button
        quaternary
        circle
        :title="t('common.close')"
        :aria-label="t('common.close')"
        @click="closeDialog"
      >
        <template #icon>
          <n-icon :component="CloseOutline" />
        </template>
      </n-button>
    </template>

    <div class="deploy-dialog-content">
      <!-- 1. 目标主机选择 -->
      <div class="section">
        <div class="section-label">
          {{ t('deploy.dialog.targetHost') }}
        </div>
        <n-select
          v-model:value="selectedHostId"
          :options="hostOptions"
          :placeholder="t('deploy.dialog.selectHost')"
          :disabled="running"
        />
      </div>

      <!-- 2. 已选工具实例 -->
      <div class="section">
        <div class="section-label">
          <span>{{ t('deploy.dialog.instances') }}</span>
          <n-dropdown
            trigger="click"
            :options="addToolOptions"
            placement="bottom-start"
            @select="handleAddTool"
          >
            <n-button
              text
              size="small"
              type="primary"
            >
              <template #icon>
                <n-icon :component="AddOutline" />
              </template>
              {{ t('deploy.dialog.addTool') }}
            </n-button>
          </n-dropdown>
        </div>

        <n-empty
          v-if="instances.length === 0"
          :description="t('deploy.dialog.noInstances')"
        />
        <div
          v-else
          class="instances-list"
        >
          <div
            v-for="(inst, idx) in instances"
            :key="idx"
            class="instance-row"
          >
            <div class="instance-header">
              <n-tag
                size="tiny"
                :type="categoryTagType(findDeployer(inst.deployerId)?.category)"
              >
                {{ t(`deploy.category.${findDeployer(inst.deployerId)?.category}`) }}
              </n-tag>
              <span class="instance-name">{{ t(`deploy.tools.${inst.deployerId}.name`) }}</span>
              <span
                v-if="findDeployer(inst.deployerId)?.dependsOn.length"
                class="instance-deps"
              >
                ({{ t('deploy.dialog.dependsOn') }}: {{ findDeployer(inst.deployerId)?.dependsOn.join(', ') }})
              </span>
              <n-button
                text
                size="tiny"
                type="error"
                :title="t('deploy.dialog.removeInstance')"
                :aria-label="t('deploy.dialog.removeInstance')"
                :disabled="running"
                @click="removeInstance(idx)"
              >
                <template #icon>
                  <n-icon :component="CloseOutline" />
                </template>
              </n-button>
            </div>
            <div
              v-if="findDeployer(inst.deployerId)?.paramsSchema.length"
              class="instance-params"
            >
              <n-form
                v-for="p in findDeployer(inst.deployerId)?.paramsSchema"
                :key="p.key"
                inline
                size="small"
                label-placement="left"
              >
                <n-form-item :label="t(`deploy.tools.${inst.deployerId}.params.${p.key}`)">
                  <n-select
                    v-if="p.type === 'select'"
                    v-model:value="inst.params[p.key]"
                    :options="(p.options || []).map(o => ({ value: o.value, label: t(`deploy.tools.${inst.deployerId}_runModeOptions.${o.value}`) }))"
                    :placeholder="t(`deploy.tools.${inst.deployerId}.params.${p.key}.placeholder`)"
                  />
                  <n-input
                    v-else-if="p.type === 'password'"
                    v-model:value="inst.params[p.key]"
                    type="password"
                    :placeholder="t(`deploy.tools.${inst.deployerId}.params.${p.key}.placeholder`)"
                  />
                  <n-input
                    v-else
                    v-model:value="inst.params[p.key]"
                    :placeholder="t(`deploy.tools.${inst.deployerId}.params.${p.key}.placeholder`)"
                  />
                </n-form-item>
              </n-form>
            </div>
          </div>
        </div>
      </div>

      <!-- 3. 启动按钮 -->
      <div
        v-if="!deployTaskStore.currentTask"
        class="section"
      >
        <n-space
          justify="end"
          align="center"
        >
          <!-- 不等候（P-20261004-36）：默认排队等同主机锁释放，勾选恢复 P-41 拒绝式 -->
          <n-checkbox
            v-model:checked="noWait"
            size="small"
            data-testid="deploy-nowait-switch"
          >
            {{ t('deploy.dialog.noWait') }}
          </n-checkbox>
          <n-button
            type="primary"
            :disabled="!canStart()"
            :loading="running"
            @click="startDeploy"
          >
            {{ t('deploy.dialog.start') }}
          </n-button>
        </n-space>
      </div>

      <!-- 4. 进度区 -->
      <div
        v-if="deployTaskStore.currentTask"
        class="section"
      >
        <div class="progress-section">
          <div class="progress-label">
            <span>{{ t('deploy.dialog.progress') }}: {{ deployTaskStore.progressIndex + 1 }}/{{ deployTaskStore.progressTotal || deployTaskStore.currentTask.instances.length }}</span>
            <span class="progress-right">
              <n-tag
                size="small"
                :type="statusTagType(deployTaskStore.currentTask.status)"
              >
                {{ t(`deploy.status.${deployTaskStore.currentTask.status}`) }}
              </n-tag>
              <!-- 下载日志（P-20261003-142）：有日志即可留档下载，任务运行中亦可 -->
              <n-button
                v-if="deployTaskStore.logs.length > 0"
                size="tiny"
                data-testid="deploy-log-current-btn"
                @click="downloadCurrentLog"
              >
                <template #icon>
                  <n-icon :component="DownloadOutline" />
                </template>
                {{ t('deploy.logDownload.download') }}
              </n-button>
            </span>
          </div>
          <n-progress
            :percentage="progressPercent"
            :height="8"
          />
        </div>

        <!-- 同主机排队提示（P-20261004-36）：明示「等谁 + 第几位」，取消排队走
             底部取消按钮（同一 POST cancel 通道，排队任务取消即时生效） -->
        <n-alert
          v-if="queueInfo"
          type="info"
          :show-icon="true"
          style="margin-top: 8px"
          data-testid="deploy-queue-info"
        >
          {{ queueInfo.pos > 0 ? t('deploy.queue.waitingPos', queueInfo) : t('deploy.queue.waiting', queueInfo) }}
        </n-alert>

        <n-scrollbar class="log-area">
          <div
            v-for="(log, idx) in deployTaskStore.logs"
            :key="idx"
            class="log-line"
          >
            <span class="log-time">{{ log.time.substring(11, 19) }}</span>
            <n-tag
              size="tiny"
              :type="levelTagType(log.level)"
              round
            >
              {{ localizedLevel(log.level) }}
            </n-tag>
            <span class="log-msg">{{ localizedLogMessage(log) }}</span>
          </div>
        </n-scrollbar>

        <!-- 公钥展示 -->
        <div
          v-if="deployTaskStore.publicKeys.length > 0"
          class="public-keys"
        >
          <div class="public-keys-title">
            {{ t('deploy.dialog.publicKeys') }}:
          </div>
          <div
            v-for="(pk, idx) in deployTaskStore.publicKeys"
            :key="idx"
            class="public-key-row"
          >
            <div class="pk-name">
              {{ pk.keyName }}:
            </div>
            <code class="pk-value">{{ pk.publicKey }}</code>
            <n-button
              size="tiny"
              :title="t('common.copy')"
              :aria-label="t('common.copy')"
              @click="copyPublicKey(pk.publicKey)"
            >
              <template #icon>
                <n-icon :component="CopyOutline" />
              </template>
            </n-button>
          </div>
        </div>

        <!-- 错误提示 -->
        <n-alert
          v-if="deployTaskStore.currentTask.error"
          type="error"
          :show-icon="true"
          style="margin-top: 8px"
        >
          {{ deployTaskStore.currentTask.error }}
        </n-alert>
      </div>

      <!-- 5. 历史任务 · 相同配置重跑（P-20261002-60） -->
      <div
        v-if="recentTasks.length > 0"
        class="section"
      >
        <div class="section-label">
          <span>{{ t('deploy.rerun.history') }}</span>
          <span class="history-note">{{ t('deploy.rerun.resolvedNote') }}</span>
        </div>
        <div class="history-list">
          <div
            v-for="task in recentTasks"
            :key="task.id"
            class="history-row"
            data-testid="deploy-history-row"
          >
            <n-tag
              size="tiny"
              :type="statusTagType(task.status)"
            >
              {{ t(`deploy.status.${task.status}`) }}
            </n-tag>
            <span class="history-host">{{ taskHostLabel(task) }}</span>
            <n-tag
              v-if="!findHost(task.hostId)"
              size="tiny"
              type="warning"
            >
              {{ t('deploy.rerun.hostGone') }}
            </n-tag>
            <span
              class="history-tools"
              :title="taskToolSummary(task)"
            >{{ taskToolSummary(task) }}</span>
            <span class="history-time">{{ formatTaskTime(task) }}</span>
            <!-- 下载日志（P-20261003-142）：窗外任务点击后由下载链提示已过期 -->
            <n-button
              size="tiny"
              data-testid="deploy-log-btn"
              :title="t('deploy.logDownload.download')"
              @click="downloadHistoryLog(task)"
            >
              <template #icon>
                <n-icon :component="DownloadOutline" />
              </template>
              {{ t('deploy.logDownload.short') }}
            </n-button>
            <n-button
              size="tiny"
              type="primary"
              ghost
              data-testid="deploy-rerun-btn"
              :disabled="!canRerun(task)"
              @click="handleRerun(task)"
            >
              {{ t('deploy.rerun.rerun') }}
            </n-button>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <n-space justify="end">
        <n-button
          v-if="running && !deployTaskStore.finished"
          type="error"
          ghost
          data-testid="deploy-cancel-btn"
          @click="cancelDeploy"
        >
          {{ deployTaskStore.currentTask?.status === 'queued' ? t('deploy.dialog.cancelQueue') : t('deploy.dialog.cancel') }}
        </n-button>
        <n-button @click="closeDialog">
          {{ t('common.close') }}
        </n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.deploy-dialog-content { display: flex; flex-direction: column; gap: 16px; }
.section { }
.section-label { font-size: 13px; color: var(--text-secondary); margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; }
.tool-adder {
  background: var(--bg-panel);
  border: 1px dashed var(--border-color);
  border-radius: 4px;
  padding: 8px;
  margin-bottom: 8px;
}
.adder-group { margin-bottom: 8px; }
.adder-group-title { font-size: 11px; color: var(--text-secondary); margin-bottom: 4px; text-transform: uppercase; }
.instances-list { display: flex; flex-direction: column; gap: 6px; }
.instance-row {
  background: var(--bg-panel);
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 8px;
}
.instance-header { display: flex; align-items: center; gap: 8px; }
.instance-name { font-weight: 500; color: var(--text-primary); }
.instance-deps { font-size: 11px; color: var(--text-secondary); flex: 1; }
.instance-params { margin-top: 6px; padding-left: 24px; }
.progress-section { margin-bottom: 8px; }
.progress-label { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; font-size: 12px; color: var(--text-secondary); }
.progress-right { display: flex; align-items: center; gap: 8px; }
.log-area { max-height: 240px; background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 4px; padding: 8px; }
.log-line { display: flex; align-items: center; gap: 6px; font-size: 12px; font-family: var(--font-mono); padding: 2px 0; }
.log-time { color: var(--text-secondary); font-size: 11px; min-width: 60px; }
.log-msg { color: var(--text-primary); word-break: break-all; flex: 1; }
.public-keys { margin-top: 8px; padding: 8px; background: var(--bg-panel); border: 1px solid var(--border-color); border-radius: 4px; }
.public-keys-title { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
.public-key-row { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
.pk-name { font-size: 11px; color: var(--text-secondary); min-width: 140px; }
.pk-value { font-size: 11px; flex: 1; word-break: break-all; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 2px; }
/* 历史任务行：状态 + 主机 + 工具摘要（超出省略）+ 时间 + 重跑动作 */
.history-list { display: flex; flex-direction: column; gap: 4px; max-height: 168px; overflow-y: auto; }
.history-row {
  display: flex; align-items: center; gap: 8px; font-size: 12px;
  padding: 5px 8px; background: var(--bg-panel);
  border: 1px solid var(--border-color); border-radius: 4px;
}
.history-host { color: var(--text-primary); font-weight: 500; flex-shrink: 0; }
.history-tools { color: var(--text-secondary); flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.history-time { color: var(--text-muted); font-size: 11px; flex-shrink: 0; font-family: var(--font-mono); }
.history-note { font-size: 11px; color: var(--text-muted); font-weight: 400; }
</style>
