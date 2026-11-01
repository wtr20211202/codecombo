<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { NButton, NIcon, NModal, NSpin, useMessage } from 'naive-ui'
import { RefreshOutline, OpenOutline, TrashOutline, GitNetworkOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { instanceApi, type FleetInstanceRow } from '../../api/domains/system'
import { useInstanceStore, type Instance } from '../../stores/instance'
import { requestDispatchDialog } from '../../composables/useInstanceDispatch'

/**
 * 实例族总览（P-20261003-56）：同机多实例 fleet 一览——哪些实例活着、各开着
 * 什么项目，一张表看完（数据源 = 项目 claim 文件聚合 + 服务端逐实例探活）。
 * 行操作：一键打开（新标签，与 InstanceSessionOverview 同宿主 Layout 的姊妹
 * 弹层，入口 = 命令面板 + 实例菜单）；死实例残留 claim 显死态 + 「清理残留」
 * （两击确认；服务端删除前重探活防竞态，与 staleness 惰性回收联动）；
 * 「在此实例新建会话」（P-20261004-101 联邦派发）：claim 身份与注册实例 id
 * 是两个命名空间，按端口回查注册实例（同机前提），未注册（无令牌可鉴权）
 * 的行不出该入口。打开期间 15s 静默轮询重探活（P-20261004-51）：族表核心
 * 价值是存活态，值班挂机盯表时快照不能停在开表时刻——对端停止/复活下一
 * 周期即反映；页签不可见暂停（探活打停转实例无意义）、回前台立即补刷。
 * 手动刷新仍为全量装载（带 spin）。
 */
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'notify'): void }>()

const { t } = useI18n()
const message = useMessage()
const instanceStore = useInstanceStore()

const rows = ref<FleetInstanceRow[]>([])
const loading = ref(false)

// 取数串行链：开表装载/手动刷新/周期轮询/清理后回刷共用一条链，前未归后到
// 者排队不并发——防「清理成功后的回刷先回、早于它的轮询快照后到」把已清行
// 闪回来（响应按调用序落地，最后写的必是最新快照）；探活最坏 10s（死实例
// http→https 翻转各 5s）< 15s 轮询间隔 + 15s axios 超时，队列深度有界 ≤1
let loadChain: Promise<void> = Promise.resolve()
function load(silent = false): Promise<void> {
  const run = loadChain.then(() => fetchRows(silent))
  loadChain = run.then(() => undefined, () => undefined)
  return run
}

// 探活最坏 10s（死实例 http→https 翻转各 5s）：超时须给足 axios 默认之上
async function fetchRows(silent: boolean) {
  if (!silent) loading.value = true
  try {
    const res = await instanceApi.fleet({ timeout: 15_000 })
    rows.value = res.data || []
  } catch {
    if (silent) {
      // 静默轮询失败保留既有行：值班正盯着的表因一次抖动闪空比短暂陈旧更
      // 糟，下一轮自愈（与 InstanceSessionOverview.pollBlock 同约定）
      return
    }
    // 拦截器已弹错；清空避免陈旧族表误导「谁活着」的判断
    rows.value = []
  } finally {
    if (!silent) loading.value = false
  }
}

// ============== 打开期间周期重探活（P-20261004-51） ==============
// 间隔对齐 useFleetTaskBackflow 的 15s 值守惯例；每轮成本 = 1 个
// GET /instances/fleet（claim 目录扫描 + 逐实例本地探活，族表行数个位量级）
const POLL_INTERVAL_MS = 15_000
let pollTimer: ReturnType<typeof setInterval> | null = null

async function pollOnce(): Promise<void> {
  if (!props.show || document.hidden) return
  await load(true)
}

function startPoll(): void {
  stopPoll()
  pollTimer = setInterval(() => { void pollOnce() }, POLL_INTERVAL_MS)
}
function stopPoll(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/** 页签不可见暂停轮询（探活打停转实例毫无意义），回前台立即静默补刷一次 */
function onVisibilityChange(): void {
  if (!props.show) return
  if (document.hidden) {
    stopPoll()
  } else {
    void pollOnce()
    startPoll()
  }
}
document.addEventListener('visibilitychange', onVisibilityChange)
onBeforeUnmount(() => {
  stopPoll()
  document.removeEventListener('visibilitychange', onVisibilityChange)
})

watch(() => props.show, (v) => {
  if (v) {
    void load()
    // 派发行动作按注册实例回查，清单就绪是回查前提（幂等；TTL 内零请求）
    void instanceStore.ensureInstancesFresh()
    startPoll()
  } else {
    stopPoll()
  }
})

// ============== 联邦派发行动作（P-20261004-101） ==============
// claim 的 instanceId 是数据目录级身份，与注册实例 id（登记时生成）不同源；
// 同机前提下按端口回查注册实例——注册时持有对端访问令牌，无注册即无令牌，
// 派发无从鉴权，该行不出入口
function registeredPortOf(inst: Instance): number {
  try {
    const port = new URL(inst.url).port
    return port ? Number(port) : 0
  } catch {
    return 0
  }
}

function registeredInstanceFor(row: FleetInstanceRow): Instance | undefined {
  if (row.self || row.port <= 0) return undefined
  return instanceStore.instances.find(i => !i.isLocal && registeredPortOf(i) === row.port)
}

/** 行派发动作：有注册实例且该实例未被禁用（离线/无效派发必失败，提前禁用） */
function dispatchTargetFor(row: FleetInstanceRow): Instance | undefined {
  const inst = registeredInstanceFor(row)
  if (!inst) return undefined
  if (inst.status === 'offline' || inst.status === 'invalid') return undefined
  return inst
}

function dispatchTo(row: FleetInstanceRow) {
  const inst = dispatchTargetFor(row)
  if (!inst) return
  // 收起族表让位：requestDispatchDialog 拉起智能体管理页并打开对话框，
  // 目标实例已预选
  emit('update:show', false)
  requestDispatchDialog(inst.id)
}

/** 一键打开：族表实例与本机服务同机，浏览器侧可达地址 = 服务所在主机，
 * 即当前页面 hostname（用户可能经 LAN IP 访问中心，127.0.0.1 会指到自己
 * 机器上）；协议跟随当前页面。外链红线：必须带 noopener */
function openInstance(row: FleetInstanceRow) {
  const url = `${window.location.protocol}//${window.location.hostname}:${row.port}`
  window.open(url, '_blank', 'noopener')
}

// ============== 清理残留（两击确认，同结束会话交互形） ==============
const cleanArmedId = ref('')
const cleaningId = ref('')
let cleanDisarmTimer: ReturnType<typeof setTimeout> | null = null

function armClean(row: FleetInstanceRow) {
  cleanArmedId.value = row.instanceId
  if (cleanDisarmTimer) clearTimeout(cleanDisarmTimer)
  cleanDisarmTimer = setTimeout(() => { cleanArmedId.value = '' }, 2500)
}

/** 死实例（offline/invalid）或残留（stale）才可清；活实例无残留可清 */
function cleanable(row: FleetInstanceRow): boolean {
  if (row.self || row.status === 'online') return false
  return row.status === 'offline' || row.status === 'invalid' || row.stale
}

async function cleanResidual(row: FleetInstanceRow) {
  if (cleanArmedId.value !== row.instanceId) {
    armClean(row)
    return
  }
  cleanArmedId.value = ''
  cleaningId.value = row.instanceId
  try {
    const res = await instanceApi.cleanResidual(row.instanceId, { timeout: 15_000 })
    message.success(t('fleet.cleaned', { n: res.data?.removed ?? 0 }))
    await load()
  } catch {
    // 活实例拒清（409）等业务失败走拦截器文案；此处兜底刷新让行态回归真实
    message.error(t('fleet.cleanFailed'))
    await load()
  } finally {
    cleaningId.value = ''
  }
}

/** 实例号截短展示（uuid 前 8 位与通知中心口径一致，完整号挂 title） */
function shortID(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

function statusLabel(row: FleetInstanceRow): string {
  if (row.self) return t('fleet.statusSelf')
  if (row.status === 'online') return t('fleet.statusOnline')
  if (row.status === 'invalid') return t('fleet.statusInvalid')
  return t('fleet.statusOffline')
}

function projectNames(row: FleetInstanceRow): string {
  return row.projects.map(p => p.name).join('、')
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    style="width: var(--modal-w-lg); max-width: 94vw"
    :title="t('fleet.title')"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header-extra>
      <!-- 跨实例通知聚合联动（P-20261003-125）：族表看完存活态，一键转通知聚合面 -->
      <n-button
        size="tiny"
        quaternary
        data-testid="fleet-notify-link"
        :title="t('fleetNotify.title')"
        @click="emit('notify')"
      >
        {{ t('fleetNotify.title') }}
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :loading="loading"
        data-testid="fleet-refresh"
        :title="t('common.refresh')"
        @click="load()"
      >
        <template #icon>
          <n-icon size="12">
            <RefreshOutline />
          </n-icon>
        </template>
        {{ t('common.refresh') }}
      </n-button>
    </template>
    <div class="ifo-meta">
      {{ t('fleet.desc') }}
    </div>
    <n-spin
      :show="loading"
      size="small"
    >
      <div
        v-if="rows.length === 0 && !loading"
        class="ifo-empty"
        data-testid="fleet-empty"
      >
        {{ t('fleet.empty') }}
      </div>
      <div class="ifo-head">
        <span class="ifo-h-cell">{{ t('fleet.colInstance') }}</span>
        <span class="ifo-h-cell">{{ t('fleet.colPort') }}</span>
        <span class="ifo-h-cell">{{ t('fleet.colProjects') }}</span>
        <span class="ifo-h-cell">{{ t('fleet.colStatus') }}</span>
        <span class="ifo-h-cell" />
      </div>
      <div
        v-for="row in rows"
        :key="row.instanceId"
        class="ifo-row"
        :class="{ self: row.self }"
        data-testid="fleet-row"
      >
        <span
          class="ifo-instance"
          :title="row.instanceId"
        >{{ shortID(row.instanceId) }}</span>
        <span class="ifo-port">{{ row.port > 0 ? `:${row.port}` : '—' }}</span>
        <span
          class="ifo-projects"
          :title="projectNames(row)"
        >{{ row.projects.length > 0 ? projectNames(row) : t('fleet.projectsNone') }}</span>
        <span class="ifo-status">
          <span
            class="ifo-tag"
            :class="row.status"
            data-testid="fleet-status"
          >{{ statusLabel(row) }}</span>
          <span
            v-if="row.stale"
            class="ifo-tag stale"
          >{{ t('fleet.residual') }}</span>
          <span
            v-if="row.version"
            class="ifo-version"
            :title="t('fleet.versionTip')"
          >v{{ row.version }}</span>
        </span>
        <span class="ifo-actions">
          <!-- 在此实例新建会话（P-20261004-101）：派发到该实例（按端口回查
               注册实例；未注册/不可达不出入口） -->
          <button
            v-if="dispatchTargetFor(row)"
            class="ifo-row-btn"
            data-testid="fleet-dispatch"
            :title="t('fleet.dispatch')"
            :aria-label="t('fleet.dispatch')"
            @click="dispatchTo(row)"
          >
            <n-icon size="12">
              <GitNetworkOutline />
            </n-icon>
          </button>
          <button
            v-if="!row.self"
            class="ifo-row-btn"
            data-testid="fleet-open"
            :title="t('fleet.open')"
            :aria-label="t('fleet.open')"
            @click="openInstance(row)"
          >
            <n-icon size="12">
              <OpenOutline />
            </n-icon>
          </button>
          <button
            v-if="cleanable(row)"
            class="ifo-row-btn"
            :class="{ armed: cleanArmedId === row.instanceId }"
            :disabled="cleaningId === row.instanceId"
            data-testid="fleet-clean"
            :title="cleanArmedId === row.instanceId ? t('fleet.confirmClean') : t('fleet.clean')"
            :aria-label="cleanArmedId === row.instanceId ? t('fleet.confirmClean') : t('fleet.clean')"
            @click="cleanResidual(row)"
          >
            <n-icon size="12">
              <TrashOutline />
            </n-icon>
          </button>
        </span>
      </div>
    </n-spin>
  </n-modal>
</template>

<style scoped>
.ifo-meta {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 10px;
}
.ifo-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 12px 0;
  text-align: center;
}
/* 表形布局：状态列定宽防跳动，项目列弹性截断（族表行数个位量级，无分页） */
.ifo-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-tertiary);
  padding: 0 2px 4px;
}
.ifo-h-cell:nth-child(3) {
  flex: 1;
}
.ifo-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  font-size: 12px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  margin-bottom: 6px;
  background: var(--bg-surface);
}
.ifo-row.self {
  border-color: var(--accent-blue);
}
.ifo-instance {
  font-family: var(--font-mono);
  color: var(--text-primary);
  flex-shrink: 0;
}
.ifo-port {
  color: var(--text-secondary);
  flex-shrink: 0;
  min-width: 44px;
}
.ifo-projects {
  flex: 1;
  min-width: 0;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ifo-status {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.ifo-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.ifo-tag.self { color: var(--accent-blue); }
.ifo-tag.online { color: var(--accent-green); }
.ifo-tag.offline { color: var(--accent-red); }
.ifo-tag.invalid { color: var(--status-waiting); }
.ifo-tag.stale { color: var(--status-waiting); }
.ifo-version {
  font-size: 10px;
  color: var(--text-tertiary);
}
.ifo-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.ifo-row-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
}
.ifo-row-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.ifo-row-btn.armed { background: var(--accent-red); color: var(--text-on-accent); }
.ifo-row-btn:disabled { opacity: 0.4; cursor: default; }
</style>
