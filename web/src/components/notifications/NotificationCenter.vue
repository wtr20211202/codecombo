<script setup lang="ts">
// 通知中心：全局浮窗（挂载于 App.vue，跨页面共享）
// 数据来自全局 useNotificationStore；支持分类筛选 + 点击跳转
//
// P-20261007-23 分域拆解后本组件是布局壳 + 组合根：过滤域（useNotifyFilters，
// 三维过滤/计数/清空语义/持久化收口）、免打扰域（useNotifyDnd，窗口判定与
// 解除摘要）、列表域（useNotifyList，组聚合/键盘导航/触屏滑动/滚动已读）、
// 行呈现（NotificationRow，行内动作注册表）各居独立落点——通知域后续增量
// 按域落文件，不再共用单文件串行。壳内保留的是跨域装配（组合根）、头部
// 动作、批量操作域（P-281 状态机 + 动作执行）、未读分界线（P-259）与
// Esc/开合生命周期。
import { computed, nextTick, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { NIcon, NEmpty, createDiscreteApi } from 'naive-ui'
import { CheckmarkDoneOutline, TrashOutline, CloseOutline, NotificationsOutline, SettingsOutline, CalendarOutline, MoonOutline, CheckboxOutline, Checkbox, Remove, SwapHorizontalOutline } from '@vicons/ionicons5'
import { useNotificationStore } from '../../stores/notification'
import { useUIStateStore } from '../../stores/uiState'
import { useInstanceStore } from '../../stores/instance'
import { useReportArchiveStore } from '../../stores/reportArchive'
import { useThemeStore } from '../../stores/theme'
import { useDndStore } from '../../stores/dnd'
import { useDesktopNotify } from '../../composables/useDesktopNotify'
import { useBatchSelect } from '../../composables/useBatchSelect'
import { useNotifyDnd } from '../../composables/useNotifyDnd'
import { useNotifyFilters } from '../../composables/useNotifyFilters'
import { useNotifyList, type NavRow } from '../../composables/useNotifyList'
import type { NotificationItem } from '../../api/client'
import { useI18n } from '../../composables/useI18n'
import { agentLabelOf } from '../../composables/useApprovalActions'
import { useDeployLogDownload } from '../../composables/useDeployLogDownload'
import { confirmDialog } from '../../composables/useDialog'
import { copyText } from '../../utils/clipboard'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { OPEN_SETTINGS_EVENT } from '../../utils/openSettings'
import { countNewSince, lastNewRowIndex } from '../../utils/notifUnreadDivider'
import { notifPlainText } from '../../utils/notifText'
import { snoozeUntilFor, formatSnoozeUntil } from '../../utils/notifSnooze'
import NotificationRow from './NotificationRow.vue'
import DailyReportHistory from './DailyReportHistory.vue'
import HandoverPackageModal from '../monitor/HandoverPackageModal.vue'

const store = useNotificationStore()
const themeStore = useThemeStore()
const dndStore = useDndStore()
const instanceStore = useInstanceStore()
const { t } = useI18n()
const { notify } = useDesktopNotify()

// 日报历史回看面板（P-20261003-4）：头部入口开合走 reportArchive store
// （P-20261004-96 起与值班大屏热力图格子下钻两路共写同一状态），本组件只发
// 普通打开诉求（打开期间 Esc 让位给面板先关）
const archiveStore = useReportArchiveStore()
// 值班交接包弹窗（P-20261005-148）：头部入口——换班场景从通知中心一跳直达
// （与值班大屏共用同一自包含弹层组件，数据装配在弹窗内）
const showHandover = ref(false)
// 离散 message（TopBar/useEditorCopyPath 同范式）：Shift+A 批量已读的轻确认
// 不依赖祖先 NMessageProvider
const { message } = createDiscreteApi(['message'], {
  configProviderProps: computed(() => ({
    theme: themeStore.naiveTheme,
    themeOverrides: themeStore.naiveOverrides,
  })),
})
// 部署通知「下载日志」行内入口（P-20261003-142）：本组件不经 NMessageProvider
// 挂载，离散 message 注入下载链（composable 缺省的 useMessage 在此会拿不到 provider）
const { downloadLog: downloadDeployLog } = useDeployLogDownload(message)

// 免打扰域与过滤域互为输入（摘要计数按「项目+runtime 过滤后子集」口径 /
// 过滤流水线末端叠加 dndOnly 过滤视图），baseItems 以惰性 getter 解环：
// getter 在 computed 求值期才执行，彼时 filtersDomain 已装配完成（闭包内
// 引用晚于声明的绑定，TDZ 安全）。两域 composable 面向结构化 store 接口
// （state 走 Ref、动作走函数）——Pinia 解包后的 store.state 是裸数组，
// 经 storeToRefs 还原 Ref 形态供给
const { items: storeItems, showPanel: storeShowPanel } = storeToRefs(store)
const dndDomain = useNotifyDnd({
  store,
  prefs: () => dndStore.prefs,
  baseItems: () => filtersDomain.runtimeFilteredItems.value,
})
const filtersDomain = useNotifyFilters({
  store: {
    items: storeItems,
    isSnoozed: store.isSnoozed,
    clear: store.clear,
    dismissMany: store.dismissMany,
  },
  dnd: { dndOnly: dndDomain.dndOnly, inDndWindow: dndDomain.inDndWindow },
})
const {
  filters, activeFilter, activeProject, activeRuntime,
  projectOptions, runtimeOptions, projectSelectTitle,
  filteredItems, filterCounts, clearTitle, clearCurrent,
} = filtersDomain
const {
  dndOnly, dndMissedCount, showDndSummary, toggleDndOnly, closeDndSummary,
} = dndDomain

// 多选批量操作（P-20261003-281）：checkbox 模式——组级清除与 Shift+A 全部已读
// 之间的「选 N 条批量已读/删除」粒度。选择状态机抽在 useBatchSelect（P-281
// 抽件、P-20261005-175 起泛型共享：选中集按条目 id 记账，与分组/过滤正交；
// 条目移除自动剪除失联 id；退出模式/面板关闭清空），本组件只承接模式开关、
// 动作执行与 UI 呈现
const selectMode = ref(false)
const {
  selectedIds: batchSelectedIds, toggle: batchToggle, toggleMany: batchToggleMany,
  stateOf: batchStateOf, isSelected: batchIsSelected,
} = useBatchSelect(computed(() => store.items), selectMode)
// 当前筛选视图的全量 id（filteredItems 是扁平条目流水，组是派生视图）——
// 「全选当前列表」的语义边界：只勾所见，不越过滤扩大到隐藏条目
const filteredIds = computed(() => filteredItems.value.map(n => n.id))
const viewCheckState = computed(() => batchStateOf(filteredIds.value))
const batchSelectedCount = computed(() => batchSelectedIds.value.size)
// 批量已读按钮可用性：选中集中还有未读才可点（全已读时置灰，动作语义归零）
const batchUnreadCount = computed(() =>
  store.items.filter(n => batchSelectedIds.value.has(n.id) && !n.read).length)

/** 行的勾选态：组行 = 全体成员聚合（some 三态），组员/单条行 = 本条二态 */
function rowCheckState(row: NavRow): 'all' | 'some' | 'none' {
  if (row.kind === 'group') return batchStateOf(row.g.members.map(m => m.id))
  return batchIsSelected(row.m.id) ? 'all' : 'none'
}
function rowSelected(row: NavRow): boolean {
  return rowCheckState(row) !== 'none'
}
/** checkbox/行点击共用的「切换本行选中」：组行整体成员、组员行单条 */
function toggleRowSelection(row: NavRow): void {
  if (row.kind === 'group') batchToggleMany(row.g.members.map(m => m.id))
  else batchToggle(row.m.id)
}

// 列表域装配：组聚合/键盘导航/滑动手势/滚动已读（行内呈现见 NotificationRow）
const cardRef = ref<HTMLElement>()
const listRef = ref<HTMLElement>()
const listDomain = useNotifyList({
  store: {
    handleClick: store.handleClick,
    markRead: store.markRead,
    dismiss: store.dismiss,
    showPanel: storeShowPanel,
  },
  filteredItems,
  rootRef: cardRef,
  listRef,
  selectMode,
  toggleRowSelection,
  resetOn: [activeFilter, activeProject, activeRuntime, dndOnly],
})
const {
  flatRows, activeIdx, expandedGroups, activateItem, activateRow, resetActive,
  onTouchStart, onTouchMove, onTouchEnd, onTouchCancel, swipeStyle, isSwiping,
} = listDomain

// 批量已读：本地先行同步置位 + 每条 API fire-and-forget（markRead 内部自带
// 静默 catch，同 markGroupRead 的逐条幂等口径；并发而非串行——列表 ≤200 条
// 上限内的一次性动作，不必逐条 await 拖长完成反馈）
function batchMarkReadSelected(): void {
  const targets = store.items.filter(n => batchSelectedIds.value.has(n.id) && !n.read)
  if (targets.length === 0) return
  for (const n of targets) void store.markRead(n.id)
  message.success(t('notification.batch.markReadDone', { n: targets.length }))
}

// 批量删除：破坏性动作先确认（与 clearCurrent 同惯例），走既有 dismissMany
// 批量通道；选中集中已消失的 id 由选择状态机对账剪除后自然不出现
async function batchRemoveSelected(): Promise<void> {
  const ids = [...batchSelectedIds.value]
  if (ids.length === 0) return
  const ok = await confirmDialog({
    title: t('notification.batch.remove'),
    content: t('notification.batch.removeConfirm', { n: ids.length }),
    type: 'warning',
  })
  if (!ok) return
  await store.dismissMany(ids)
  message.success(t('notification.batch.removeDone', { n: ids.length }))
}

// 未读分界线（P-20261003-259）：「上次查看后新增 N 条」——上次查看时点取面板
// 关闭时刻（打开期间到的新条目仍在本次视线外为之「未看」，关闭即推进基线）。
// 时点持久在 uiState notificationCenter.lastSeenAt（实例维度，跨刷新/跨标签
// 延续）；无基线（首次使用/旧数据面）不显示分界，关闭一次面板后自然生效。
// 读取在挂载/打开/实例切换时刷新；写入即内存先行 + 静默补丁（uiState 既有
// 即时写范式，后端失败由关页 forceSave 兜底）
const uiStateStore = useUIStateStore()
const lastSeenAt = ref(0)
function noteLastSeen(ts: number): void {
  // 单调推进：跨标签页他页已关闭推进的基线不被本页旧值回退（同机时钟）
  if (Number.isFinite(ts) && ts > lastSeenAt.value) lastSeenAt.value = ts
}
async function refreshLastSeen(): Promise<void> {
  noteLastSeen(await uiStateStore.getNotificationLastSeenAt())
}
function markLastSeenNow(): void {
  const ts = Math.max(Date.now(), lastSeenAt.value)
  lastSeenAt.value = ts
  void uiStateStore.saveNotificationLastSeenAt(ts)
}
// 分界计数/落点（P-20261003-259）：从当前过滤视图（filteredItems）与派生行序
// （flatRows）现场计算——与分类/项目/runtime/免打扰各过滤维正交，切页签后
// 界线随可见条目走；聚合组行代表取组内最新成员，分界插在最后一条新行之后
//（全为新时落列表末尾，仍给出量化提示）
const newSinceCount = computed(() => countNewSince(filteredItems.value, lastSeenAt.value))
const dividerAfterIdx = computed(() => {
  if (newSinceCount.value === 0) return -1
  return lastNewRowIndex(
    flatRows.value.map(row => row.kind === 'member' ? row.m.time : row.g.item.time),
    lastSeenAt.value,
  )
})

const unreadCount = computed(() => store.unreadCount)

// 稍后提醒（P-20261003-36）：三档菜单在行组件内渲染（NotificationRow），选择
// 上行至此统一执行——前端算好绝对时刻传服务端打标（snoozeUntil），到点重挂
// 由服务端巡检推送
async function snoozeItem(n: NotificationItem, key: string | number): Promise<void> {
  const until = snoozeUntilFor(key)
  await store.snooze(n.id, until)
  message.success(t('notification.snooze.done', { time: formatSnoozeUntil(until) }))
}

function cancelSnooze(n: NotificationItem): void {
  void store.snooze(n.id, '')
  message.success(t('notification.snooze.cancelDone'))
}

// 项目×类别二维静音（P-20261003-168）：条目行快捷「静音此项目此类」——刷屏
// 治理的就地入口，作用于入账面（该组合后续通知不再产生），已入账条目不追溯
// 隐藏（解除在设置·通知·项目静音管理）。类别名映射：登记过的五类别走 i18n，
// 未登记类别（扩展面）原样展示
const KNOWN_CATEGORIES = new Set(['git', 'task', 'clone', 'system', 'error', 'drop'])
function categoryLabel(category: string): string {
  return KNOWN_CATEGORIES.has(category) ? t(`notification.category.${category}`) : category
}
async function muteProject(n: NotificationItem): Promise<void> {
  if (!n.projectId) return
  await store.muteProjectCategory(n.projectId, n.category)
  message.success(t('notification.projectMute.done', {
    name: n.projectName || n.projectId,
    category: categoryLabel(n.category),
  }))
}

// 条目复制（P-20261003-188）：错误类通知（部署失败摘要）转述给 agent/记录——
// errorLog 有复制、通知没有。title+body 纯文本入剪贴板（utils/clipboard
// copyText 降级链——健壮性红线，禁裸 navigator.clipboard）；纯文本由
// utils/notifText 的 notifPlainText 组装（与行渲染链 notifTitle/notifBody
// 同一实现——所见即所复制不因链接化/模板化漂移），轻提示经本壳的离散 message
async function copyNotif(n: NotificationItem): Promise<void> {
  if (await copyText(notifPlainText(n, t))) {
    message.success(t('notification.copy.done'))
  } else {
    message.error(t('common.copyFailed'))
  }
}

// 部署通知「下载日志」事件上行落点：discrete message 实例在本壳（见上方
// useDeployLogDownload 注记），行组件只做 taskId 识别
function downloadDeployLogById(taskId: string) {
  void downloadDeployLog(taskId)
}

// 桌面通知：监听新通知，仅在 error/warning + 页面 hidden 时弹
watch(() => store.items[0]?.id, (newId) => {
  if (!newId) return
  const n = store.items[0]
  if (!n) return
  // 到点重挂不重弹桌面通知（P-20261003-36）：重挂也换序会触发本 watch，
  // 消费 snoozeDue 一次性标记命中即静默（徽标已由未读计数承担提醒）
  if (store.consumeRemount(n.id)) return
  if (!store.prefs.desktopNotify) return
  if (n.type === 'error' || n.type === 'warning') {
    // 携带条目类别（P-20261003-115）：免打扰例外类别按归属判定穿透；
    // 携带条目分级（P-20261004-117）：error 级穿透勿扰仍提醒（可关为绝对静默）
    // 携带条目跳转落点（P-20261004-121）：error 级条目（failed 任务/审批超时）
    // 经本 watch 弹的桌面通知与 agentTaskNotify 直发链共用 tag 槽、后到者替换
    //（store.add 走服务端往返，条目回流的 watch 晚于直发）——不透传会把直发链
    // 携带的点击直达数据冲掉。仅 terminal 动作有本地落点（switch-instance/panel/
    // url 等不在此展开，点击维持仅聚焦现状）
    notify(n.title, n.body, n.category, n.type, n.action === 'terminal' ? n.actionPayload : undefined)
  }
})

watch(() => store.showPanel, (open, wasOpen) => {
  if (open) {
    dndDomain.refreshClock() // 免打扰窗口按打开时刻重算（nowMs 时钟锚刷新）
    void refreshLastSeen() // 打开即读：跨标签页/跨刷新推进的基线同步进来
    nextTick(() => cardRef.value?.focus())
  } else {
    resetActive()
    selectMode.value = false // 面板关闭即退出多选（选择集由状态机一并清空）
    // 上次查看时点 = 面板关闭时刻（P-20261003-259）：本次浏览的条目下回不再算新增
    if (wasOpen) markLastSeenNow()
  }
})
// 实例切换：分界线随通知归属实例切换（旧实例时点不串用），新实例按需重读
watch(() => instanceStore.currentInstanceId, () => {
  lastSeenAt.value = 0
  void refreshLastSeen()
})

// 键盘导航：↑↓ 在扁平行序列环绕移动 + Enter/Space 激活（行序与激活语义在
// useNotifyList），此处是面板根节点的按键分发壳：筛选页签环绕、Shift+A 全部
// 已读、行激活三段按焦点上下文让位分流
function onCardKeydown(e: KeyboardEvent): void {
  const target = e.target as HTMLElement
  // 焦点在筛选页签上：←↑/→↓ 环绕切换页签，不联动列表高亮（Enter 走原生 click）
  if (target.closest('.nc-filters')) {
    // 项目下拉是原生 <select>：方向键展开/换选项、Enter 确认均走原生语义，
    // 不联动页签切换（焦点管理两套并存——按钮页签↑↓环绕，下拉原生）
    if (target.tagName === 'SELECT') return
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1
      const i = filters.findIndex(f => f.key === activeFilter.value)
      const next = filters[(i + delta + filters.length) % filters.length]
      if (next) activeFilter.value = next.key
    }
    return
  }
  // Shift+A 全部已读（P-20261002-119）：通知清理的键盘闭环——与头部「全部标记
  // 已读」按钮同动作（store.markAllRead 全量、不随筛选收窄），零未读时不动作
  // 为该按钮 disabled 的键盘等价；轻 toast 确认批量完成。焦点在筛选页签/项目
  // 下拉时让位：上方 .nc-filters closest 判定已先行 return，批量动作不与页签
  // 键盘语义抢键
  if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'a' || e.key === 'A')) {
    if (store.unreadCount > 0) {
      e.preventDefault()
      const n = store.unreadCount // markAllRead 同步置已读，计数须先取
      void store.markAllRead()
      message.success(t('notification.markAllReadDone', { n }))
    }
    return
  }
  const rows = flatRows.value
  if (rows.length === 0) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    const delta = e.key === 'ArrowDown' ? 1 : -1
    activeIdx.value = (activeIdx.value + delta + rows.length) % rows.length
  } else if (e.key === 'Enter' || e.key === ' ') {
    // 免打扰摘要行是可聚焦激活面（含其内关闭钮，closest 上溯命中）：
    // Enter/Space 走它自身的 click 语义，不联动列表行激活。runtime chips
    // 同口径（P-20261003-187）：原生按钮 Enter/Space 即 click，防二次触发。
    // body 路径可点态（P-20261004-61）同款：焦点在路径钮上 Enter/Space 走
    // 原生 click（打开文件），不联动所在行激活。第二动作小钮（P-20261005-150）
    // 同口径：原生按钮 Enter/Space 即 click（换槽派发第二动作），不联动行激活
    //（主动作钮不加此豁免——行激活与钮同义，第二动作语义不同必须豁免）。
    // 多选批量条/行勾选框（P-20261003-281）同口径：原生按钮 Enter/Space 即
    // click，防二次触发
    if (target.closest('.nc-action-btn, .nc-filter-btn, .nc-runtime-chip, .nc-dismiss, .nc-dnd-summary, .nc-body-path, .nc-batch-bar, .nc-check, .nc-second-action')) return
    e.preventDefault()
    const row = rows[activeIdx.value]
    if (row) activateRow(row)
  }
}

// 通知偏好快捷入口：关面板后打开设置并定位通知分区（深层组件 → 设置的
// 既有通道：window 事件，show 置位与 tab 定位由宿主/Modal 各自处理）
function openPrefs() {
  close()
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: 'notifications' }))
}

// Esc 关闭：与大纲/命令面板等弹层的关闭惯例一致（面板此前只能点遮罩/×关闭）；
// 有模态弹窗打开时让位（同 AgentTerminal onKeyDown 惯例）；日报历史面板打开时
// 同样让位——它自己监听 Esc 先关自己（后挂的 window 监听收不到已消费事件，
// 显式互斥防一次 Esc 连关两层）
function onWindowKeydown(e: KeyboardEvent) {
  if (!store.showPanel) return
  if (e.defaultPrevented) return // Layout 级已消费的 Esc（如退出最大化）不重复处理
  if (archiveStore.open) return // 日报历史面板打开：Esc 归它消费
  if (showHandover.value) return // 交接包弹窗打开：Esc 归它（NModal 自关）消费
  if (e.key === 'Escape') {
    if (hasBlockingOverlay()) return
    // 多选模式中第一段 Esc 先退多选（checkbox 惯例），再按才关面板——误入
    // 多选不必连面板一起丢
    if (selectMode.value) {
      e.preventDefault()
      selectMode.value = false
      return
    }
    e.preventDefault()
    close()
  }
}
onMounted(() => {
  window.addEventListener('keydown', onWindowKeydown)
  // 未读分界线基线（P-20261003-259）：锁定态读取失败静默回落 0，解锁后
  // 打开面板会再读一次；无基线不显示分界
  void refreshLastSeen()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

function close() { store.close() }
</script>

<template>
  <transition name="nc-fade">
    <div
      v-if="store.showPanel"
      class="nc-mask"
      @click.self="close"
    >
      <div
        ref="cardRef"
        class="nc-card glass-panel"
        data-testid="notif-center"
        tabindex="0"
        @keydown="onCardKeydown"
      >
        <!-- 头部 -->
        <div class="nc-header">
          <div class="nc-title">
            <n-icon
              size="14"
              class="nc-title-icon"
            >
              <NotificationsOutline />
            </n-icon>
            <span>{{ t('notification.title') }}</span>
            <span
              v-if="unreadCount > 0"
              class="nc-count"
            >{{ unreadCount }}</span>
          </div>
          <div class="nc-actions">
            <button
              class="nc-action-btn"
              :title="t('notification.openPrefs')"
              @click="openPrefs"
            >
              <n-icon size="13">
                <SettingsOutline />
              </n-icon>
            </button>
            <button
              class="nc-action-btn"
              data-testid="notif-archive-btn"
              :title="t('report.archive.open')"
              @click="archiveStore.openLatest()"
            >
              <n-icon size="13">
                <CalendarOutline />
              </n-icon>
            </button>
            <!-- 值班交接包（P-20261005-148）：换班场景从通知中心直达（值班大屏
                 同款弹层）；图标语义=现场交接（双向换手） -->
            <button
              class="nc-action-btn"
              data-testid="notif-handover-btn"
              :title="t('handover.buttonTitle')"
              @click="showHandover = true"
            >
              <n-icon size="13">
                <SwapHorizontalOutline />
              </n-icon>
            </button>
            <button
              class="nc-action-btn"
              :title="t('notification.markAllRead')"
              :disabled="unreadCount === 0"
              @click="store.markAllRead()"
            >
              <n-icon size="13">
                <CheckmarkDoneOutline />
              </n-icon>
            </button>
            <!-- 多选模式开关（P-20261003-281）：checkbox 模式入口，激活态高亮；
                 批量条只在模式内出现，退出（再点/Esc/关面板）即清空选择 -->
            <button
              class="nc-action-btn"
              :class="{ active: selectMode }"
              data-testid="notif-select-toggle"
              :title="selectMode ? t('notification.batch.exit') : t('notification.batch.enter')"
              @click="selectMode = !selectMode"
            >
              <n-icon size="13">
                <CheckboxOutline />
              </n-icon>
            </button>
            <button
              class="nc-action-btn danger"
              :title="clearTitle"
              :disabled="filteredItems.length === 0"
              @click="clearCurrent()"
            >
              <n-icon size="13">
                <TrashOutline />
              </n-icon>
            </button>
            <button
              class="nc-action-btn"
              :title="t('commandPalette.close')"
              @click="close"
            >
              <n-icon size="13">
                <CloseOutline />
              </n-icon>
            </button>
          </div>
        </div>

        <!-- 分类筛选 Tab（过滤域：三维状态/计数/清空语义在 useNotifyFilters） -->
        <div class="nc-filters">
          <button
            v-for="f in filters"
            :key="f.key"
            class="nc-filter-btn"
            :class="{ active: activeFilter === f.key }"
            @click="activeFilter = f.key"
          >
            {{ f.label }}
            <span
              v-if="f.key !== 'all' && (filterCounts[f.key] || 0) > 0"
              class="nc-filter-count"
              :class="{ 'is-unread': f.key === 'unread' }"
            >{{ filterCounts[f.key] }}</span>
          </button>
          <!-- 项目维过滤：与分类页签正交叠加；有项目通知才出现，无则整行不占位 -->
          <select
            v-if="projectOptions.length > 0"
            v-model="activeProject"
            class="nc-project-select"
            :title="projectSelectTitle"
          >
            <option value="">
              {{ t('notification.projectFilter.all') }}
            </option>
            <option
              v-for="p in projectOptions"
              :key="p.id"
              :value="p.id"
            >
              {{ p.name }}
            </option>
          </select>
        </div>

        <!-- runtime 过滤 chips（P-20261003-187）：条目携带的运行时去重成候选
             （动态清单，无 runtime 条目的通知不产生本行）；与分类页签/项目维
             AND 叠加，「全部运行时」即恢复档。chip 文案走 agentLabelOf 既有
             运行时显示名（claude→Claude Code 等，未知值原样展示） -->
        <div
          v-if="runtimeOptions.length > 0"
          class="nc-runtime-chips"
          data-testid="notif-runtime-chips"
        >
          <button
            class="nc-runtime-chip"
            :class="{ active: activeRuntime === '' }"
            data-testid="notif-runtime-chip-all"
            :title="t('notification.runtimeFilter.label')"
            @click="activeRuntime = ''"
          >
            {{ t('notification.runtimeFilter.all') }}
          </button>
          <button
            v-for="rt in runtimeOptions"
            :key="rt"
            class="nc-runtime-chip"
            :class="{ active: activeRuntime === rt }"
            :data-testid="'notif-runtime-chip-' + rt"
            @click="activeRuntime = rt"
          >
            {{ agentLabelOf(rt, rt) }}
          </button>
        </div>

        <!-- 免打扰解除摘要行（P-20261003-64，判定域在 useNotifyDnd）：时段结束
             后面板顶部提示窗口期内入账条数；点击切换「仅显窗口内条目」过滤
             视图（激活态保留指示），退出/关闭后本会话消隐。过滤生效时清空
             按钮只清当前筛选结果 -->
        <div
          v-if="showDndSummary"
          class="nc-dnd-summary"
          :class="{ active: dndOnly }"
          data-testid="notif-dnd-summary"
          role="button"
          tabindex="0"
          :title="t('notification.dndSummary.view')"
          @click="toggleDndOnly"
          @keydown.enter.prevent="toggleDndOnly"
          @keydown.space.prevent="toggleDndOnly"
        >
          <n-icon
            size="12"
            class="nc-dnd-icon"
          >
            <MoonOutline />
          </n-icon>
          <span class="nc-dnd-text">{{ t('notification.dndSummary.count', { n: dndMissedCount }) }}</span>
          <button
            class="nc-dnd-close"
            data-testid="notif-dnd-summary-close"
            :title="t('notification.dndSummary.close')"
            @click.stop="closeDndSummary"
          >
            <n-icon size="11">
              <CloseOutline />
            </n-icon>
          </button>
        </div>

        <!-- 多选批量操作条（P-20261003-281）：仅多选模式出现——「全选当前列表」
             三态框 + 已选计数 + 批量已读/删除 + 退出。选择按通知 id 记账与
             过滤/分组正交：切页签不清空选择，计数含视图外已选项 -->
        <div
          v-if="selectMode"
          class="nc-batch-bar"
          data-testid="notif-batch-bar"
        >
          <button
            class="nc-check"
            data-testid="notif-batch-select-all"
            :title="t('notification.batch.selectAllFiltered')"
            @click.stop="batchToggleMany(filteredIds)"
          >
            <n-icon size="12">
              <Checkbox v-if="viewCheckState === 'all'" />
              <Remove v-else-if="viewCheckState === 'some'" />
              <CheckboxOutline v-else />
            </n-icon>
          </button>
          <span
            class="nc-batch-count"
            data-testid="notif-batch-count"
          >{{ t('notification.batch.selected', { n: batchSelectedCount }) }}</span>
          <button
            class="nc-batch-btn"
            data-testid="notif-batch-read"
            :disabled="batchUnreadCount === 0"
            @click="batchMarkReadSelected"
          >
            <n-icon size="11">
              <CheckmarkDoneOutline />
            </n-icon>
            {{ t('notification.batch.markRead') }}
          </button>
          <button
            class="nc-batch-btn danger"
            data-testid="notif-batch-remove"
            :disabled="batchSelectedCount === 0"
            @click="batchRemoveSelected"
          >
            <n-icon size="11">
              <TrashOutline />
            </n-icon>
            {{ t('notification.batch.remove') }}
          </button>
          <button
            class="nc-batch-exit"
            data-testid="notif-batch-exit"
            :title="t('notification.batch.exit')"
            @click="selectMode = false"
          >
            <n-icon size="11">
              <CloseOutline />
            </n-icon>
          </button>
        </div>

        <!-- 列表：行呈现与行内动作在 NotificationRow（组聚合/行序在
             useNotifyList），未读分界线（P-20261003-259）由壳按行序插入 -->
        <div
          ref="listRef"
          class="nc-list"
          data-testid="notif-list"
        >
          <div
            v-if="filteredItems.length === 0"
            class="nc-empty"
          >
            <n-empty
              size="small"
              :description="t('notification.empty')"
            />
          </div>
          <div v-else>
            <template
              v-for="(row, ri) in flatRows"
              :key="row.kind === 'group' ? row.g.key : row.m.id"
            >
              <NotificationRow
                :row="row"
                :nav-idx="ri"
                :active="ri === activeIdx"
                :check-state="selectMode ? rowCheckState(row) : null"
                :selected="selectMode && rowSelected(row)"
                :swiping="isSwiping(row)"
                :swipe-style="swipeStyle(row)"
                :expanded="row.kind === 'group' && expandedGroups.has(row.g.key)"
                @row-click="activateRow(row)"
                @toggle-select="toggleRowSelection(row)"
                @activate="activateItem"
                @copy="copyNotif"
                @snooze="snoozeItem"
                @snooze-cancel="cancelSnooze"
                @mute="muteProject"
                @download-log="downloadDeployLogById"
                @touch-start="onTouchStart($event, row)"
                @touch-move="onTouchMove($event, row)"
                @touch-end="onTouchEnd($event, row)"
                @touch-cancel="onTouchCancel(row)"
              />
              <!-- 未读分界线（P-20261003-259）：上次查看（面板关闭时刻）后新增
                   条目与旧条目的分界——插在最后一条新行之后；当前过滤视图内
                   无新增则不渲染，界线随过滤/分组展开自然移动 -->
              <div
                v-if="ri === dividerAfterIdx"
                class="nc-new-divider"
                data-testid="notif-unread-divider"
              >
                <span class="nc-new-divider-line" />
                <span class="nc-new-divider-text">{{ t('notification.unreadDivider', { n: newSinceCount }) }}</span>
                <span class="nc-new-divider-line" />
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </transition>

  <!-- 日报历史回看（P-20261003-4）：独立遮罩浮于通知面板之上，关闭后回到通知流；
       open 走 reportArchive store（P-20261004-96）——通知中心头部与热力图下钻共写 -->
  <DailyReportHistory v-model:open="archiveStore.open" />
  <!-- 值班交接包弹窗（P-20261005-148）：自包含弹层，本组件只持开合（Esc 让位见 onWindowKeydown） -->
  <HandoverPackageModal v-model:show="showHandover" />
</template>

<style scoped>
.nc-mask {
  position: fixed;
  inset: 0;
  z-index: 1100;
}

.nc-card {
  position: absolute;
  top: 48px;
  right: 12px;
  width: 380px;
  max-height: 70vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* 窄屏通知中心（P-20261019-7）：380px 浮动卡在 390px 手机上几乎顶满且右缘
   溢出 2px；改为顶栏下的全宽面板（下缘让出 52px 底部切换器），列表自身
   滚动，与设置弹窗/侧栏抽屉同一「窄屏抽屉」语 */
@media (max-width: 700px) {
  .nc-card {
    top: var(--topbar-height, 40px);
    left: 0;
    right: 0;
    width: 100%;
    max-height: calc(100dvh - var(--topbar-height, 40px) - var(--narrow-rail-height, 52px));
    border-radius: 0 0 var(--radius-lg) var(--radius-lg);
  }
}

.nc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface));
  flex-shrink: 0;
}

.nc-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}
.nc-title-icon { color: var(--brand-accent); }
.nc-count {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  padding: 1px 6px;
  border-radius: 8px;
}

.nc-actions { display: flex; gap: 4px; }
.nc-action-btn {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  width: 24px;
  height: 24px;
  border-radius: 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all var(--motion-base);
}
.nc-action-btn:hover:not(:disabled) {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}
.nc-action-btn.danger:hover:not(:disabled) {
  border-color: var(--accent-red);
  color: var(--accent-red);
  background: color-mix(in srgb, var(--accent-red) 10%, transparent);
}
.nc-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
/* 多选模式开关激活态（P-20261003-281）：与 filter-btn.active 同视觉语 */
.nc-action-btn.active {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}

.nc-filters {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
  flex-shrink: 0;
  overflow-x: auto;
}
.nc-filter-btn {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  font-family: var(--font-mono);
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--motion-fast);
}
.nc-filter-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
/* 页签计数（>0 时显示）：未读红色示警，分类中性 */
.nc-filter-count {
  margin-left: 4px;
  font-size: 9px;
  font-weight: 700;
  color: var(--text-muted);
}
.nc-filter-count.is-unread { color: var(--accent-red, #f85149); }
.nc-filter-btn.active {
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  font-weight: 600;
}
/* 项目下拉：filters 行尾部右贴；项目名过长截断（完整名看 select 原生 title/option） */
.nc-project-select {
  margin-left: auto;
  max-width: 110px;
  height: 20px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 10px;
  font-family: var(--font-mono);
  border-radius: 4px;
  padding: 0 2px;
  cursor: pointer;
  text-overflow: ellipsis;
  flex-shrink: 0;
  transition: all var(--motion-fast);
}
.nc-project-select:hover, .nc-project-select:focus { border-color: var(--brand-accent); color: var(--text-primary); }

/* runtime 过滤 chips（P-20261003-187）：与 csp-time-chip/cp-cc-chip 同视觉语
   （CSS 变量零硬编码色）；动态行——无归属运行时的条目才不占位 */
.nc-runtime-chips {
  display: flex;
  gap: 4px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
  flex-shrink: 0;
  overflow-x: auto;
}
.nc-runtime-chip {
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 10px;
  font-family: var(--font-mono);
  padding: 2px 8px;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: all var(--motion-fast);
}
.nc-runtime-chip:hover { border-color: var(--brand-accent); color: var(--brand-accent); }
.nc-runtime-chip.active {
  border-color: currentColor;
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  font-weight: 600;
}

/* 免打扰解除摘要行（P-20261003-64）：弱化的品牌色提示条，激活态（过滤视图
   开启）加重以承担「当前在窗口内过滤」的状态指示；颜色全走既有主题变量 */
.nc-dnd-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  background: var(--brand-accent-soft);
  border-bottom: 1px solid var(--border-default);
  cursor: pointer;
  flex-shrink: 0;
  transition: background var(--motion-base);
}
.nc-dnd-summary:hover { background: color-mix(in srgb, var(--brand-accent) 14%, transparent); }
.nc-dnd-summary:focus-visible { outline: 1px solid var(--brand-accent); outline-offset: -1px; }
.nc-dnd-summary.active {
  background: color-mix(in srgb, var(--brand-accent) 16%, transparent);
  box-shadow: inset 2px 0 0 var(--brand-accent);
}
.nc-dnd-icon { color: var(--brand-accent); flex-shrink: 0; }
.nc-dnd-text {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-dnd-summary.active .nc-dnd-text { color: var(--text-primary); font-weight: 600; }
.nc-dnd-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  width: 18px;
  height: 18px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--motion-base);
}
.nc-dnd-close:hover { color: var(--text-primary); background: var(--bg-active); }

/* 多选批量操作条（P-20261003-281）：贴列表上缘的模式内工具条；视觉语同
   filters/runtime chips 行（bg-panel 底 + 边界线），按钮同 nc-batch-btn 家族 */
.nc-batch-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-default);
  background: var(--bg-panel);
  flex-shrink: 0;
}
.nc-batch-count {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-batch-btn {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-secondary);
  font-size: 10px;
  font-family: var(--font-mono);
  padding: 2px 7px;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--motion-base);
}
.nc-batch-btn:hover:not(:disabled) {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
}
.nc-batch-btn.danger:hover:not(:disabled) {
  border-color: var(--accent-red);
  color: var(--accent-red);
  background: color-mix(in srgb, var(--accent-red) 10%, transparent);
}
.nc-batch-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.nc-batch-exit {
  border: none;
  background: transparent;
  color: var(--text-muted);
  width: 18px;
  height: 18px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--motion-base);
}
.nc-batch-exit:hover { color: var(--text-primary); background: var(--bg-active); }

.nc-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
}

.nc-empty {
  padding: 36px 16px;
  display: flex;
  justify-content: center;
}

/* 键盘导航高亮的焦点轮廓抑制：面板根节点承接焦点（行高亮即指示，
   行级样式在 NotificationRow） */
.nc-card:focus, .nc-card:focus-visible { outline: none; }

/* 未读分界线（P-20261003-259）：上次查看后新增与旧条目的分界——品牌色细线
   夹文案 + 极浅底色，在未读行高亮之间仍可辨；颜色全走主题变量 */
.nc-new-divider {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 12px;
  background: color-mix(in srgb, var(--brand-accent) 6%, transparent);
  color: var(--brand-accent);
}
.nc-new-divider-line {
  flex: 1;
  border-top: 1px solid color-mix(in srgb, var(--brand-accent) 45%, transparent);
}
.nc-new-divider-text {
  font-size: 10px;
  font-family: var(--font-mono);
  font-weight: 600;
  white-space: nowrap;
}

/* 转场 */
.nc-fade-enter-active,
.nc-fade-leave-active {
  transition: opacity var(--motion-base);
}
.nc-fade-enter-active .nc-card,
.nc-fade-leave-active .nc-card {
  transition: transform var(--motion-base), opacity var(--motion-base);
}
.nc-fade-enter-from,
.nc-fade-leave-to {
  opacity: 0;
}
.nc-fade-enter-from .nc-card,
.nc-fade-leave-to .nc-card {
  transform: translateY(-8px) scale(0.98);
  opacity: 0;
}
</style>
