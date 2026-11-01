<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { NButton, NIcon, NInput, NModal, NSpin, useMessage } from 'naive-ui'
import { SwapHorizontalOutline, CloseOutline, CreateOutline, RefreshOutline, EyeOutline, OpenOutline, SettingsOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useInstanceStore } from '../../stores/instance'
import { useProjectStore } from '../../stores/project'
import { instanceFetch } from '../../api/instanceFetch'
import { relativeTimeParts } from '../../utils/relative-time'
import InstanceSessionOutput from './InstanceSessionOutput.vue'

/**
 * 多实例会话总览（可操作）：本机 + 各远程实例的终端会话一屏总览与就地管理。
 * 数据通道——统一经实例 API 助手（本机 = 同源 /api，远程 = 既有回环代理
 * /proxy/<id>/api，带 X-Lock-Token；与 axios 拦截器的实例改写语义一致，
 * fetch 直用以规避实例改写拦截器对本组件的耦合）。
 * 行操作：查看输出（只读 scrollback）/ 去操作（跳转到对应实例的会话上下文）/
 * 重命名（行内编辑）/ 结束会话（两击确认）；块操作：刷新 / 切换实例。
 * 本机实例的操作由服务端 terminals.changed 广播回灌会话 store，他处 UI 自动同步。
 * 打开期间自动刷新：远程块 30s 轮询（本机走广播不动），页签不可见暂停、
 * 回前台立即补刷；逐块展示最后刷新相对时间，超时变黄提示数据可能陈旧。
 */
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void; (e: 'manage'): void }>()

const { t } = useI18n()
const message = useMessage()
const instanceStore = useInstanceStore()
const projectStore = useProjectStore()

interface Row {
  id: string
  name: string
  kind: string
  projectId: string
  projectName: string
}
interface Block {
  id: string
  name: string
  isLocal: boolean
  reachable: boolean
  loading: boolean
  rows: Row[]
  /** 本块最后一次成功拉取的时刻（0 = 尚未成功过，如仍在 loading） */
  refreshedAt: number
}

const blocks = ref<Block[]>([])
const loading = ref(false)

const projectNameOf = (pid: string) =>
  projectStore.projects.find(p => p.id === pid)?.name || ''

async function fetchRows(instanceId: string): Promise<Row[]> {
  const j = await instanceFetch<{ data?: { id: string; name: string; kind?: string; projectId?: string }[] }>(
    instanceId, 'GET', '/terminals')
  return (j.data || []).map(s => ({
    id: s.id,
    name: s.name,
    kind: s.kind || 'shell',
    projectId: s.projectId || '',
    projectName: projectNameOf(s.projectId || ''),
  }))
}

async function load() {
  loading.value = true
  blocks.value = []
  try {
    await instanceStore.fetchInstances()
    // 块 0 永远是中心机（id='local'，本组件 fetch 不经实例改写拦截器，/api
    // 恒为中心数据）——名字必须取中心实例而非 currentInstance：当前视图切在
    // 远程实例上时，用 currentInstance 命名会把中心数据标成远程实例的名字。
    // 远程块列出全部已注册实例（含当前正在使用的——它的会话同样值得总览；
    // selectInstance 对同 id 有守卫，切换按钮对当前实例天然无副作用）
    const central = instanceStore.instances.find(i => i.isLocal)
    const all = [
      { id: 'local', name: central?.name || 'Local', isLocal: true },
      ...instanceStore.instances
        .filter(i => !i.isLocal)
        .map(i => ({ id: i.id, name: i.name, isLocal: false })),
    ]
    blocks.value = all.map(b => ({ ...b, reachable: b.isLocal, loading: !b.isLocal, rows: [], refreshedAt: 0 }))
    // 全部块并行拉取（本机与远程同一条代码路径）
    await Promise.all(blocks.value.map(async (b) => {
      try {
        b.rows = await fetchRows(b.id)
        b.reachable = true
        b.refreshedAt = Date.now()
      } catch {
        b.reachable = false
      } finally {
        b.loading = false
      }
    }))
  } finally {
    loading.value = false
  }
}

async function refreshBlock(b: Block) {
  b.loading = true
  try {
    b.rows = await fetchRows(b.id)
    b.reachable = true
    b.refreshedAt = Date.now()
  } catch {
    b.reachable = false
    b.rows = []
  } finally {
    b.loading = false
  }
}

// ============== 自动刷新：仅远程块 30s 轮询 + 页签不可见暂停 ==============
// 本地块由 terminals.changed 广播回灌会话 store，不参与轮询；轮询走既有代理
// fetch（实例离线沿用降级路径），失败只标离线不清数据——用户正盯着看的列表
// 因一次网络抖动闪没比短暂陈旧更糟，恢复在线后下一轮自愈。
const POLL_INTERVAL_MS = 30_000
const STALE_AFTER_MS = 2 * 60_000
let pollTimer: ReturnType<typeof setInterval> | null = null
// 上一轮未归（实例响应慢）时不叠加下一轮，避免慢实例滚雪球式堆积并发
let pollInFlight = false
// 相对时间文案的「现在」锚点：随轮询周期与回前台推进（分钟粒度文案足够）
const nowTick = ref(Date.now())

/** 轮询单块：静默刷新（不闪块级 loading），失败只标离线 */
async function pollBlock(b: Block): Promise<void> {
  try {
    b.rows = await fetchRows(b.id)
    b.reachable = true
    b.refreshedAt = Date.now()
  } catch {
    b.reachable = false
  }
}

async function pollRemoteOnce(): Promise<void> {
  if (!props.show || pollInFlight) return
  pollInFlight = true
  nowTick.value = Date.now()
  try {
    await Promise.all(blocks.value.filter(b => !b.isLocal).map(b => pollBlock(b)))
  } finally {
    pollInFlight = false
  }
}

function startPoll(): void {
  stopPoll()
  pollTimer = setInterval(() => { void pollRemoteOnce() }, POLL_INTERVAL_MS)
}
function stopPoll(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

/** 页签不可见暂停轮询（回环代理打离线实例毫无意义），回前台立即补刷一次 */
function onVisibilityChange(): void {
  if (!props.show) return
  if (document.hidden) {
    stopPoll()
  } else {
    void pollRemoteOnce()
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
    filterKeyword.value = ''
    void load()
    startPoll()
  } else {
    stopPoll()
  }
})

// ============== 全局刷新（头部按钮）与逐块最后刷新时间 ==============
const refreshing = ref(false)
async function refreshAll(): Promise<void> {
  if (refreshing.value) return
  refreshing.value = true
  try {
    await Promise.all(blocks.value.map(b => refreshBlock(b)))
  } finally {
    refreshing.value = false
  }
}

/** 相对时间文案复用 agentTerminal.activity*（与监控页/悬浮列表一致） */
function refreshedLabel(b: Block): string {
  if (!b.refreshedAt) return ''
  const p = relativeTimeParts(b.refreshedAt, nowTick.value)
  return t(`agentTerminal.${p.key}`, { n: p.n })
}
function isStale(b: Block): boolean {
  return b.refreshedAt > 0 && nowTick.value - b.refreshedAt > STALE_AFTER_MS
}

function switchTo(id: string) {
  emit('update:show', false)
  void instanceStore.selectInstance(id)
}

// ============== 行跳转：查看输出（只读）/ 去操作（直达会话上下文） ==============
const outputTarget = ref<{ sessionId: string; sessionName: string } | null>(null)
// 查看器所属实例：跟随目标行所在块（本机 = 'local'）
const viewingInstanceId = ref('local')

function viewOutput(r: Row, b: Block): void {
  viewingInstanceId.value = b.id
  outputTarget.value = { sessionId: r.id, sessionName: r.name }
}

/** 去操作：登记意图（跨 remount 存活）→ 需要时切换实例；
 *  目标实例侧 watcher 消费意图直达会话上下文（agent=管理页选中，
 *  shell=项目 + 底部终端 tab） */
async function goOperate(b: Block, r: Row): Promise<void> {
  emit('update:show', false)
  instanceStore.setSessionJump({ instanceId: b.id, sessionId: r.id, projectId: r.projectId, kind: r.kind })
  if (b.id !== instanceStore.currentInstanceId) {
    await instanceStore.selectInstance(b.id)
  }
}

// ============== 行操作：重命名（行内编辑）/ 结束会话（两击确认） ==============
const renamingId = ref('')
const renamingName = ref('')
const endArmedId = ref('')
const busyId = ref('')
let endDisarmTimer: ReturnType<typeof setTimeout> | null = null

function startRename(r: Row) {
  endArmedId.value = ''
  renamingId.value = r.id
  renamingName.value = r.name
}
function cancelRename() {
  renamingId.value = ''
}
async function confirmRename(b: Block, r: Row) {
  const name = renamingName.value.trim()
  renamingId.value = ''
  if (!name || name === r.name) return
  busyId.value = r.id
  try {
    await instanceFetch(b.id, 'PUT', `/terminals/${r.id}/rename`, { name })
    r.name = name
    message.success(t('instanceSessions.renamed'))
  } catch {
    message.error(t('instanceSessions.opFailed'))
  } finally {
    busyId.value = ''
  }
}

function armEnd(r: Row) {
  renamingId.value = ''
  endArmedId.value = r.id
  if (endDisarmTimer) clearTimeout(endDisarmTimer)
  endDisarmTimer = setTimeout(() => { endArmedId.value = '' }, 2500)
}
async function endSession(b: Block, r: Row) {
  endArmedId.value = ''
  busyId.value = r.id
  try {
    await instanceFetch(b.id, 'DELETE', `/terminals/${r.id}`)
    message.success(t('instanceSessions.ended'))
    // 本机实例由 terminals.changed 广播回灌会话 store；此处仅刷新本块列表
    await refreshBlock(b)
  } catch {
    message.error(t('instanceSessions.opFailed'))
  } finally {
    busyId.value = ''
  }
}

/** 关键字过滤：38+ 会话的实例里按名称/项目找目标（大小写不敏感，空串=全显） */
const filterKeyword = ref('')
function visibleRows(b: Block): Row[] {
  const kw = filterKeyword.value.trim().toLowerCase()
  if (!kw) return b.rows
  return b.rows.filter(r =>
    r.name.toLowerCase().includes(kw) ||
    r.projectName.toLowerCase().includes(kw) ||
    r.kind.toLowerCase().includes(kw))
}

const totalSessions = computed(() => blocks.value.reduce((n, b) => n + b.rows.length, 0))
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    style="width: var(--modal-w-md); max-width: 94vw"
    :title="t('instanceSessions.title')"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header-extra>
      <n-button
        size="tiny"
        quaternary
        :loading="refreshing"
        :title="t('overview.refresh.all')"
        :aria-label="t('overview.refresh.all')"
        @click="refreshAll"
      >
        <template #icon>
          <n-icon size="12">
            <RefreshOutline />
          </n-icon>
        </template>
        {{ t('overview.refresh.all') }}
      </n-button>
    </template>
    <n-spin :show="loading">
      <div class="iso-meta">
        {{ t('instanceSessions.summary', { n: totalSessions, m: blocks.length }) }}
      </div>
      <n-input
        v-model:value="filterKeyword"
        size="small"
        clearable
        :placeholder="t('instanceSessions.filterPlaceholder')"
        style="margin-bottom: 8px"
      />
      <div class="iso-body">
        <div
          v-for="b in blocks"
          :key="b.id"
          class="iso-block"
        >
          <div class="iso-block-head">
            <span class="iso-name">{{ b.name }}</span>
            <span
              class="iso-tag"
              :class="{ local: b.isLocal, ok: b.reachable && !b.isLocal, bad: !b.reachable && !b.isLocal }"
              :title="!b.isLocal && !b.reachable ? t('instanceSessions.unreachableTip') : undefined"
            >{{ b.isLocal ? t('instanceSessions.local') : (b.reachable ? t('instanceSessions.online') : t('instanceSessions.unreachable')) }}</span>
            <span class="iso-count">{{ visibleRows(b).length }}</span>
            <!-- 最后刷新相对时间：远程块随轮询/本地块随手动刷新推进；超时变黄 -->
            <span
              v-if="b.refreshedAt"
              class="iso-refreshed"
              :class="{ stale: isStale(b) }"
              :title="t('overview.refresh.lastTip', { time: refreshedLabel(b) })"
            >{{ refreshedLabel(b) }}</span>
            <button
              v-if="!b.isLocal && !b.reachable"
              class="iso-block-btn"
              :title="t('instanceSessions.manageInstance')"
              :aria-label="t('instanceSessions.manageInstance')"
              @click="emit('manage')"
            >
              <n-icon size="12">
                <SettingsOutline />
              </n-icon>
            </button>
            <button
              v-if="b.reachable"
              class="iso-block-btn"
              :title="t('instanceSessions.refresh')"
              :aria-label="t('instanceSessions.refresh')"
              @click="refreshBlock(b)"
            >
              <n-icon size="12">
                <RefreshOutline />
              </n-icon>
            </button>
            <n-button
              v-if="!b.isLocal && b.reachable && b.id !== instanceStore.currentInstanceId"
              size="tiny"
              quaternary
              @click="switchTo(b.id)"
            >
              <template #icon>
                <n-icon size="12">
                  <SwapHorizontalOutline />
                </n-icon>
              </template>
              {{ t('instanceSessions.switchTo') }}
            </n-button>
          </div>
          <div
            v-if="visibleRows(b).length > 0"
            class="iso-rows"
          >
            <div
              v-for="r in visibleRows(b)"
              :key="r.id"
              class="iso-row"
              :title="r.id"
            >
              <!-- 重命名态：行内输入（Enter/失焦确认，Esc 取消） -->
              <n-input
                v-if="renamingId === r.id"
                v-model:value="renamingName"
                size="tiny"
                autofocus
                class="iso-rename-input"
                @keyup.enter="confirmRename(b, r)"
                @keyup.escape="cancelRename"
                @blur="confirmRename(b, r)"
              />
              <template v-else>
                <span class="iso-row-name">{{ r.name }}</span>
                <span
                  v-if="r.projectName"
                  class="iso-row-proj"
                >{{ r.projectName }}</span>
              </template>
              <span class="iso-row-kind">{{ r.kind }}</span>
              <!-- 行操作：hover/focus 显现；结束 = 两击确认 -->
              <span
                v-if="renamingId !== r.id"
                class="iso-row-actions"
              >
                <button
                  class="iso-row-btn"
                  :title="t('instanceSessions.viewOutput')"
                  :aria-label="t('instanceSessions.viewOutput')"
                  @click.stop="viewOutput(r, b)"
                >
                  <n-icon size="11">
                    <EyeOutline />
                  </n-icon>
                </button>
                <button
                  class="iso-row-btn"
                  :title="t('instanceSessions.goOperate')"
                  :aria-label="t('instanceSessions.goOperate')"
                  @click.stop="goOperate(b, r)"
                >
                  <n-icon size="11">
                    <OpenOutline />
                  </n-icon>
                </button>
                <button
                  class="iso-row-btn"
                  :disabled="busyId === r.id"
                  :title="t('instanceSessions.rename')"
                  :aria-label="t('instanceSessions.rename')"
                  @click.stop="startRename(r)"
                >
                  <n-icon size="11">
                    <CreateOutline />
                  </n-icon>
                </button>
                <button
                  class="iso-row-btn"
                  :class="{ armed: endArmedId === r.id }"
                  :disabled="busyId === r.id"
                  :title="endArmedId === r.id ? t('instanceSessions.confirmEnd') : t('instanceSessions.end')"
                  :aria-label="endArmedId === r.id ? t('instanceSessions.confirmEnd') : t('instanceSessions.end')"
                  @click.stop="endArmedId === r.id ? endSession(b, r) : armEnd(r)"
                >
                  <n-icon size="11">
                    <CloseOutline />
                  </n-icon>
                </button>
              </span>
            </div>
          </div>
          <div
            v-else
            class="iso-empty"
          >
            {{ b.loading ? t('instanceSessions.loading') : t('instanceSessions.noSessions') }}
          </div>
        </div>
      </div>
    </n-spin>

    <!-- 只读输出查看器（独立弹层，行「查看输出」触发） -->
    <InstanceSessionOutput
      v-if="outputTarget"
      :show="!!outputTarget"
      :instance-id="viewingInstanceId"
      :session-id="outputTarget.sessionId"
      :session-name="outputTarget.sessionName"
      @update:show="(v: boolean) => { if (!v) outputTarget = null }"
    />
  </n-modal>
</template>

<style scoped>
.iso-meta {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 10px;
}
/* 块多时内容区自身滚动（modal 头保持可见） */
.iso-body {
  max-height: 56vh;
  overflow-y: auto;
}
.iso-block {
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 8px 10px;
  margin-bottom: 10px;
  background: var(--bg-surface);
}
.iso-block-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.iso-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.iso-block-btn {
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
.iso-block-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.iso-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--bg-hover);
  color: var(--text-tertiary);
}
.iso-tag.local { color: var(--accent-blue); }
.iso-tag.ok { color: var(--accent-green); }
.iso-tag.bad { color: var(--accent-red); }
.iso-count {
  flex: 1;
  text-align: right;
  font-size: 11px;
  color: var(--text-tertiary);
}
.iso-refreshed {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-tertiary);
}
/* 超 2 分钟未刷新：黄色提示数据可能陈旧 */
.iso-refreshed.stale { color: var(--status-waiting); }
.iso-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 2px;
  font-size: 12px;
  border-radius: 4px;
}
.iso-row:hover { background: var(--bg-hover); }
.iso-row-name {
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.iso-row-proj {
  color: var(--text-tertiary);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.iso-row-kind {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border-radius: 6px;
  padding: 0 6px;
  line-height: 16px;
}
/* 行操作：默认隐藏，hover/键盘焦点显现（丝滑不喧宾） */
.iso-row-actions {
  margin-left: auto;
  display: flex;
  gap: 2px;
  opacity: 0;
  transition: opacity var(--motion-base);
  flex-shrink: 0;
}
.iso-row:hover .iso-row-actions,
.iso-row:focus-within .iso-row-actions { opacity: 1; }
.iso-row-kind { margin-left: 0; }
.iso-row:not(:hover) .iso-row-kind { margin-left: auto; }
.iso-row-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
}
.iso-row-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.iso-row-btn.armed { background: var(--accent-red); color: var(--text-on-accent); }
.iso-row-btn:disabled { opacity: 0.4; cursor: default; }
.iso-rename-input { flex: 1; min-width: 0; }
.iso-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  padding: 2px 0 4px;
}
</style>
