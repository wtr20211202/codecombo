<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import {
  NButton, NIcon, NInput, NEmpty, NSpin, NDropdown, useMessage,
} from 'naive-ui'
import {
  SearchOutline, AddOutline, FolderOutline, ChevronDownOutline, CopyOutline,
  EllipsisHorizontalOutline, ArrowRedoOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useLockStore } from '../../stores/lock'
import { useRemoteHostStore } from '../../stores/remoteHost'
import { useHostStatus } from '../../composables/useHostStatus'
import { useRemoteOpsStore } from '../../stores/remoteOps'
import { remoteHostApi, type RemoteHost } from '../../api/client'
import { confirmDialog, promptDialog } from '../../composables/useDialog'
import RemoteHostCard from './RemoteHostCard.vue'

/**
 * 远程主机列表（XShell 式会话管理器侧栏）：
 * - 目录分组：新建/重命名/删除目录；主机拖拽或右键「移动到」在目录间移动
 * - 复制/粘贴主机：服务端 duplicate 复制凭据（含密码/PEM），粘贴生成副本
 * - 主机卡片（P-20261030-3 单行紧凑终态）：点击开编辑弹窗（详情唯一入口）；
 *   开终端/文件管理走 hover 快捷钮；… 菜单：新终端 / 诊断 / 远程执行 /
 *   Git 对照 / 移动到 / 复制 / 编辑 / 测试 / 删除
 * - 全部重测（P-20261006-3）：工具条一键逐台触发既有测试连接（并发钳在 store），
 *   进行中逐台脉冲徽章 + 完成 toast 汇总（30s 探测周期外的手动全量触发）
 * 分组结构由宿主持有并持久化（uiState.remoteConsole.groups），本组件经
 * update:groups 上报变更；开终端/增删改主机经事件外抛（编辑弹窗在宿主）。
 */
export interface RemoteGroup {
  id: string
  name: string
  hostIds: string[]
}

const props = defineProps<{
  groups: RemoteGroup[]
  creating: Record<string, boolean>
  booting?: boolean
  /** 侧栏宽度 px（P-20261106-5 可调，宿主经 SidebarResizer 持值与记忆；缺省 260 = 旧固定宽） */
  width?: number
}>()

const emit = defineEmits<{
  (e: 'open', hostId: string): void
  (e: 'add-host'): void
  (e: 'manage-host', payload: { hostId: string; key: 'edit' | 'test' | 'delete' | 'files' }): void
  (e: 'update:groups', groups: RemoteGroup[]): void
}>()

const { t } = useI18n()
const message = useMessage()

const remoteHostStore = useRemoteHostStore()
const remoteOps = useRemoteOpsStore()
const lockStore = useLockStore()
const { statusMap, refresh: refreshHostStatus } = useHostStatus()

const searchQuery = ref('')
// 折叠的目录 id 集合（会话内状态，不持久化）
const collapsed = ref(new Set<string>())
// 复制剪贴板（内存）：待粘贴的主机 id
const copiedHostId = ref('')
// 拖拽中的主机 id
let dragHostId = ''

const hosts = computed(() => remoteHostStore.hosts)

const filteredHosts = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return hosts.value
  return hosts.value.filter(h =>
    h.name.toLowerCase().includes(q) ||
    `${h.user}@${h.host}:${h.port}`.toLowerCase().includes(q),
  )
})

/** 目录内的主机（按目录 hostIds 顺序，应用搜索过滤） */
function hostsIn(group: RemoteGroup) {
  const byId = new Map(filteredHosts.value.map(h => [h.id, h]))
  const out: typeof filteredHosts.value = []
  for (const id of group.hostIds) {
    const h = byId.get(id)
    if (h) out.push(h)
  }
  return out
}

const rootHosts = computed(() => {
  const grouped = new Set(props.groups.flatMap(g => g.hostIds))
  return filteredHosts.value.filter(h => !grouped.has(h.id))
})

function hostById(id: string) {
  return hosts.value.find(h => h.id === id)
}

/** 三态：绿 = 已连通（认证通过）；黄 = 仅 TCP 可达（认证未验证）；红/灰 = 不可达 */
function statusClassOf(hostId: string): string {
  const s = statusMap.value[hostId]
  if (!s) return 'unknown'
  if (s.state !== 'online') return 'offline'
  return s.authOk ? 'online' : 'auth-pending'
}

// ============== 目录管理 ==============

function setGroups(next: RemoteGroup[]) {
  emit('update:groups', next)
}

async function createGroup() {
  const name = await promptDialog({ title: t('remoteConsole.newGroupTitle'), label: t('remoteConsole.groupNameLabel') })
  if (!name || !name.trim()) return
  setGroups([...props.groups, { id: `grp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, name: name.trim(), hostIds: [] }])
}

async function renameGroup(g: RemoteGroup) {
  const name = await promptDialog({ title: t('remoteConsole.renameGroupTitle'), label: t('remoteConsole.groupNameLabel'), defaultValue: g.name })
  if (!name || !name.trim()) return
  setGroups(props.groups.map(x => (x.id === g.id ? { ...x, name: name.trim() } : x)))
}

async function deleteGroup(g: RemoteGroup) {
  const ok = await confirmDialog({
    title: t('remoteConsole.deleteGroupTitle'),
    content: t('remoteConsole.deleteGroupConfirm', { name: g.name }),
    type: 'warning',
  })
  if (!ok) return
  // 仅删目录不删主机：目录内主机回根级
  setGroups(props.groups.filter(x => x.id !== g.id))
}

function toggleCollapse(g: RemoteGroup) {
  const next = new Set(collapsed.value)
  if (next.has(g.id)) next.delete(g.id)
  else next.add(g.id)
  collapsed.value = next
}

/** 主机移动到目录（groupId=null 移回根级） */
function moveToGroup(hostId: string, groupId: string | null) {
  const stripped = props.groups.map(g => ({ ...g, hostIds: g.hostIds.filter(id => id !== hostId) }))
  if (groupId === null) {
    setGroups(stripped)
    return
  }
  setGroups(stripped.map(g => (g.id === groupId && !g.hostIds.includes(hostId) ? { ...g, hostIds: [...g.hostIds, hostId] } : g)))
}

// ============== 复制 / 粘贴主机 ==============

/** 粘贴主机副本：duplicate 复制凭据，进 groupId 目录（null = 根级） */
async function pasteHost(groupId: string | null) {
  if (!copiedHostId.value) return
  try {
    // 响应拦截器已解包：res 即 { data: { id, ... } }
    const res = await remoteHostApi.duplicate(copiedHostId.value) as unknown as { data?: { id: string } }
    const newId = res.data?.id
    await remoteHostStore.fetch()
    if (newId && groupId) moveToGroup(newId, groupId)
    message.success(t('remoteConsole.pasted'))
  } catch (e: any) {
    message.error(e?.userMessage || e?.message || t('remoteConsole.pasteFailed'))
  }
}

function copyHost(id: string) {
  copiedHostId.value = id
  message.success(t('remoteConsole.copied'))
}

// ============== 拖拽 ==============

function onDragStart(payload: { hostId: string; event: DragEvent }) {
  dragHostId = payload.hostId
  if (payload.event.dataTransfer) payload.event.dataTransfer.effectAllowed = 'move'
}
function onDropTo(groupId: string | null) {
  if (dragHostId) moveToGroup(dragHostId, groupId)
  dragHostId = ''
}

// ============== 键盘导航 ==============
// ↑↓ 在可见行序列（目录头 + 主机卡，折叠目录的成员不参与）环绕移动，
// Enter/Space 激活：目录头折叠/展开；主机卡与点击同语义（打开编辑弹窗）。
// 监听挂侧栏根节点（tabindex=0，点击卡片时焦点自然落入），焦点在搜索框或
// 卡片内按钮上时让位原生行为。
const sidebarRef = ref<HTMLElement>()
const activeIdx = ref(0)
type NavRow = { kind: 'group'; g: RemoteGroup } | { kind: 'host'; h: RemoteHost }
const navRows = computed<NavRow[]>(() => {
  const rows: NavRow[] = []
  for (const g of props.groups) {
    rows.push({ kind: 'group', g })
    if (!collapsed.value.has(g.id)) for (const h of hostsIn(g)) rows.push({ kind: 'host', h })
  }
  for (const h of rootHosts.value) rows.push({ kind: 'host', h })
  return rows
})
// 模板侧的扁平下标：目录头 i、目录内主机 i+1+hi、根级主机从 rootNavStart 起
const groupNavIdx = computed<number[]>(() => {
  const out: number[] = []
  let i = 0
  for (const g of props.groups) {
    out.push(i)
    i += 1 + (collapsed.value.has(g.id) ? 0 : hostsIn(g).length)
  }
  return out
})
const rootNavStart = computed(() => {
  let i = 0
  for (const g of props.groups) i += 1 + (collapsed.value.has(g.id) ? 0 : hostsIn(g).length)
  return i
})
function hostNavIdx(gi: number, hi: number): number {
  return (groupNavIdx.value[gi] ?? 0) + 1 + hi
}
watch(navRows, (rows) => {
  if (activeIdx.value >= rows.length) activeIdx.value = Math.max(0, rows.length - 1)
})
watch([activeIdx, navRows], () => nextTick(scrollActiveIntoView))
function scrollActiveIntoView(): void {
  sidebarRef.value
    ?.querySelector(`[data-nav-idx="${activeIdx.value}"]`)
    ?.scrollIntoView({ block: 'nearest' })
}
function activateRow(row: NavRow): void {
  if (row.kind === 'group') { toggleCollapse(row.g); return }
  // 与 RemoteHostCard.onCardClick 同语义：卡片点击 = 编辑弹窗（P-20261030-3）
  onHostSelect({ hostId: row.h.id, key: 'edit' })
}
function onSidebarKeydown(e: KeyboardEvent): void {
  const rows = navRows.value
  const target = e.target as HTMLElement
  if (target.closest('.remote-search input, input, textarea, [contenteditable="true"]')) return
  if (rows.length === 0) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const delta = e.key === 'ArrowDown' ? 1 : -1
    activeIdx.value = (activeIdx.value + delta + rows.length) % rows.length
  } else if (e.key === 'Enter' || e.key === ' ') {
    if (target.closest('button')) return
    e.preventDefault()
    const row = rows[activeIdx.value]
    if (row) activateRow(row)
  }
}

// ============== 主机操作菜单 ==============

const hostMenuOptions = computed(() => {
  const moveChildren = [
    { label: t('remoteConsole.rootGroup'), key: 'move:root' },
    ...props.groups.map(g => ({ label: g.name, key: `move:${g.id}` })),
  ]
  return [
    { label: t('remoteConsole.newTerminal'), key: 'term' },
    { label: t('remoteConsole.diagnoseHost'), key: 'diagnose' },
    { label: t('ai.remoteExec.button'), key: 'exec' },
    // 本地-远端同项目 Git 对照（P-20261004-34）；FTP 主机在 onHostSelect 拦下
    { label: t('remoteOps.gitCompare.menu'), key: 'gitcompare' },
    { label: t('remoteFiles.menu'), key: 'files' },
    { type: 'divider', key: 'd1' },
    { label: t('remoteConsole.moveToGroup'), key: 'move', children: moveChildren },
    { label: t('remoteConsole.copyHost'), key: 'copy' },
    { type: 'divider', key: 'd2' },
    { label: t('common.edit'), key: 'edit' },
    { label: t('deploy.host.test'), key: 'test' },
    { label: t('common.delete'), key: 'delete', props: { style: { color: 'var(--accent-red)' } } },
  ]
})

function onHostSelect(payload: { hostId: string; key: string }) {
  const { hostId, key } = payload
  const h = hostById(hostId)
  if (!h) return
  if (key === 'term') emit('open', hostId)
  else if (key === 'diagnose') remoteOps.openDiagnose(h.id, h.name)
  else if (key === 'exec') remoteOps.openExec(h.id, h.name)
  // Git 对照走 SSH 通道；FTP 主机无 shell 即拒（对照卡不弹，就地提示）
  else if (key === 'gitcompare') {
    if (h.protocol === 'ftp') message.warning(t('remoteConsole.ftpNoGitCompare'))
    else remoteOps.openGitCompare(h.id, h.name)
  }
  else if (key === 'copy') copyHost(h.id)
  else if (key.startsWith('move:')) moveToGroup(h.id, key.slice(5) === 'root' ? null : key.slice(5))
  else if (key === 'files') emit('manage-host', { hostId: h.id, key: 'files' })
  else if (key === 'edit' || key === 'test' || key === 'delete') emit('manage-host', { hostId: h.id, key })
}

function onGroupMenu(g: RemoteGroup, key: string) {
  if (key === 'rename') void renameGroup(g)
  else if (key === 'paste') void pasteHost(g.id)
  else if (key === 'delete') void deleteGroup(g)
}

// ============== 卡片右键菜单（与操作下拉同选项） ==============

const cardCtx = ref<{ show: boolean; x: number; y: number; hostId: string } | null>(null)

function onCardCtx(payload: { hostId: string; event: MouseEvent }) {
  cardCtx.value = { show: true, x: payload.event.clientX, y: payload.event.clientY, hostId: payload.hostId }
}

function onCardCtxSelect(key: string) {
  const hostId = cardCtx.value?.hostId || ''
  closeCardCtx()
  onHostSelect({ hostId, key })
}

function closeCardCtx() {
  cardCtx.value = null
}

const groupMenuOptions = computed(() => [
  { label: t('remoteConsole.renameGroup'), key: 'rename' },
  { label: t('remoteConsole.pasteHost'), key: 'paste' },
  { type: 'divider', key: 'd' },
  { label: t('common.delete'), key: 'delete' },
])

// 状态轮询在挂载期若 423 静默失败要等 30s 才有下一轮：解锁后立即补拉徽章
watch(() => lockStore.isLocked, (newVal, oldVal) => {
  if (oldVal && !newVal) void refreshHostStatus()
})

// ============== 全部重测（P-20261006-3） ==============
// 探测循环是 30s 周期（后端 module.go），凭据改完/网络恢复后想立即确认全部主机
// 存活，逐台点测试或等周期都慢——一键逐台触发既有测试连接（拨号+whoami 同链），
// 并发钳在 store（fetch-all 池同档 4）。进行中逐台徽章由 store.testing 驱动
// （卡片蓝色脉冲点），重入去抖靠本按钮 loading 态。
const retestingAll = ref(false)

async function retestAll() {
  if (retestingAll.value || remoteHostStore.hosts.length === 0) return
  retestingAll.value = true
  try {
    const s = await remoteHostStore.testAll()
    if (s.failed === 0) {
      message.success(t('remoteConsole.retestAllOk', { n: s.ok }))
    } else {
      // 失败主机名直列（「、」连接与终端广播条 failedHosts 同惯例），长驻 6s 便于抄录
      message.warning(
        t('remoteConsole.retestAllPartial', { ok: s.ok, fail: s.failed, names: s.failedNames.join('、') }),
        { duration: 6000 },
      )
    }
    // 后端逐台手动测试会乐观刷新探测缓存，立即拉一次让 AuthOK 徽章跟上
    // （与设置页单台测试后的 refreshHostStatus 同语义）
    void refreshHostStatus()
  } finally {
    retestingAll.value = false
  }
}
</script>

<template>
  <aside
    ref="sidebarRef"
    class="remote-sidebar"
    :style="{ width: `${props.width ?? 260}px` }"
    tabindex="0"
    @keydown="onSidebarKeydown"
  >
    <div class="remote-search">
      <n-icon
        size="14"
        class="remote-search-icon"
      >
        <SearchOutline />
      </n-icon>
      <n-input
        v-model:value="searchQuery"
        size="small"
        :placeholder="t('remoteConsole.searchPlaceholder')"
        :bordered="false"
      />
    </div>

    <div class="sidebar-actions">
      <n-button
        size="tiny"
        quaternary
        @click="emit('add-host')"
      >
        <template #icon>
          <n-icon size="12">
            <AddOutline />
          </n-icon>
        </template>
        {{ t('remoteConsole.addHost') }}
      </n-button>
      <n-button
        size="tiny"
        quaternary
        @click="createGroup"
      >
        <template #icon>
          <n-icon size="12">
            <FolderOutline />
          </n-icon>
        </template>
        {{ t('remoteConsole.newGroup') }}
      </n-button>
      <n-button
        size="tiny"
        quaternary
        :loading="retestingAll"
        :disabled="remoteHostStore.hosts.length === 0"
        data-testid="retest-all"
        @click="retestAll"
      >
        <template #icon>
          <n-icon size="12">
            <ArrowRedoOutline />
          </n-icon>
        </template>
        {{ t('remoteConsole.retestAll') }}
      </n-button>
      <n-button
        v-if="copiedHostId"
        size="tiny"
        quaternary
        @click="pasteHost(null)"
      >
        <template #icon>
          <n-icon size="12">
            <CopyOutline />
          </n-icon>
        </template>
        {{ t('remoteConsole.pasteHost') }}
      </n-button>
    </div>

    <n-spin
      :show="remoteHostStore.loading || !!props.booting"
      size="small"
      class="spin-fill"
    >
      <!-- 双空态之一：无主机 → 页内直接新增 -->
      <div
        v-if="!booting && remoteHostStore.hosts.length === 0"
        class="remote-empty"
      >
        <n-empty
          :description="t('remoteConsole.noHosts')"
          size="small"
        >
          <template #extra>
            <n-button
              size="small"
              type="primary"
              @click="emit('add-host')"
            >
              <template #icon>
                <n-icon><AddOutline /></n-icon>
              </template>
              {{ t('remoteConsole.addHost') }}
            </n-button>
          </template>
        </n-empty>
      </div>

      <!-- 目录 + 根级主机（卡片可拖入目录/根区） -->
      <div
        v-else
        class="host-tree"
        @dragover.prevent
        @drop.prevent="onDropTo(null)"
      >
        <div
          v-for="(g, gi) in groups"
          :key="g.id"
          class="host-group"
          @dragover.prevent
          @drop.prevent="onDropTo(g.id)"
        >
          <div
            class="group-head"
            :data-nav-idx="groupNavIdx[gi]"
            :class="{ 'is-nav-active': groupNavIdx[gi] === activeIdx }"
            @click="toggleCollapse(g)"
          >
            <n-icon
              size="11"
              class="group-caret"
              :class="{ 'is-collapsed': collapsed.has(g.id) }"
            >
              <ChevronDownOutline />
            </n-icon>
            <n-icon size="12">
              <FolderOutline />
            </n-icon>
            <span
              class="group-name"
              :title="g.name"
            >{{ g.name }}</span>
            <span class="group-count">{{ hostsIn(g).length }}</span>
            <n-dropdown
              trigger="click"
              :options="groupMenuOptions"
              @select="(key: string) => onGroupMenu(g, key)"
            >
              <n-button
                size="tiny"
                quaternary
                class="group-more"
                :title="t('remoteConsole.groupActions')"
                @click.stop
              >
                <template #icon>
                  <n-icon data-icon-action="common.more"><EllipsisHorizontalOutline /></n-icon>
                </template>
              </n-button>
            </n-dropdown>
          </div>
          <div
            v-show="!collapsed.has(g.id)"
            class="group-body"
          >
            <div
              v-if="hostsIn(g).length === 0"
              class="group-empty-hint"
            >
              {{ t('remoteConsole.groupEmpty') }}
            </div>
            <RemoteHostCard
              v-for="(h, hi) in hostsIn(g)"
              :key="h.id"
              :host="h"
              :status-class="statusClassOf(h.id)"
              :creating="creating[h.id] || false"
              :testing="remoteHostStore.testing[h.id] || false"
              :menu-options="hostMenuOptions"
              :data-nav-idx="hostNavIdx(gi, hi)"
              :class="{ 'is-nav-active': hostNavIdx(gi, hi) === activeIdx }"
              @open="emit('open', $event)"
              @select="onHostSelect"
              @dragstart="onDragStart"
              @ctx="onCardCtx"
            />
          </div>
        </div>

        <!-- 根级主机 -->
        <div class="host-root">
          <RemoteHostCard
            v-for="(h, ri) in rootHosts"
            :key="h.id"
            :host="h"
            :status-class="statusClassOf(h.id)"
            :creating="creating[h.id] || false"
            :testing="remoteHostStore.testing[h.id] || false"
            :menu-options="hostMenuOptions"
            :data-nav-idx="rootNavStart + ri"
            :class="{ 'is-nav-active': rootNavStart + ri === activeIdx }"
            @open="emit('open', $event)"
            @select="onHostSelect"
            @dragstart="onDragStart"
            @ctx="onCardCtx"
          />
          <div
            v-if="hosts.length > 0 && rootHosts.length === 0 && filteredHosts.length === 0"
            class="group-empty-hint"
          >
            {{ t('commandPalette.noResults') }}
          </div>
        </div>
      </div>
    </n-spin>

    <!-- 主机卡片右键菜单（与操作下拉同选项） -->
    <n-dropdown
      v-if="cardCtx"
      trigger="manual"
      placement="bottom-start"
      :show="cardCtx.show"
      :x="cardCtx.x"
      :y="cardCtx.y"
      :options="hostMenuOptions"
      @select="onCardCtxSelect"
      @clickoutside="closeCardCtx"
    />
  </aside>
</template>

<style scoped>
.remote-sidebar {
  /* 宽度来自宿主（P-20261106-5 可调 + SidebarResizer 记忆），默认 260 = 旧固定宽 */
  flex-shrink: 0;
  border-right: 1px solid var(--border-default);
  background: var(--bg-panel);
  display: flex;
  flex-direction: column;
  padding: 10px;
  gap: 8px;
  overflow: hidden;
}
/* 键盘导航：侧栏根节点承接焦点（容器自身 outline 抑制，行高亮即指示） */
.remote-sidebar:focus, .remote-sidebar:focus-visible { outline: none; }
.remote-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  flex-shrink: 0;
}
.remote-search-icon { color: var(--text-muted); flex-shrink: 0; }
.sidebar-actions { display: flex; gap: 4px; flex-shrink: 0; }
.remote-empty { padding-top: 40px; }

.host-tree { overflow-y: auto; flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 10px; padding-bottom: 8px; }
.host-group {
  border: 1px dashed var(--border-default);
  border-radius: 8px;
  padding: 6px;
}
.group-head {
  display: flex; align-items: center; gap: 5px;
  padding: 3px 4px; cursor: pointer; border-radius: 5px;
  user-select: none;
}
.group-head:hover { background: var(--bg-hover); }
.group-head.is-nav-active { background: var(--bg-hover); }
.group-caret { transition: transform var(--motion-base); color: var(--text-muted); flex-shrink: 0; }
.group-caret.is-collapsed { transform: rotate(-90deg); }
.group-name {
  flex: 1; min-width: 0;
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.group-count { font-size: 10px; color: var(--text-muted); font-family: var(--font-mono); flex-shrink: 0; }
.group-more { opacity: 0; transition: opacity var(--motion-base); flex-shrink: 0; }
.group-head:hover .group-more { opacity: 1; }
.group-body { display: flex; flex-direction: column; gap: 6px; padding: 6px 0 2px; }
.group-empty-hint { font-size: 11px; color: var(--text-dim); padding: 4px 6px; }
.host-root { display: flex; flex-direction: column; gap: 6px; }
/* 主机卡键盘导航高亮（父作用域样式可命中子组件根节点） */
.host-card.is-nav-active { border-color: var(--brand-accent); background: var(--bg-hover); }
</style>
