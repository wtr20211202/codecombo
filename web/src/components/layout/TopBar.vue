<script setup lang="ts">
import { ref, computed, h, inject, watch, onBeforeUnmount } from 'vue'
import type { Ref } from 'vue'
import { useRouter } from 'vue-router'
import { NIcon, NSelect, NDropdown, createDiscreteApi, type SelectOption } from 'naive-ui'
import {
  HomeOutline,
  SearchOutline, NotificationsOutline, CloudUploadOutline,
  CloudDownloadOutline, ArrowDownCircleOutline, DuplicateOutline,
  PlayOutline, EllipsisHorizontalOutline,
  TrashOutline, OpenOutline,
  LockClosedOutline, Pin, PinOutline,
  HelpCircleOutline,
  QrCodeOutline,
  MoonOutline,
} from '@vicons/ionicons5'
import ToolButton from '../common/ToolButton.vue'
import BranchCapsule from '../git/BranchCapsule.vue'
import { useProjectStore } from '../../stores/project'
import { useNotificationStore } from '../../stores/notification'
import { useThemeStore } from '../../stores/theme'
import { useLockStore } from '../../stores/lock'
import { useLayoutLockStore } from '../../stores/layoutLock'
import { useDndStore } from '../../stores/dnd'
import { isManualDndActive, manualDndRemainingMs, DND_MANUAL_QUICK_MS } from '../../utils/dndSchedule'
import { useI18n } from '../../composables/useI18n'
import { useNarrowLayout } from '../../composables/useNarrowLayout'
import { formatBadgeCount } from '../../utils/badge'

const router = useRouter()
const projectStore = useProjectStore()
const notificationStore = useNotificationStore()
const themeStore = useThemeStore()
const lockStore = useLockStore()
// 布局锁定（P-20261003-180）：防误拖 toggle（本组件提供顶栏入口，命令面板同名命令同源）
const layoutLock = useLayoutLockStore()
const { t } = useI18n()
// 窄屏（P-20261019-7）：≤700px 工作区收成单栏；≤900px 顶栏先进入紧凑档
// （低频图标收进「更多」下拉）——768px 平板横屏下原顶栏已溢出 29px
const { compactTopbar } = useNarrowLayout()

const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({
    theme: themeStore.naiveTheme,
    themeOverrides: themeStore.naiveOverrides,
  })),
})

// 临时免打扰快速档（P-20261003-227）：铃铛旁 toggle——会议/专注场景的即时静默
// 开关（设置·通知里的时段规则之外的 手动档），与时段规则在 isSilenced OR 组合。
// 下拉两档：1 小时快速 / 直到手动关；开启中给「关闭」档。操作反馈走离散 message
// （本组件既有范式），开关状态经 dndStore.manualUntil 响应式驱动按钮 active 态
const dndStore = useDndStore()
// 剩余时长展示的时钟锚：active 期间每 30s 刷新一次（分钟精度的 title 文案，
// 30s 粒度足够；量级：单定时器 + 一次 Date.now，无渲染压力），非 active 不占定时器
const dndNowMs = ref(Date.now())
let dndTicker: ReturnType<typeof setInterval> | null = null
watch(() => dndStore.manualUntil, (u) => {
  if (isManualDndActive(u)) {
    dndNowMs.value = Date.now()
    if (dndTicker === null) dndTicker = setInterval(() => { dndNowMs.value = Date.now() }, 30_000)
  } else if (dndTicker !== null) {
    clearInterval(dndTicker)
    dndTicker = null
  }
}, { immediate: true })
onBeforeUnmount(() => {
  if (dndTicker !== null) clearInterval(dndTicker)
})

// 剩余时长人话形态（分钟向上取整防「0 分钟」；量级：一次 title 渲染一次拼接）
function formatDndRemaining(ms: number): string {
  const totalMin = Math.max(1, Math.ceil(ms / 60000))
  const hh = Math.floor(totalMin / 60)
  const mm = totalMin % 60
  if (hh === 0) return t('notify.dndManual.minutes', { n: mm })
  if (mm === 0) return t('notify.dndManual.hours', { n: hh })
  return t('notify.dndManual.hourMin', { h: hh, m: mm })
}

const dndToggleTitle = computed(() => {
  if (!isManualDndActive(dndStore.manualUntil)) return t('notify.dndManual.toggleTitle')
  const rem = manualDndRemainingMs(dndStore.manualUntil, dndNowMs.value)
  if (rem === null) return t('notify.dndManual.activeUntilOffTitle')
  return t('notify.dndManual.activeTitle', { time: formatDndRemaining(rem) })
})

const dndMenuOptions = computed(() => isManualDndActive(dndStore.manualUntil)
  ? [{ key: 'off', label: t('notify.dndManual.turnOff') }]
  : [
      { key: 'hour1', label: t('notify.dndManual.hour1') },
      { key: 'untilOff', label: t('notify.dndManual.untilOff') },
    ])

function handleDndMenu(key: string | number): void {
  if (key === 'off') {
    dndStore.disableManual()
    message.info(t('notify.dndManual.disabled'))
    return
  }
  if (key === 'hour1') {
    dndStore.enableManual(DND_MANUAL_QUICK_MS)
    message.success(t('notify.dndManual.enabledHour1'))
    return
  }
  if (key === 'untilOff') {
    dndStore.enableManual()
    message.success(t('notify.dndManual.enabledUntilOff'))
  }
}

// 从 Layout.vue 注入共享状态
const aheadBehindMap = inject<Ref<Record<string, { ahead: number; behind: number }>>>('sharedAheadBehindMap', ref({}))
const remoteLoading = inject<Ref<boolean>>('sharedRemoteLoading', ref(false))
const fetchAllAheadBehind = inject<() => Promise<void>>('sharedFetchAllAheadBehind', async () => {})
const showGitPanel = inject<() => void>('showGitPanel', () => {})

// TopBar 冲突解决：从 Layout 注入 composable 的远程操作函数，替代内联实现
const handleFetch = inject<() => Promise<void>>('sharedHandleFetch', async () => {})
const handlePull = inject<() => Promise<void>>('sharedHandlePull', async () => {})
const handleCreatePr = inject<() => Promise<void>>('sharedHandleCreatePr', async () => {})

const emit = defineEmits<{
  openCommandPalette: []
  openPushDialog: []
  showCloneModal: []
  showTaskRunner: []
  showRemoveConfirm: []
  openHelp: []
  openQrRelay: []
}>()

// 跨平台修饰键标签：macOS 显示 ⌘，其它平台显示 Ctrl
const isMacPlatform = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')
const modKeyLabel = isMacPlatform ? '⌘' : 'Ctrl'

const currentAheadBehind = computed(() =>
  aheadBehindMap.value[projectStore.currentProjectId || ''] || { ahead: 0, behind: 0 },
)

const projectSelectOptions = computed(() =>
  projectStore.projects.map((p) => {
    const ab = aheadBehindMap.value[p.id] || { ahead: 0, behind: 0 }
    return {
      label: p.name,
      value: p.id,
      branch: p.currentBranch || t('toolbar.noBranch'),
      ahead: ab.ahead,
      behind: ab.behind,
      valid: p.valid,
    }
  }),
)

const currentProjectValue = computed({
  get: () => projectStore.currentProjectId,
  set: (val: string) => {
    projectStore.selectProject(val)
  },
})

// 项目快速切换模糊搜索：项目名 / 分支名大小写不敏感子串匹配
function filterProject(pattern: string, option: SelectOption) {
  const q = pattern.trim().toLowerCase()
  if (!q) return true
  const o = option as { label?: string; branch?: string }
  return (o.label || '').toLowerCase().includes(q)
    || (o.branch || '').toLowerCase().includes(q)
}

function renderProjectLabel(option: { label: string; valid?: boolean; branch?: string; ahead?: number; behind?: number }) {
  const accentRed = 'var(--accent-red)'
  const textBody = 'var(--text-body)'
  const textDim = 'var(--text-dim)'
  const green = 'var(--accent-green-dim)'
  // 选项内容在窄选择器里会 ellipsis（项目名/分支名皆可能截断）：逐段补 title，
  // 悬停即可看全名；分支段是 audit 里「122 vs 171px」无查看途径的锚点
  const children = [
    h('span', { style: option.valid === false ? `color: ${accentRed}; font-weight: 500` : `color: ${textBody}; font-weight: 500`, title: option.label }, option.label),
  ]
  if (option.valid === false) {
    children.push(h('span', { style: `color: ${accentRed}; font-size: 11px; border: 1px solid ${accentRed}; border-radius: 3px; padding: 0 4px` }, t('layout.invalidPath')))
  } else {
    children.push(h('span', { style: `color: ${textDim}; font-size: 12px`, title: option.branch || undefined }, `(${option.branch})`))
  }
  if (option.ahead && option.ahead > 0) children.push(h('span', { style: `color: ${green}; font-size: 11px` }, `↑${option.ahead}`))
  if (option.behind && option.behind > 0) children.push(h('span', { style: `color: ${accentRed}; font-size: 11px` }, `↓${option.behind}`))
  return h('div', { style: 'display: flex; align-items: center; gap: 6px; padding: 2px 0; font-size: 13px' }, children)
}

// 工具栏"更多操作"下拉菜单：桌面只收低频项目操作；窄屏（P-20261019-7）
// 把顶栏其余动作一并收进来（远程三键/任务/帮助/二维码/布局锁/系统锁/
// 免打扰），保证 390px 宽度零横向裁切且功能不丢
const moreActionsOptions = computed(() => {
  const base = [
    { label: t('toolbar.clone'), key: 'clone', icon: () => h(NIcon, null, { default: () => h(DuplicateOutline) }) },
    { label: t('layout.createPr'), key: 'pr', icon: () => h(NIcon, null, { default: () => h(OpenOutline) }) },
    { type: 'divider', key: 'd1' } as const,
    { label: t('layout.removeProject'), key: 'remove', icon: () => h(NIcon, null, { default: () => h(TrashOutline) }) },
  ]
  if (!compactTopbar.value) return base

  const remote = [
    { label: t('toolbar.fetch'), key: 'fetch', disabled: remoteLoading.value, icon: () => h(NIcon, null, { default: () => h(CloudDownloadOutline) }) },
    { label: t('toolbar.pull'), key: 'pull', disabled: remoteLoading.value, icon: () => h(NIcon, null, { default: () => h(ArrowDownCircleOutline) }) },
    { label: t('toolbar.push'), key: 'push', disabled: remoteLoading.value, icon: () => h(NIcon, null, { default: () => h(CloudUploadOutline) }) },
  ]
  const tools = [
    { label: t('taskRunner.title'), key: 'task', icon: () => h(NIcon, null, { default: () => h(PlayOutline) }) },
    { label: t('help.title'), key: 'help', icon: () => h(NIcon, null, { default: () => h(HelpCircleOutline) }) },
    { label: t('qr.relay.title'), key: 'qr', icon: () => h(NIcon, null, { default: () => h(QrCodeOutline) }) },
    // 布局锁菜单项补图钉图标（P-20261107-1）：与下一项「锁定系统」的 LockClosed
    // 拉开同形混淆；实心/描边随当前态，与顶栏布局锁按钮双态一致
    { label: layoutLock.locked ? t('layout.unlockLayoutShort') : t('layout.lockLayoutShort'), key: 'layoutLock', icon: () => h(NIcon, null, { default: () => h(layoutLock.locked ? Pin : PinOutline) }) },
    { label: t('layout.lock'), key: 'lock', icon: () => h(NIcon, null, { default: () => h(LockClosedOutline) }) },
  ]
  // 免打扰在移动端没有悬浮档位入口，按激活态给「关闭」或两档快捷开启
  const dnd = isManualDndActive(dndStore.manualUntil)
    ? [{ label: t('notify.dndManual.turnOff'), key: 'dndOff', icon: () => h(NIcon, null, { default: () => h(MoonOutline) }) }]
    : [
        { label: t('notify.dndManual.hour1'), key: 'dndHour1', icon: () => h(NIcon, null, { default: () => h(MoonOutline) }) },
        { label: t('notify.dndManual.untilOff'), key: 'dndUntilOff', icon: () => h(NIcon, null, { default: () => h(MoonOutline) }) },
      ]
  return [...remote, { type: 'divider', key: 'd2' } as const, ...tools, ...dnd, { type: 'divider', key: 'd3' } as const, ...base]
})

function handleMoreAction(key: string) {
  if (key === 'clone') emit('showCloneModal')
  else if (key === 'pr') handleCreatePr()
  else if (key === 'remove') emit('showRemoveConfirm')
  else if (key === 'fetch') void handleFetch()
  else if (key === 'pull') void handlePull()
  else if (key === 'push') emit('openPushDialog')
  else if (key === 'task') emit('showTaskRunner')
  else if (key === 'help') emit('openHelp')
  else if (key === 'qr') emit('openQrRelay')
  else if (key === 'layoutLock') layoutLock.toggle()
  else if (key === 'lock') lockStore.lock()
  else if (key === 'dndOff') {
    dndStore.disableManual()
    message.info(t('notify.dndManual.disabled'))
  } else if (key === 'dndHour1') {
    dndStore.enableManual(DND_MANUAL_QUICK_MS)
    message.success(t('notify.dndManual.enabledHour1'))
  } else if (key === 'dndUntilOff') {
    dndStore.enableManual()
    message.success(t('notify.dndManual.enabledUntilOff'))
  }
}

// 暴露给 Layout.vue，远程操作函数由 composable 注入提供
defineExpose({ handlePull, handleFetch })
</script>

<template>
  <div class="ide-header">
    <!-- 返回首页 -->
    <ToolButton
      size="small"
      variant="ghost"
      :title="t('layout.backHome')"
      @click="router.push('/')"
    >
      <n-icon size="14">
        <HomeOutline />
      </n-icon>
    </ToolButton>

    <!-- 项目选择器 -->
    <n-select
      v-model:value="currentProjectValue"
      :options="projectSelectOptions"
      :placeholder="t('layout.selectProject')"
      size="small"
      class="header-project-select"
      :render-label="renderProjectLabel"
      filterable
      :filter="filterProject"
    />

    <!-- 分支胶囊（窄屏收进状态栏/Git 面板入口） -->
    <BranchCapsule
      v-if="projectStore.currentProject"
      class="header-branch"
      :ahead="currentAheadBehind.ahead"
      :behind="currentAheadBehind.behind"
      @new-branch="showGitPanel()"
      @branch-changed="(name: string) => { message.success(t('git.checkedOut', { name })); fetchAllAheadBehind() }"
    />

    <!-- 命令面板搜索触发器 -->
    <button
      class="header-search-trigger"
      :title="t('commandPalette.title')"
      :aria-label="t('commandPalette.title')"
      @click="emit('openCommandPalette')"
    >
      <n-icon size="12">
        <SearchOutline />
      </n-icon>
      <span class="search-placeholder">{{ t('commandPalette.title') }}</span>
      <kbd class="search-kbd">{{ modKeyLabel }} K</kbd>
    </button>

    <div style="flex: 1" />

    <!-- 远程动作组 -->
    <div class="header-btn-group">
      <button
        class="grouped-btn"
        :disabled="remoteLoading"
        :title="t('toolbar.fetch')"
        @click="handleFetch"
      >
        <n-icon size="13" data-icon-action="git.fetch">
          <CloudDownloadOutline />
        </n-icon>
        <span class="grouped-label">{{ t('toolbar.fetch') }}</span>
      </button>
      <button
        class="grouped-btn"
        :disabled="remoteLoading"
        :title="t('toolbar.pull')"
        @click="handlePull"
      >
        <n-icon size="13" data-icon-action="git.pull">
          <ArrowDownCircleOutline />
        </n-icon>
        <span class="grouped-label">{{ t('toolbar.pull') }}</span>
      </button>
      <button
        class="grouped-btn primary"
        :disabled="remoteLoading"
        :title="t('toolbar.push')"
        @click="emit('openPushDialog')"
      >
        <n-icon size="13" data-icon-action="git.push">
          <CloudUploadOutline />
        </n-icon>
        <span class="grouped-label">{{ t('toolbar.push') }}</span>
      </button>
    </div>

    <div class="header-divider" />

    <!-- 更多操作 -->
    <n-dropdown
      trigger="click"
      :options="moreActionsOptions"
      placement="bottom-end"
      @select="handleMoreAction"
    >
      <ToolButton
        size="small"
        variant="ghost"
        :title="t('layout.moreActions')"
        :aria-label="t('layout.moreActions')"
        data-testid="topbar-more"
      >
        <n-icon size="14" data-icon-action="common.more">
          <EllipsisHorizontalOutline />
        </n-icon>
      </ToolButton>
    </n-dropdown>

    <div class="header-divider" />

    <!-- 任务运行器（窄屏收进「更多」） -->
    <ToolButton
      size="small"
      variant="ghost"
      class="header-task"
      :title="t('taskRunner.title')"
      @click="emit('showTaskRunner')"
    >
      <n-icon size="14">
        <PlayOutline />
      </n-icon>
    </ToolButton>

    <!-- 通知中心 -->
    <div class="notify-wrap">
      <ToolButton
        size="small"
        variant="ghost"
        :title="t('notification.title')"
        @click="notificationStore.open()"
      >
        <n-icon size="14">
          <NotificationsOutline />
        </n-icon>
      </ToolButton>
      <span
        v-if="notificationStore.unreadCount > 0"
        class="notify-badge"
      >{{ formatBadgeCount(notificationStore.unreadCount) }}</span>
    </div>

    <!-- 临时免打扰快速档（P-20261003-227）：铃铛旁月亮 toggle——会议/专注场景
         即时静默（时段规则外的手动档，与时段规则 OR 组合）。active 态高亮 +
         title 带剩余时长；开启中下拉收敛为「关闭」档，到期/手动关自动恢复 -->
    <n-dropdown
      trigger="click"
      placement="bottom-end"
      :options="dndMenuOptions"
      @select="handleDndMenu"
    >
      <ToolButton
        size="small"
        variant="ghost"
        class="header-dnd"
        :active="isManualDndActive(dndStore.manualUntil)"
        :title="dndToggleTitle"
        data-testid="topbar-dnd-toggle"
      >
        <n-icon size="14">
          <MoonOutline />
        </n-icon>
      </ToolButton>
    </n-dropdown>

    <!-- 帮助中心（常见问题 + 智能体可查询同一数据源；窄屏收进「更多」） -->
    <ToolButton
      size="small"
      variant="ghost"
      class="header-help"
      :title="t('help.title')"
      @click="emit('openHelp')"
    >
      <n-icon size="14">
        <HelpCircleOutline />
      </n-icon>
    </ToolButton>

    <!-- 二维码接力（手机扫码打开当前页；命令面板「在手机上打开」同功能） -->
    <ToolButton
      size="small"
      variant="ghost"
      class="header-qr"
      :title="t('qr.relay.title')"
      data-testid="topbar-qr-relay"
      @click="emit('openQrRelay')"
    >
      <n-icon size="14">
        <QrCodeOutline />
      </n-icon>
    </ToolButton>

    <!-- 布局锁定（P-20261003-180）：锁定时分隔条/tab/树拖拽统一短路，点击与键盘不受影响；
         active 态 + 开/合图标切换做状态反馈，命令面板「toggle-layout-lock」同源。
         图标是图钉双态（P-20261107-1）：「钉住布局防误拖」语义直译（终端 tab 置顶
         同族），实心 Pin=已钉住 / 描边 PinOutline=未钉；原与安全域「锁定系统」共用
         LockClosed/LockOpen——两个语义完全不同的锁（锁整机 vs 防误拖）同形易混 -->
    <ToolButton
      size="small"
      variant="ghost"
      class="header-layout-lock"
      :active="layoutLock.locked"
      :title="layoutLock.locked ? t('layout.layoutLockOff') : t('layout.layoutLockOn')"
      data-testid="topbar-layout-lock"
      @click="layoutLock.toggle()"
    >
      <n-icon size="14">
        <Pin v-if="layoutLock.locked" />
        <PinOutline v-else />
      </n-icon>
    </ToolButton>

    <!-- 锁定系统（窄屏收进「更多」） -->
    <ToolButton
      size="small"
      variant="ghost"
      class="header-lock"
      :title="t('layout.lock')"
      @click="lockStore.lock()"
    >
      <n-icon size="14">
        <LockClosedOutline />
      </n-icon>
    </ToolButton>
  </div>
</template>

<style scoped>
.ide-header {
  height: 40px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border-default);
  padding: 0 var(--space-3);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-shrink: 0;
}

.header-divider {
  width: 1px;
  height: 18px;
  background: var(--border-subtle);
}

.header-project-select { width: 220px; min-width: 160px; }

.header-search-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 13px;
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 12px;
  cursor: pointer;
  transition: all var(--motion-base);
  max-width: 280px;
}
.header-search-trigger:hover {
  border-color: var(--brand-accent);
  background: var(--bg-hover);
  color: var(--text-secondary);
}
.header-search-trigger .search-placeholder {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.header-search-trigger .search-kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 1px 5px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--bg-canvas);
  color: var(--text-secondary);
  letter-spacing: 0.05em;
}

.header-btn-group {
  display: inline-flex;
  align-items: center;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  padding: 2px;
  gap: 1px;
}
.grouped-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 24px;
  padding: 0 10px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: var(--font-ui);
  cursor: pointer;
  border-radius: var(--radius-md);
  transition: all var(--motion-base);
}
.grouped-btn:hover:not(:disabled) {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.grouped-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.grouped-btn.primary {
  background: var(--brand-accent);
  color: var(--bg-primary);
}
.grouped-btn.primary:hover:not(:disabled) {
  background: var(--brand-accent-hover);
  color: var(--bg-primary);
}
.grouped-label { line-height: 1; white-space: nowrap; }

/* 窄视口：同步动作组收成图标按钮（title 提供 tooltip）——
   CJK 两字标签在挤压下会逐字竖排换行，比溢出更刺眼；
   同时收窄项目选择器、隐藏命令面板快捷键徽标，消除顶栏横向溢出 */
@media (max-width: 1100px) {
  .header-btn-group .grouped-label { display: none; }
  .header-btn-group .grouped-btn { padding: 0 var(--space-2); }
  .header-project-select { width: 160px; min-width: 120px; }
  .header-search-trigger { max-width: 180px; }
  .header-search-trigger .search-kbd { display: none; }
}

/* 顶栏紧凑档（P-20261019-7，≤900px）：任务/免打扰/帮助/二维码/布局锁/
   系统锁收进「更多」下拉（moreActionsOptions 的 compactTopbar 分支），
   远程三键保留图标档、项目选择器收窄——768px 平板原来溢出 29px */
@media (max-width: 900px) {
  .header-task,
  .header-dnd,
  .header-help,
  .header-qr,
  .header-layout-lock,
  .header-lock { display: none; }
  .header-project-select { width: 140px; min-width: 100px; }
}

/* 窄屏顶栏（P-20261019-7，≤700px）：在上档基础上再把远程三键/分支胶囊
   收进「更多」，只留返回、项目选择、搜索、通知与更多；搜索压成图标，
   项目选择器吃剩余宽度。overflow: hidden 是兜底——任何未来新增按钮都
   不会再把文档撑出横向滚动 */
@media (max-width: 700px) {
  .ide-header {
    gap: var(--space-1);
    padding: 0 var(--space-2);
    overflow: hidden;
  }
  .header-branch,
  .header-btn-group { display: none; }
  .header-project-select {
    flex: 1 1 auto;
    width: auto;
    min-width: 0;
    max-width: none;
  }
  .header-search-trigger {
    width: 28px;
    min-width: 28px;
    max-width: 28px;
    padding: 0;
    justify-content: center;
    border-color: transparent;
    background: transparent;
  }
  .header-search-trigger .search-placeholder,
  .header-search-trigger .search-kbd { display: none; }
}

.notify-wrap { position: relative; display: inline-flex; }
.notify-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: var(--radius-md);
  background: var(--accent-red);
  color: var(--text-on-accent);
  font-size: 9px;
  font-weight: var(--fw-semibold);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--bg-panel);
  pointer-events: none;
}
</style>
