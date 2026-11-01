<script setup lang="ts">
// 通知条目行（P-20261007-23 自 NotificationCenter.vue 分域拆解下沉）：组行与
// 展开组员行的呈现 + 行内动作按钮注册表（actionInlineLabel P-140 / 第二动作
// P-150 / 复制 P-188 / 延后 P-36 / 项目静音 P-168 / 部署日志下载 P-142 /
// 正文路径链接化 P-61）——通知域高频增量（P-188/289/140 等）的反复触碰面
// 就此收敛到独立落点，新行内动作类型在本组件 actionInlineLabel 登记即可。
//
// 行内静默动作（dismiss/标组已读/第二动作派发/正文路径打开）直调全局
// notification store；带 toast 反馈的动作（复制/延后/静音/日志下载）与跨行
// 状态（批量勾选/手势/键盘焦点）经事件上行，由宿主（通知中心壳）统一处置
// ——壳持有唯一的 discrete message 实例，行组件不重复建浮层通道。
import { computed } from 'vue'
import { NDropdown, NIcon } from 'naive-ui'
import { CheckmarkDoneOutline, CloseOutline, CopyOutline, ArrowUndoOutline, TimeOutline, VolumeOffOutline, Checkbox, CheckboxOutline, Remove } from '@vicons/ionicons5'
import { useNotificationStore } from '../../stores/notification'
import { useProjectStore } from '../../stores/project'
import { useI18n } from '../../composables/useI18n'
import { segmentNotifBody, type NotifBodySegment } from '../../utils/notifPathLinks'
import { notifBodyText, notifTitleText } from '../../utils/notifText'
import { formatSnoozeUntil } from '../../utils/notifSnooze'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../../utils/opsEvents'
import type { NotificationItem } from '../../api/client'
import type { NavRow } from '../../composables/useNotifyList'

const props = defineProps<{
  /** 行数据（useNotifyList 产出的扁平行序成员） */
  row: NavRow
  /** 键盘导航/滚动已读共用的行序锚（data-nav-idx） */
  navIdx: number
  /** 键盘导航高亮 */
  active: boolean
  /** 勾选框三态：null = 非多选模式不渲染勾选框 */
  checkState: 'all' | 'some' | 'none' | null
  /** 多选选中高亮 */
  selected: boolean
  /** 滑动手势进行中（关过渡跟手） */
  swiping: boolean
  /** 手势跟手位移内联样式 */
  swipeStyle: string | undefined
  /** 组行展开态（chevron 指向） */
  expanded: boolean
}>()

const emit = defineEmits<{
  (e: 'row-click'): void
  (e: 'toggle-select'): void
  (e: 'activate', item: NotificationItem): void
  (e: 'copy', item: NotificationItem): void
  (e: 'snooze', item: NotificationItem, key: string | number): void
  (e: 'snooze-cancel', item: NotificationItem): void
  (e: 'mute', item: NotificationItem): void
  (e: 'download-log', taskId: string): void
  (e: 'touch-start', ev: TouchEvent): void
  (e: 'touch-move', ev: TouchEvent): void
  (e: 'touch-end', ev: TouchEvent): void
  (e: 'touch-cancel'): void
}>()

const store = useNotificationStore()
const projectStore = useProjectStore()
const { t } = useI18n()

// 行数据按 kind 判别拆两支供模板窄化（v-if="g" / v-else-if="m"）——组行与
// 组员行互斥由 NavRow 的 kind 判别保证，模板分支内各取各的字段
const g = computed(() => (props.row.kind === 'group' ? props.row.g : null))
const m = computed(() => (props.row.kind === 'member' ? props.row.m : null))

// 延后菜单选择上行（带注解参数的内联箭头在 vue-tsc 模板窄化外求值，判别
// 分支收窄不携带——分发收进 script 按分支判空后上行）
function snoozeGroup(key: string | number): void {
  if (g.value) emit('snooze', g.value.item, key)
}
function snoozeMember(key: string | number): void {
  if (m.value) emit('snooze', m.value, key)
}

// 相对时间格式化
function formatTime(ts: string): string {
  const time = new Date(ts).getTime()
  const diff = Date.now() - time
  if (diff < 60 * 1000) return t('notification.justNow')
  if (diff < 60 * 60 * 1000) return t('notification.minutesAgo', { n: Math.floor(diff / 60000) })
  if (diff < 24 * 60 * 60 * 1000) return t('notification.hoursAgo', { n: Math.floor(diff / 3600000) })
  return t('notification.daysAgo', { n: Math.floor(diff / 86400000) })
}

// 模板化文案（日报 P-20261001-30）：实现体在 utils/notifText 共享——复制链
// （壳的 notifPlainText）与本渲染链同一来源，「所见即所复制」契约单一事实源
const notifTitle = (n: NotificationItem): string => notifTitleText(n, t)
const notifBody = (n: NotificationItem): string => notifBodyText(n, t)

// 正文路径链接化（P-20261004-61）：任务失败/完成/哨兵类通知 body 携输出尾部，
// 最常见信息形态是「文件路径:行号」（报错栈一行）——渲染前把路径形态片段切出
// （utils/notifPathLinks 纯函数：pathScan 共享匹配核 + approvalTarget.isPathLikeTarget
// 形态复核），body 渲染为「纯文本 + 可点态片段」混合流。探测是纯形态启发式不
// 保证文件存在，落空由点击链静默兜底（审批卡 P-47 同哲学）；无命中返回单段
// 原文，既有呈现零变化
function notifBodySegments(n: NotificationItem): NotifBodySegment[] {
  return segmentNotifBody(notifBody(n))
}

/** body 路径片段点击：OPS_OPEN_FILE_AT 既有「打开文件+行定位」窗口事件桥
 *  （useLayoutViews 消费，携 projectId 且非当前项目时先切项目）。归属项目取
 *  通知自带 projectId；无归属通知（部署失败摘要等）回退当前项目——审批卡
 *  target 点击同口径（currentProjectId 兜底），落错项目由打开链静默落空。
 *  与条目主动作点击同 UX：标已读 + 关面板露出编辑器（打开动作在面板底下发生，
 *  面板不关则表现为「点了没反应」）。@click.stop 已阻断行激活，此处不重复
 *  activateItem 语义 */
function openBodyPath(n: NotificationItem, seg: NotifBodySegment): void {
  if (!seg.path) return
  if (!n.read) void store.markRead(n.id)
  store.close()
  window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, {
    detail: {
      path: seg.path,
      projectId: n.projectId || projectStore.currentProjectId,
      line: seg.line,
      col: seg.col,
    },
  }))
}

// 行内动作按钮文案（P-20261003-140）：带动作的通知行此前只有整行可点、
// 无可见按钮，入口可发现性差；此处按 action 类型返回可解析的按钮文案，
// 未登记文案的类型（terminal/panel/url 等既有跳转型）返回空 → 不渲染按钮、
// 整行点击行为不变——新动作类型在此登记即可获得行内按钮
function actionInlineLabel(n: NotificationItem): string {
  if (n.action === 'watch-fallback') return t('notify.watchfallback.action')
  // 部署失败「交给智能体修复」（P-20261003-289）：失败部署通知的主动作，
  // 点击行/按钮同义（均走 pendingAction 分发到 useLayoutShell 的修复链）
  if (n.action === 'agent-fix') return t('agent.fix.action')
  // 联邦派发「跳转该实例」（P-20261004-101）：点击切到目标实例查看新会话
  if (n.action === 'switch-instance') return t('notify.switchInstance.action')
  // 失败会话「复盘报告」（P-20261004-60）：异常退出通知的主动作，点击行/
  // 按钮打开复盘弹层（退出码/末命令/输出尾部聚合 + 一键转存问询）
  if (n.action === 'postmortem') return t('notify.postmortem.action')
  // 定时任务发起失败「一键重试」（P-20261006-14）：失败态行动化对称，点击行/
  // 按钮同义（pendingAction 分发到 useLayoutShell 的试跑链重新发起）
  if (n.action === 'cron-retry') return t('agentcron.notify.retryAction')
  // 快投递「交给当前会话」（P-20261006-51）：主动作，broadcast-write 写入
  // 最近激活的终端会话；第二动作「新会话处理」走 secondActionLabel
  if (n.action === 'quickdrop-active') return t('notify.quickdrop.actionActive')
  // 协作素材「交给当前会话」（P-20261024-1）：主动作，绝对路径贴进最近激活
  // 会话（不自动执行）；第二动作「新会话处理」走 secondActionLabel
  if (n.action === 'shdrop-active') return t('notify.shdrop.actionActive')
  // 直通输入持权卡「收回」（P-20261024-1）：授予即入账的持权条目，一键收回
  // 即解除会话只读闸（幂等）
  if (n.action === 'shdirect-revoke') return t('notify.shdirect.actionRevoke')
  // autoStash「恢复」（P-20261006-48）：切回原分支后点名切走前的自动暂存条目，
  // 点击行/按钮同义（pendingAction 分发到 useStashRecover 的既有 pop 链）
  if (n.action === 'stash-recover') return t('git.autoStashRecoverAction')
  // 敏感文件工作台外写入（P-20261005-15）：payload=项目相对路径，点击行/
  // 按钮经 pendingAction 链在编辑器打开该文件（缓冲已随 file.changed 自动
  // 重载，打开即外部改动后的现内容）
  if (n.action === 'file') return t('notify.extwrite.action')
  return ''
}

// 第二动作行内按钮（P-20261005-150）：主动作旁的第二小钮，与 actionInlineLabel
// 同登记模式——secondAction 未登记文案的类型返回空不渲染。哨兵命中主动作直达
// 触发会话，第二动作 agent-fix 一键修复（值班响应四步收两步）；点击走
// store.handleSecondAction（换槽复用 handleClick 同链：已读 + 关面板 +
// pendingAction 路由桥接），文案/悬停提示复用 agent.fix.action 既有词条
//（同一动作语义不重复养文案）
function secondActionLabel(n: NotificationItem): string {
  if (n.secondAction === 'agent-fix') return t('agent.fix.action')
  // 快投递「新会话处理」（P-20261006-51）：第二动作，createAgent 以投递内容
  // 为 launchArgs 种子（超 500 字节走任务文件降级，useQuickdrop 消费链）
  if (n.secondAction === 'quickdrop-new') return t('notify.quickdrop.actionNew')
  // 协作素材「新会话处理」（P-20261024-1）：createAgent 以素材绝对路径为种子
  if (n.secondAction === 'shdrop-new') return t('notify.shdrop.actionNew')
  return ''
}

// 部署通知「下载日志」行内入口（P-20261003-142）：部署终态通知携 taskId
//（成功 panel:deploy / 失败 agent-fix 双形态；Action 单槽主动作语义不回退，
// 下载是第二入口），据此识别并渲染按钮。旧记录无 taskId 字段不渲染，天然
// 向后兼容；直接 blob 下载不走 pendingAction（1h 内存窗外的 410 过期提示
// 在下载链内就地给出）——下载经事件上行由宿主执行（discrete message 实例
// 在宿主），本组件只做识别
function deployLogTaskId(n: NotificationItem): string | null {
  if (!n.taskId) return null
  const isDeployNotice = (n.action === 'panel' && n.actionPayload === 'deploy') || n.action === 'agent-fix'
  return isDeployNotice ? n.taskId : null
}

function typeClass(tp: string): string {
  return `notif-type-${tp}`
}

// 标记本组已读：组成员逐条 markRead（后端逐条幂等；量级为组内条数）
async function markGroupRead(g: { members: Array<{ id: string; read: boolean }> }): Promise<void> {
  for (const m of g.members) {
    if (!m.read) await store.markRead(m.id)
  }
}

// 稍后提醒（P-20261003-36）：条目操作区三档菜单（30 分钟/1 小时/明天同一
// 时刻），选择经事件上行由宿主算绝对时刻调服务端打标并轻提示。多成员聚合
// 组行不设菜单——整组延后属批量动作，展开后逐条操作
const snoozeOptions = computed(() => [
  { key: 'min30', label: t('notification.snooze.min30') },
  { key: 'hour1', label: t('notification.snooze.hour1') },
  { key: 'tomorrow', label: t('notification.snooze.tomorrow') },
])

function snoozeUntilText(n: NotificationItem): string {
  return n.snoozeUntil ? t('notification.snooze.until', { time: formatSnoozeUntil(n.snoozeUntil) }) : ''
}
</script>

<template>
  <!-- 组行：多条折叠为一行（×N 徽标，点击展开）；单条原样渲染 -->
  <div
    v-if="g"
    class="nc-item"
    :data-testid="'notif-row-' + g.item.id"
    :data-nav-idx="navIdx"
    :class="[typeClass(g.item.type), { unread: g.count === 1 ? !g.item.read : g.anyUnread, clickable: g.count > 1 || !!g.item.action, 'is-active': active, 'is-swiping': swiping, 'is-selected': selected }]"
    :style="swipeStyle"
    @click="$emit('row-click')"
    @touchstart="$emit('touch-start', $event)"
    @touchmove="$emit('touch-move', $event)"
    @touchend="$emit('touch-end', $event)"
    @touchcancel="$emit('touch-cancel')"
  >
    <!-- 行勾选框（P-20261003-281）：仅多选模式渲染；组行三态 =
         全体成员聚合（部分选中显半选），点击整组切换 -->
    <button
      v-if="checkState"
      class="nc-check"
      :data-testid="'notif-check-' + g.item.id"
      :title="t('notification.batch.pick')"
      @click.stop="$emit('toggle-select')"
    >
      <n-icon size="12">
        <Checkbox v-if="checkState === 'all'" />
        <Remove v-else-if="checkState === 'some'" />
        <CheckboxOutline v-else />
      </n-icon>
    </button>
    <span class="nc-dot" />
    <div class="nc-content">
      <div class="nc-item-header">
        <span class="nc-item-title">{{ notifTitle(g.item) }}</span>
        <span
          v-if="g.item.projectName"
          class="nc-item-project"
        >{{ g.item.projectName }}</span>
        <span
          v-if="g.count > 1"
          class="nc-group-count"
        >×{{ g.count }}</span>
      </div>
      <!-- 正文路径链接化（P-20261004-61）：body 分段渲染——路径:行号
           形态片段为可点态（下划线+品牌色），点击 OPS_OPEN_FILE_AT
           直达编辑器行（.stop 防行激活）；无命中恒为单段纯文本，
           既有呈现零变化。分段拼回恒等于原文（模板元素间换行被
           whitespace condense 移除），复制链不受影响 -->
      <div
        v-if="g.item.body || g.item.bodyKey"
        class="nc-item-body"
      >
        <template
          v-for="(seg, si) in notifBodySegments(g.item)"
          :key="si"
        >
          <button
            v-if="seg.kind === 'path'"
            type="button"
            class="nc-body-path"
            :data-testid="'notif-body-path-' + g.item.id"
            :title="t('notification.bodyPath.tip', { path: seg.text })"
            @click.stop="openBodyPath(g.item, seg)"
          >
            {{ seg.text }}
          </button>
          <template v-else>
            {{ seg.text }}
          </template>
        </template>
      </div>
      <div
        class="nc-item-time"
        :title="new Date(g.item.time).toLocaleString()"
      >
        {{ store.isSnoozed(g.item) ? snoozeUntilText(g.item) : formatTime(g.item.time) }}
      </div>
      <!-- 行内动作按钮（P-20261003-140）：文案可解析的动作类型才渲染 -->
      <button
        v-if="g.count === 1 && actionInlineLabel(g.item)"
        class="nc-inline-action"
        :data-testid="'notif-action-' + g.item.id"
        @click.stop="$emit('activate', g.item)"
      >
        {{ actionInlineLabel(g.item) }}
      </button>
      <!-- 第二动作小钮（P-20261005-150）：主动作旁的第二入口，弱化
           样式（主实副 quaternary）；派发换槽走 handleSecondAction -->
      <button
        v-if="g.count === 1 && secondActionLabel(g.item)"
        class="nc-inline-action nc-second-action"
        :data-testid="'notif-second-action-' + g.item.id"
        :title="t('agent.fix.actionTitle')"
        @click.stop="store.handleSecondAction(g.item)"
      >
        {{ secondActionLabel(g.item) }}
      </button>
      <!-- 部署通知「下载日志」（P-20261003-142）：第二入口直接下载，
           不经 pendingAction（主动作语义不回退） -->
      <button
        v-if="g.count === 1 && deployLogTaskId(g.item)"
        class="nc-inline-action"
        :data-testid="'notif-deploy-log-' + g.item.id"
        @click.stop="$emit('download-log', deployLogTaskId(g.item)!)"
      >
        {{ t('deploy.logDownload.short') }}
      </button>
    </div>
    <button
      v-if="g.count > 1 && g.anyUnread"
      class="nc-dismiss"
      :title="t('notification.markGroupRead')"
      @click.stop="markGroupRead(g)"
    >
      <n-icon size="11">
        <CheckmarkDoneOutline />
      </n-icon>
    </button>
    <!-- 稍后提醒（单条行专属：聚合组行展开后逐条操作）；延后中显示取消恢复 -->
    <button
      v-if="g.count === 1 && store.isSnoozed(g.item)"
      class="nc-dismiss"
      data-testid="notif-snooze-cancel"
      :title="t('notification.snooze.cancel')"
      @click.stop="$emit('snooze-cancel', g.item)"
    >
      <n-icon size="11">
        <ArrowUndoOutline />
      </n-icon>
    </button>
    <n-dropdown
      v-if="g.count === 1"
      trigger="click"
      placement="bottom-end"
      :options="snoozeOptions"
      @select="snoozeGroup"
    >
      <button
        class="nc-dismiss"
        data-testid="notif-snooze-btn"
        :title="t('notification.snooze.menu')"
        @click.stop
      >
        <n-icon size="11">
          <TimeOutline />
        </n-icon>
      </button>
    </n-dropdown>
    <!-- 项目静音快捷（P-20261003-168）：携 projectId 的条目专属；
         解除入口在设置·通知·项目静音管理 -->
    <button
      v-if="g.count === 1 && g.item.projectId"
      class="nc-dismiss"
      data-testid="notif-mute-project"
      :title="t('notification.projectMute.action')"
      @click.stop="$emit('mute', g.item)"
    >
      <n-icon size="11">
        <VolumeOffOutline />
      </n-icon>
    </button>
    <!-- 条目复制（P-20261003-188）：hover 浮现，title+body 纯文本入剪贴板
        （复制出口走展示面渲染链，见脚本区 notifTitle/notifBody 注记）；
        聚合组全体成员 title+body 全同，组行复制代表条目即组内容 -->
    <button
      class="nc-dismiss"
      :data-testid="'notif-copy-' + g.item.id"
      :title="t('notification.copy.tip')"
      @click.stop="$emit('copy', g.item)"
    >
      <n-icon size="11">
        <CopyOutline />
      </n-icon>
    </button>
    <button
      class="nc-dismiss"
      :title="g.count > 1 ? t('notification.dismissGroup') : t('notification.dismiss')"
      @click.stop="g.count > 1 ? store.dismissMany(g.members.map(m => m.id)) : store.dismiss(g.item.id)"
    >
      <n-icon size="11">
        <CloseOutline />
      </n-icon>
    </button>
    <span
      v-if="g.count > 1"
      class="nc-chev"
      :class="{ open: expanded }"
    >›</span>
  </div>
  <!-- 展开的组员：逐条操作（跳转/已读/移除） -->
  <div
    v-else-if="m"
    class="nc-item nc-sub"
    :data-testid="'notif-sub-' + m.id"
    :data-nav-idx="navIdx"
    :class="[typeClass(m.type), { unread: !m.read, clickable: true, 'is-active': active, 'is-swiping': swiping, 'is-selected': selected }]"
    :style="swipeStyle"
    @click="$emit('row-click')"
    @touchstart="$emit('touch-start', $event)"
    @touchmove="$emit('touch-move', $event)"
    @touchend="$emit('touch-end', $event)"
    @touchcancel="$emit('touch-cancel')"
  >
    <!-- 行勾选框：同组行，组员行二态单条切换 -->
    <button
      v-if="checkState"
      class="nc-check"
      :data-testid="'notif-check-' + m.id"
      :title="t('notification.batch.pick')"
      @click.stop="$emit('toggle-select')"
    >
      <n-icon size="12">
        <Checkbox v-if="checkState === 'all'" />
        <CheckboxOutline v-else />
      </n-icon>
    </button>
    <span class="nc-dot" />
    <div class="nc-content">
      <div class="nc-item-header">
        <span class="nc-item-title">{{ notifTitle(m) }}</span>
      </div>
      <div
        class="nc-item-time"
        :title="new Date(m.time).toLocaleString()"
      >
        {{ store.isSnoozed(m) ? snoozeUntilText(m) : formatTime(m.time) }}
      </div>
      <button
        v-if="actionInlineLabel(m)"
        class="nc-inline-action"
        @click.stop="$emit('activate', m)"
      >
        {{ actionInlineLabel(m) }}
      </button>
      <!-- 第二动作小钮（P-20261005-150）：同展开组员行，弱化样式 -->
      <button
        v-if="secondActionLabel(m)"
        class="nc-inline-action nc-second-action"
        :data-testid="'notif-second-action-' + m.id"
        :title="t('agent.fix.actionTitle')"
        @click.stop="store.handleSecondAction(m)"
      >
        {{ secondActionLabel(m) }}
      </button>
      <!-- 部署通知「下载日志」（P-20261003-142）：同展开组员行的第二入口 -->
      <button
        v-if="deployLogTaskId(m)"
        class="nc-inline-action"
        @click.stop="$emit('download-log', deployLogTaskId(m)!)"
      >
        {{ t('deploy.logDownload.short') }}
      </button>
    </div>
    <button
      v-if="store.isSnoozed(m)"
      class="nc-dismiss"
      :title="t('notification.snooze.cancel')"
      @click.stop="$emit('snooze-cancel', m)"
    >
      <n-icon size="11">
        <ArrowUndoOutline />
      </n-icon>
    </button>
    <n-dropdown
      trigger="click"
      placement="bottom-end"
      :options="snoozeOptions"
      @select="snoozeMember"
    >
      <button
        class="nc-dismiss"
        :title="t('notification.snooze.menu')"
        @click.stop
      >
        <n-icon size="11">
          <TimeOutline />
        </n-icon>
      </button>
    </n-dropdown>
    <button
      v-if="m.projectId"
      class="nc-dismiss"
      data-testid="notif-mute-project"
      :title="t('notification.projectMute.action')"
      @click.stop="$emit('mute', m)"
    >
      <n-icon size="11">
        <VolumeOffOutline />
      </n-icon>
    </button>
    <!-- 条目复制（P-20261003-188）：同组行，展开组员逐条可复制 -->
    <button
      class="nc-dismiss"
      :data-testid="'notif-copy-' + m.id"
      :title="t('notification.copy.tip')"
      @click.stop="$emit('copy', m)"
    >
      <n-icon size="11">
        <CopyOutline />
      </n-icon>
    </button>
    <button
      class="nc-dismiss"
      :title="t('notification.dismiss')"
      @click.stop="store.dismiss(m.id)"
    >
      <n-icon size="11">
        <CloseOutline />
      </n-icon>
    </button>
  </div>
</template>

<style scoped>
/* 行级样式（P-20261007-23 自 NotificationCenter.vue 随行模板整体迁入）：
   颜色/动效全走主题变量与动效 token，类名与迁入前逐一相同（e2e 断言锚
   .nc-item/.nc-check/.nc-sub 等，DOM 结构零变化） */
.nc-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  /* 行高密度档（P-20261003-322）：--row-pad-y 仅紧凑档注入（3px → 本面 5px）；
     舒适档回落 6px+2px = 历史 8px，零回归。行高随内容自适应，走 padding 基准 */
  padding: calc(var(--row-pad-y, 6px) + 2px) 12px;
  border-bottom: 1px solid color-mix(in srgb, var(--border-default) 50%, transparent);
  transition: background var(--motion-fast), transform var(--motion-base);
  position: relative;
  /* 横向滑动手势交给行内 JS 判定，纵向滚动保持原生（touch-action 收敛手势车道） */
  touch-action: pan-y;
  /* 大列表渲染优化：视口外行跳过布局/绘制（行高可变，虚拟列表不适用；
     contain-intrinsic-height 给出近似占位高度，滚动到可见时按实际内容重排） */
  content-visibility: auto;
  contain-intrinsic-size: auto 64px;
}
.nc-item:hover { background: var(--bg-hover); }
/* 滑动手势跟手：手势中关过渡（位移实时跟随），松手靠 .nc-item 的 transform 过渡回弹 */
.nc-item.is-swiping { transition: none; will-change: transform; }
.nc-item.is-active { background: var(--bg-hover); box-shadow: inset 2px 0 0 var(--brand-accent); }
.nc-item.unread { background: color-mix(in srgb, var(--brand-accent) 4%, transparent); }
.nc-item.unread::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--brand-accent);
}
/* 多选选中高亮（P-20261003-281）：置于 .unread 之后让选中底色优先——
   未读左条保留（两态信息并存：选中与否 × 读未读） */
.nc-item.is-selected { background: var(--brand-accent-soft); }
.nc-item.clickable { cursor: pointer; }

.nc-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  margin-top: 6px;
  flex-shrink: 0;
}
/* 类别点四档 = 状态语义色四档（P-20261003-285）：success→成功 / error→失败 /
   warning→等待（未决警示与审批 pending 同族）/ info→进行中（信息蓝档）——
   同一映射表出色，跨面同语义同色 */
.notif-type-success .nc-dot { background: var(--status-success); box-shadow: 0 0 4px color-mix(in srgb, var(--status-success) 60%, transparent); }
.notif-type-warning .nc-dot { background: var(--status-waiting); box-shadow: 0 0 4px color-mix(in srgb, var(--status-waiting) 60%, transparent); }
.notif-type-error .nc-dot { background: var(--status-failed); box-shadow: 0 0 4px color-mix(in srgb, var(--status-failed) 60%, transparent); }
.notif-type-info .nc-dot { background: var(--status-running); box-shadow: 0 0 4px color-mix(in srgb, var(--status-running) 60%, transparent); }

/* 行勾选框（P-20261003-281）：原生按钮自绘 checkbox（仓库内 hover 动作钮同
   范式，不引 NCheckbox 依赖）；顶部对齐标题行（.nc-item 为 flex-start） */
.nc-check {
  appearance: none;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--brand-accent);
  width: 16px;
  height: 16px;
  padding: 0;
  margin-top: 2px;
  border-radius: 3px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--motion-base);
}
.nc-check:hover { border-color: var(--brand-accent); background: var(--brand-accent-soft); }
.nc-check:focus-visible { outline: 1px solid var(--brand-accent); outline-offset: 1px; }

.nc-content { flex: 1; min-width: 0; }
.nc-item-header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 2px;
}
.nc-item-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-item-project {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.nc-group-count {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--brand-accent);
  background: var(--brand-accent-soft);
  padding: 1px 6px;
  border-radius: 8px;
  flex-shrink: 0;
}
.nc-chev {
  color: var(--text-muted);
  font-size: 14px;
  transition: transform var(--motion-base);
  flex-shrink: 0;
  align-self: center;
  margin-left: -6px;
}
.nc-chev.open { transform: rotate(90deg); }
/* 展开的组员：缩进标识层级 */
.nc-item.nc-sub { padding-left: 26px; background: color-mix(in srgb, var(--bg-panel) 60%, transparent); }
.nc-item-body {
  font-size: 11px;
  color: var(--text-body);
  margin-bottom: 4px;
  white-space: pre-wrap;
  word-break: break-word;
}
/* body 路径可点态（P-20261004-61）：正文内的路径:行号片段渲染为链接（品牌色
   +下划线与纯文本可辨），裸化按钮对齐正文行内呈现（font: inherit 承接 pre-wrap
   断行）；hover/focus 提亮，颜色全走主题变量四主题自适应 */
.nc-body-path {
  appearance: none;
  background: none;
  border: none;
  padding: 0;
  margin: 0;
  font: inherit;
  color: var(--brand-accent);
  cursor: pointer;
  text-align: left;
  text-decoration: underline;
  text-underline-offset: 2px;
  word-break: break-word;
}
.nc-body-path:hover,
.nc-body-path:focus-visible { color: var(--text-primary); }
.nc-body-path:focus-visible {
  outline: 1px solid var(--brand-accent);
  outline-offset: 1px;
}
.nc-item-time {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}

.nc-dismiss {
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
  opacity: 0;
  transition: all var(--motion-base);
}

/* 行内动作按钮（P-20261003-140）：动作型通知的可见入口——此前动作只有
   整行可点、无任何可见 affordance；常显（不随 hover）保可发现性 */
.nc-inline-action {
  align-self: flex-start;
  margin-top: 4px;
  padding: 1px 8px;
  font-size: 11px;
  line-height: 18px;
  border: 1px solid var(--brand-accent);
  border-radius: 4px;
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  cursor: pointer;
  transition: all var(--motion-base);
}
.nc-inline-action:hover {
  filter: brightness(1.1);
}
/* 第二动作小钮（P-20261005-150）：视觉层级弱于主动作（主实副 quaternary）——
   去底色描边、文字用次级色，hover 才浮出主动作同级强调；与主动作并排时
   保持同一尺寸基线，只降不升视觉权重 */
.nc-second-action {
  margin-left: 6px;
  border-color: var(--border-default);
  background: transparent;
  color: var(--text-secondary);
}
.nc-second-action:hover {
  border-color: var(--brand-accent);
  color: var(--brand-accent);
  filter: none;
}
.nc-item:hover .nc-dismiss { opacity: 1; }
.nc-dismiss:hover { color: var(--text-primary); background: var(--bg-active); }
</style>
