<script setup lang="ts">
/**
 * 智能体操作审批卡片堆（B4 约定式，全局常驻）：
 * Agent 高危操作前经 ops-confirm 请求确认 → 此处渲染持久卡片（非易逝 toast），
 * 用户「允许一次 / 拒绝 / 放行时限三选一」→ resolve API，裁决经广播回流多标签
 * 页一致清账。放行时限切全局审批档位（P-20261003-316：ask/会话级/24h/永久），
 * 三选一档位面在卡上（P-20261002-126 二次确认升级）；放行态常驻徽标见
 * ApprovalModeBadge。
 * 裁决/跳转逻辑在 useApprovalActions（与值班大屏审批卡共用）；
 * 值班大屏（/monitor）自身以卡片墙形态渲染审批，此固定堆在该路由让位隐藏。
 * 键盘裁决（P-20261003-1）：待裁决卡在屏时全局 1/2/3 三选直达（1=允许一次 /
 * 2=放行时限弹层 / 3=拒绝，键 2 打开卡上档位弹层后弹层内 1/2/3 直选三档
 * P-126 语义保留），监听与守卫在 useApprovalHotkeys（本组件宿主化，App 根
 * 常驻挂载即全局生效）。
 * 卡片堆折叠（P-20261003-25）：待裁决超阈值自动折叠为摘要条（「N 项待裁决」
 * + 角标提示键盘裁决目标序号），点击展开全堆/再点收起；折叠态只完整展示最新
 * 一张，键盘 1/2/3 目标不变（恒最旧卡 useApprovalHotkeys pendingList 首张，
 * 与呈现无关——角标防误把可见最新卡当裁决对象）；展开状态会话内记忆（组件
 * App 根常驻挂载，堆清空后重置，不持久化）。
 * 拒绝理由（P-20261003-21）：拒绝改为可选理由流——跨卡单开状态（同屏至多
 * 一卡展开输入行）在宿主持有，卡内渲染见 ApprovalCard。
 * 首触说明（P-20261003-311）：首次出现审批卡（localStorage 一次性标记）时
 * 堆顶挂三行说明条（agent 在等裁决/允许与拒绝语义/完全允许=同类不再询问），
 * 渲染与交互收口在共用组件 ApprovalGuideBar（值班大屏同款同标记键）。
 * 最近裁决（P-20261003-226）：卡堆尾部「最近裁决」只读下拉——数据面是
 * approvals.recent（resolved 记录就近留存，见 store），误裁决（手滑允许）
 * 后卡已清账仍可就近回查 op/target/结果/时间；重裁决不做（仅 pending 可裁决
 * 是服务端幂等约束，面板注记写明）。容器在场条件随之扩展为「有 pending 卡
 * 或有最近裁决」，无 pending 时不再是 alertdialog 语境（role 随 pending 在场）。
 *
 * 【落点注释（P-20261003-87 拆分）】本组件只保留「堆」职责：折叠摘要条与
 * 展开记忆、键盘分发（含折叠展开联动）、跨卡状态（理由行单开/理由文本）、
 * 录制/回放弹层宿主、monitor 路由让位。单卡渲染与单卡行为（头部门按钮/
 * op·target 呈现与点击/三按钮裁决/理由行交互）已拆至 ApprovalCard.vue——
 * 后续案按「改堆策略」还是「改单卡」各归各文件，不再同文件挤同一冲突面。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NButton, NPopover, useMessage } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useApprovalsStore } from '../../stores/approvals'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useApprovalActions } from '../../composables/useApprovalActions'
import { useApprovalHotkeys } from '../../composables/useApprovalHotkeys'
import { opsConfirmApi } from '../../api/domains/opsconfirm'
import { formatDate } from '../../utils/git'
import { maskApprovalSecrets } from '../../utils/sensitiveMask'
import type { ComponentPublicInstance } from 'vue'
import type { ApprovalRecord } from '../../api/domains/opsconfirm'
import type { ClaudeSessionInfo } from '../../api/domains/claude'
import ApprovalCard from './ApprovalCard.vue'
import ApprovalGuideBar from './ApprovalGuideBar.vue'
import ApprovalRuleSuggestBar from './ApprovalRuleSuggestBar.vue'
import RecordingBrowser from '../recording/RecordingBrowser.vue'
import SessionReplayModal from '../claude/SessionReplayModal.vue'
import { useApprovalRuleSuggest } from '../../composables/useApprovalRuleSuggest'

const { t } = useI18n()
const route = useRoute()
const approvals = useApprovalsStore()
const { decide, resolveReplayTarget } = useApprovalActions()

// 大屏路由有专属审批卡（网格内联），固定堆让位避免同屏双份
const isMonitorRoute = computed(() => route.name === 'monitor')

// ---- 最近裁决（P-20261003-226）：卡堆尾部只读回看下拉 ----

// 容器在场面扩展：有 pending 卡（原语义）或有最近裁决都算在场——误裁决后卡
// 已清账（pendingCount 归零），回看入口必须还找得到（本提案动机场景）；
// 数据面在 approvals.recent（seed 重建 + 裁决就地入账，见 store）。
// 与放行徽标（ApprovalModeBadge）同角同锚：无卡仅触发条的形态下徽标侧上抬
// 让位（方向反转，见该组件 liftAboveRecent）——外层 .agent-input-stack 是
// App 持有的 fixed 包装，本组件内做 margin/padding 上抬只会在包装盒内挪动，
// 包装空盒仍挡徽标点击（实测踩坑），让位动作必须落在徽标组件
const hasPending = computed(() => approvals.pendingCount > 0)
// 裁决就近回看窗（48h）+ 手动关闭：浮层只在窗口内有裁决、且未被手动关闭时
// 撑起——recent 留存恒有最近 10 条，无时效/关闭控制会让浮层在生产长期运行
// 时永久遮挡终端右下（dev-server 实锚：7 天前旧裁决撑起浮层）。关闭记
// dismissedAt（localStorage），**新裁决**（晚于关闭时刻）才重新出现；pending
// 待裁决卡不受影响始终显示。更早历史在值班大屏「最近裁决」面/审计 CSV 仍
// 完整可见，不丢数据
const RECENT_WINDOW_MS = 48 * 60 * 60 * 1000
const RECENT_DISMISS_KEY = 'approval-recent-dismissed-at'
const recentDismissedAt = ref(Number(localStorage.getItem(RECENT_DISMISS_KEY) || 0))
const recentFresh = computed(() => {
  const now = Date.now()
  return approvals.recent.some((a) => {
    const t = new Date(a.resolvedAt || a.createdAt || 0).getTime()
    return t > 0 && now - t <= RECENT_WINDOW_MS && t > recentDismissedAt.value
  })
})
function dismissRecent(): void {
  recentDismissedAt.value = Date.now()
  localStorage.setItem(RECENT_DISMISS_KEY, String(recentDismissedAt.value))
}
const stackVisible = computed(() =>
  isMonitorRoute.value === false && (hasPending.value || recentFresh.value))

// 条目悬浮 title：detail 散文 + 拒绝理由（denied 且有附言时）——只读条目的
// 上下文出口，不进版面。展示面脱敏同 P-197 展示兜底（服务端入库已过 mask，
// 这里兜旧记录补账形态）
function recentTitle(a: ApprovalRecord): string {
  const parts = [maskApprovalSecrets(a.detail ?? '')]
  if (a.status === 'denied' && a.reason) parts.push(maskApprovalSecrets(a.reason))
  return parts.filter(Boolean).join('\n')
}
/** 裁决时刻（相对时间，utils/git 既有 formatter；缺 resolvedAt 兜 createdAt） */
function recentTime(a: ApprovalRecord): string {
  return formatDate(a.resolvedAt || a.createdAt || '')
}

// 裁决历史 CSV 导出（P-20261003-247）：最近裁决下拉尾部出口——本地下拉只回看
// 最近 10 条（APPROVAL_RECENT_LIMIT），全量裁决历史（30 天保留档）由服务端
// /ops-confirm/export 一次出齐（审计 CSV 同模式，含公式注入防护）。blob 下载
// + 客户端合成下载名（拦截器不透 Content-Disposition，audit 导出同款双保险）；
// 数据面服务端组装，前端不经手
const message = useMessage()
const exportingRecent = ref(false)
async function exportRecentCsv(): Promise<void> {
  if (exportingRecent.value) return
  exportingRecent.value = true
  try {
    const blob = await opsConfirmApi.exportCsv()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `codecombo-approvals-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    message.success(t('approval.recent.exportDone'))
  } catch { /* 拦截器处理 */ } finally {
    exportingRecent.value = false
  }
}

// 卡头会话名归属（P-20261003-161）的数据面：单卡查 terminal-sessions store 显
// 发起会话名。本组件 App 根常驻挂载，而 store 列表靠各终端宿主拉取——冷启动
// seedPending 回填的卡可能先于任何终端宿主在场（列表未拉过，查名落空会误把
// 活会话显成截断 id），pending 在屏且未加载过时在此懒拉一次（堆层收口防多卡
// 并发重复请求；失败静默走 id 截断 fallback，后续 terminals.changed 对账自愈）
const terminalSessions = useTerminalSessionsStore()
watch(() => approvals.pendingCount, (n) => {
  if (n > 0 && !terminalSessions.loaded) void terminalSessions.refresh()
}, { immediate: true })

// 模式自学习建议（P-20261006-28）：pending 增长即刷新检测源（近 7 天手动允许
// 计数随每次裁决推进——上一张卡的「允许」要让下一张同型卡的建议达标）；
// 建议条与首触说明条同为堆顶附属层，检测/节流在 useApprovalRuleSuggest 单例
const ruleSuggest = useApprovalRuleSuggest()
watch(() => approvals.pendingCount, (n) => {
  if (n > 0) void ruleSuggest.refresh()
})
const ruleSuggestion = computed(() => ruleSuggest.suggestionFor(approvals.pendingList))

// 过程实况浏览（P-20261001-15）：按审批标记聚焦（弹层宿主在本组件）
const showRecording = ref(false)
const recordingApprovalId = ref('')
function openRecording(id: string): void {
  recordingApprovalId.value = id
  showRecording.value = true
}

// 会话回放（P-20261002-82）：解析目标对话（经工作目录桥接）→ 弹层定位到
// 审批时刻；解析失败（会话已结束/无 transcript/读取失败）已在 composable 内
// toast 降级，此处不开弹层
const replaySession = ref<ClaudeSessionInfo | null>(null)
const replayFocusAt = ref('')
async function openReplay(a: ApprovalRecord): Promise<void> {
  const target = await resolveReplayTarget(a.sessionId, a.createdAt)
  if (!target) return
  replayFocusAt.value = a.createdAt || ''
  replaySession.value = target
}

// ---- 卡片堆折叠（P-20261003-25）：超阈值自动折叠为摘要条，展开态会话内记忆 ----

/** 折叠阈值：待裁决超过此张数折叠为摘要条（提案定值 3——第 4 张起不再纵堆） */
const COLLAPSE_THRESHOLD = 3

// 展开状态会话内记忆：本组件 App 根常驻挂载，ref 即会话生命周期——多张爆发
// 期间手动展开后保持展开（新卡入堆不回折）；堆清空即重置，下次爆发从折叠态
// 起步，不持久化（刷新/新会话回到默认折叠语义）
const stackExpanded = ref(false)

const needsCollapse = computed(() => approvals.pendingCount > COLLAPSE_THRESHOLD)
/** 折叠生效态：超阈值且未被手动展开（≤阈值恒全显，摘要条随之退场） */
const stackCollapsed = computed(() => needsCollapse.value && !stackExpanded.value)
/** 折叠态只完整展示最新一张（其余收进摘要条计数），其余时候全量渲染 */
const visibleList = computed(() =>
  stackCollapsed.value ? approvals.pendingList.slice(-1) : approvals.pendingList,
)
/** 键盘裁决目标（1/2/3 恒最旧卡，useApprovalHotkeys 取 pendingList 首张）——
 *  折叠态与可见最新卡不同，摘要条角标亮出其序号防误裁决 */
const hotkeyTarget = computed(() => approvals.pendingList[0])

// 堆清空即重置展开记忆（watch 与组件同生命周期，常驻挂载下=会话级）
watch(() => approvals.pendingCount, (n) => {
  if (n === 0) stackExpanded.value = false
})

/** 摘要条点击：展开全堆 / 再点收起；收起同时收掉行内理由输入行——其宿主卡
 *  可能被折叠出视野，留行不收会出现「输入行开着却找不到卡」的悬空态 */
function toggleStack(): void {
  stackExpanded.value = !stackExpanded.value
  if (stackCollapsed.value) closeDeny()
}

// ---- 键盘裁决（P-20261003-1）：1/2/3 三选直达，键 2 走 Popconfirm 二次确认 ----

// 各卡组件实例（非响应式 Map 即可——只被按键链命令式调用，不进模板）；
// v-for 函数 ref 按 id 收集，卡片卸载即清除。仅用卡上暴露的两个命令式入口
// （鸭子判定防串型：showAllowAlwaysConfirm 开放行时限弹层 / focusDenyInput
// 聚焦理由输入行——实例协调面收口，卡内 DOM/naive-ui 实例不再上翻宿主）
interface ApprovalCardLike {
  showAllowAlwaysConfirm: () => void
  focusDenyInput: () => void
}
const cardInsts = new Map<string, ApprovalCardLike>()
function setCardInst(id: string, inst: Element | ComponentPublicInstance | null): void {
  const candidate = inst as ApprovalCardLike | null
  if (candidate && typeof candidate.showAllowAlwaysConfirm === 'function'
    && typeof candidate.focusDenyInput === 'function') cardInsts.set(id, candidate)
  else cardInsts.delete(id)
}

/** 键 2（放行时限三选一）入口：打开该卡档位弹层（P-126 全局语义防护精神
 *  保留——触发按钮 → 弹层选项两跳显式操作，误触不静默放开安全面），并把
 *  焦点送进弹层首个选项行，键 2 → 1/2/3 两段完成档位选择（弹层行内直选，
 *  ApprovalTierPopover 行内 keydown stopPropagation 防全局热键双触发）。
 *  面板 teleport 到 body 且无实例内指针，焦点查找只此一处 DOM 查询（多面板
 *  在场时首卡面板 DOM 序在前，与 pendingList 首张目标一致） */
async function requestAllowAlways(id: string): Promise<void> {
  // 折叠态（P-20261003-25）目标卡可能未渲染（只完整展示最新一张）——先展开
  // 全堆再弹该卡弹层，档位面锚在真实卡上（P-126「看得见才放行」的全局
  // 语义防护在折叠态不缩水，也避免 teleported 面板锚在隐藏触发器上错位）
  if (!visibleList.value.some(a => a.id === id)) {
    stackExpanded.value = true
    await nextTick()
  }
  cardInsts.get(id)?.showAllowAlwaysConfirm()
  await nextTick()
  document.querySelector<HTMLElement>('.aprv-tier-pop .aprv-tier-opt')?.focus()
}

// 键位映射与守卫在 useApprovalHotkeys；裁决走 useApprovalActions.decide
// （toast/错误降级与按钮点击同口径）
useApprovalHotkeys({
  allowOnce: (id) => void decide(id, true),
  requestAllowAlways: (id) => void requestAllowAlways(id),
  deny: (id) => void decide(id, false),
})

// ---- 拒绝理由（P-20261003-21）：跨卡单开状态在宿主，卡内渲染见 ApprovalCard ----

// 同屏至多展开一张卡的输入行（逐卡点拒绝互不串扰）；展开即清空聚焦，取消/
// Esc 收起不清账。开行后经卡实例 focusDenyInput 聚焦（nextTick 后输入行已
// 挂载，时序与拆分前函数 ref 直采一致）
const denyOpenId = ref('')
const denyReason = ref('')
function openDeny(id: string): void {
  denyOpenId.value = id
  denyReason.value = ''
  void nextTick(() => cardInsts.get(id)?.focusDenyInput())
}
function closeDeny(): void {
  denyOpenId.value = ''
  denyReason.value = ''
}
/** 确认拒绝：trim 后随 resolve 下发（空串不下发 reason 键 = 原行为零变化） */
function confirmDeny(id: string): void {
  const reason = denyReason.value.trim()
  closeDeny()
  void decide(id, false, false, reason)
}
</script>

<template>
  <div
    v-if="stackVisible"
    class="aprv-stack"
    :role="hasPending ? 'alertdialog' : undefined"
    :aria-label="hasPending ? t('agentTerminal.approvalTitle') : undefined"
  >
    <!-- 首触说明条（P-20261003-311）：首张审批卡（未落「不再显示」标记）时
         堆顶在场，三行说明新用户认知层；渲染/展开收起/不再显示收口在共用
         组件（值班大屏同款同标记键），本组件只定挂载位（堆顶=卡顶）。
         随 P-226 容器在场条件扩展（无 pending 也可在场），说明条改随 pending
         在场——它只讲「怎么裁决」，没有待裁决卡时不该出现 -->
    <ApprovalGuideBar v-if="hasPending" />
    <!-- 模式自学习建议条（P-20261006-28）：近 7 天同前缀手动允许 ≥3 次且无
         规则覆盖时在场，一键进规则表单预填（非弹窗附属层，7 天同模式只
         建议一次；组件内部 v-if 兜底） -->
    <ApprovalRuleSuggestBar :suggestion="ruleSuggestion" />
    <!-- 摘要条（P-20261003-25）：仅超阈值在场，点击展开全堆/再点收起。折叠态
         角标亮出键盘裁决目标序号（恒最旧卡，与可见最新卡不同——防误裁决，
         悬停出目标卡操作摘要）；展开态目标卡全量可见，角标退场 -->
    <button
      v-if="needsCollapse"
      type="button"
      class="aprv-summary"
      data-test="aprv-summary"
      :title="stackCollapsed ? t('approval.stack.expand') : t('approval.stack.collapse')"
      @click="toggleStack"
    >
      <span class="aprv-dot" />
      <span
        class="aprv-summary-count"
        data-test="aprv-summary-count"
      >{{ t('approval.stack.summary', { n: approvals.pendingCount }) }}</span>
      <span
        v-if="stackCollapsed && hotkeyTarget"
        class="aprv-summary-target"
        data-test="aprv-summary-target"
        :title="hotkeyTarget.op"
      >{{ t('approval.stack.target', { total: approvals.pendingCount }) }}</span>
      <span class="aprv-summary-toggle">{{ stackCollapsed ? t('approval.stack.expand') : t('approval.stack.collapse') }}</span>
    </button>
    <!-- 单卡渲染拆至 ApprovalCard（P-20261003-87）：堆只决定渲染哪些卡
         （visibleList 折叠投影）与跨卡协调（理由单开/键盘键 2 转发） -->
    <ApprovalCard
      v-for="a in visibleList"
      :key="a.id"
      :ref="(inst) => setCardInst(a.id, inst)"
      v-model:deny-reason="denyReason"
      :record="a"
      :deny-open="denyOpenId === a.id"
      @open-deny="openDeny(a.id)"
      @confirm-deny="confirmDeny(a.id)"
      @close-deny="closeDeny"
      @open-recording="openRecording(a.id)"
      @open-replay="openReplay(a)"
    />
    <!-- 最近裁决（P-20261003-226）：堆尾只读回看入口。触发条 subdued 弱呈现，
         sticky bottom 与摘要条 sticky top 对偶（堆限高滚动时保持可达）；下拉
         面板条目只读（无重裁决——仅 pending 可裁决是服务端幂等约束，注记
         写明）。z-index 与放行档位弹层同档：抬过卡堆锚点（3000）、低于 modal -->
    <n-popover
      trigger="click"
      placement="top-end"
      :z-index="3100"
      raw
    >
      <template #trigger>
        <div class="aprv-recent-trigger-wrap">
          <button
            type="button"
            class="aprv-recent-trigger"
            data-test="aprv-recent-trigger"
            :aria-label="t('approval.recent.trigger')"
          >
            <span>{{ t('approval.recent.trigger') }}</span>
            <span
              v-if="approvals.recent.length > 0"
              class="aprv-recent-trigger-count"
              data-test="aprv-recent-trigger-count"
            >{{ approvals.recent.length }}</span>
          </button>
          <button
            type="button"
            class="aprv-recent-dismiss"
            data-test="aprv-recent-dismiss"
            :title="t('approval.recent.dismiss')"
            :aria-label="t('approval.recent.dismiss')"
            @click.stop="dismissRecent"
          >✕</button>
        </div>
      </template>
      <div
        class="aprv-recent"
        data-test="aprv-recent"
        role="region"
        :aria-label="t('approval.recent.trigger')"
      >
        <div
          v-if="approvals.recent.length === 0"
          class="aprv-recent-empty"
          data-test="aprv-recent-empty"
        >
          {{ t('approval.recent.empty') }}
        </div>
        <div
          v-for="a in approvals.recent"
          :key="a.id"
          class="aprv-recent-item"
          data-test="aprv-recent-item"
          :data-id="a.id"
          :title="recentTitle(a)"
        >
          <span
            class="aprv-recent-status"
            :data-status="a.status"
          >{{ a.status === 'denied' ? t('approval.recent.denied') : t('approval.recent.allowed') }}</span>
          <span class="aprv-recent-main">
            <span class="aprv-recent-op">{{ maskApprovalSecrets(a.op) }}</span>
            <span
              v-if="a.target"
              class="aprv-recent-target"
            >{{ maskApprovalSecrets(a.target) }}</span>
          </span>
          <span class="aprv-recent-time">{{ recentTime(a) }}</span>
        </div>
        <div
          v-if="approvals.recent.length > 0"
          class="aprv-recent-note"
          data-test="aprv-recent-note"
        >
          {{ t('approval.recent.readonly') }}
        </div>
        <!-- 裁决历史 CSV 导出（P-20261003-247）：本地下拉只回看最近 10 条，
             全量历史走服务端导出（审计 CSV 同模式）；有回看记录才可达（空态
             无历史可带，按钮不出现——诚实空态不提供必然 0 行的文件） -->
        <n-button
          v-if="approvals.recent.length > 0"
          size="tiny"
          quaternary
          :loading="exportingRecent"
          :title="t('approval.recent.exportCsvTip')"
          :aria-label="t('approval.recent.exportCsvTip')"
          class="aprv-recent-export"
          data-test="aprv-recent-export"
          @click="exportRecentCsv"
        >
          {{ t('approval.recent.exportCsv') }}
        </n-button>
      </div>
    </n-popover>
  </div>
  <!-- 过程实况浏览（P-20261001-15）：焦点=发起审批；模态独立于卡片堆 v-if -->
  <RecordingBrowser
    v-model:show="showRecording"
    :focus-approval-id="recordingApprovalId"
  />
  <!-- 会话回放（P-20261002-82）：发起会话的 Claude 时间线，定位到审批时刻 -->
  <SessionReplayModal
    :show="!!replaySession"
    :session="replaySession"
    :focus-at="replayFocusAt"
    @update:show="(v: boolean) => { if (!v) replaySession = null }"
  />
</template>

<style scoped>
/* 定位由 App 层 .agent-input-stack 包装承载（审批+提问共锚点堆叠），
   本组件只负责纵向排列自身卡片。展开态（P-20261003-25）全堆可能高过视口
   （fixed 锚点自底向上生长）——限高转内部滚动，摘要条 sticky 钉在可视顶，
   展开多卡时「收起」入口仍可达（≤阈值不触发，呈现与原先一致）。
   单卡视觉（.aprv-card 族）在 ApprovalCard.vue 同名段（scoped 不跨组件） */
.aprv-stack {
  display: flex; flex-direction: column; gap: 8px; width: 100%;
  max-height: calc(100vh - 96px); overflow-y: auto;
}
/* 摘要条（P-20261003-25）：虚线边与卡片实线区分层次，点击切换展开/收起；
   堆限高滚动后 sticky 钉顶，全堆展开溢出视口时切换入口仍可达 */
.aprv-summary {
  appearance: none; font: inherit; line-height: 1.4; text-align: left;
  display: flex; align-items: center; gap: 8px; width: 100%;
  background: var(--bg-panel); border: 1px dashed var(--status-waiting);
  border-radius: 8px; padding: 6px 12px; cursor: pointer;
  color: var(--text-secondary); font-size: 0.8em;
  position: sticky; top: 0; z-index: 1;
}
.aprv-summary-count { font-weight: 600; color: var(--text-primary); }
.aprv-summary-target {
  color: var(--text-secondary); border: 1px solid var(--status-waiting);
  border-radius: 4px; padding: 0 6px;
}
.aprv-summary-toggle { margin-left: auto; opacity: 0.85; }
/* 摘要条点与卡头点同形——scoped 样式不跨组件，与 ApprovalCard.vue 各持一份 */
.aprv-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--status-waiting);
  animation: aprv-pulse 1.2s ease-in-out infinite;
}
@keyframes aprv-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .aprv-dot { animation: none; }
}
/* 最近裁决触发条（P-20261003-226）：堆尾只读回看入口。虚线边走中立色
   （border-subtle）不与 pending 卡的警示虚线（status-waiting 等待档）争视觉；
   sticky bottom 与摘要条 sticky top 对偶——堆限高滚动后触发条钉在可视底，
   折叠多卡时回看入口仍可达 */
.aprv-recent-trigger-wrap {
  position: sticky; bottom: 0; z-index: 1;
  display: flex; align-items: center; gap: 6px; width: 100%;
}
.aprv-recent-trigger {
  appearance: none; font: inherit; line-height: 1.4; text-align: left;
  display: flex; align-items: center; gap: 6px; width: 100%;
  background: var(--bg-panel); border: 1px dashed var(--border-subtle);
  border-radius: 8px; padding: 4px 12px; cursor: pointer;
  color: var(--text-secondary); font-size: 0.76em;
}
.aprv-recent-dismiss {
  appearance: none; font: inherit; flex-shrink: 0;
  width: 22px; height: 22px; display: inline-flex;
  align-items: center; justify-content: center;
  background: transparent; border: none; border-radius: 6px;
  color: var(--text-faint); font-size: 12px; cursor: pointer;
}
.aprv-recent-dismiss:hover {
  color: var(--text-primary); background: color-mix(in srgb, var(--text-faint) 15%, transparent);
}
.aprv-recent-trigger:hover,
.aprv-recent-trigger:focus-visible {
  color: var(--text-primary); border-color: var(--status-waiting);
}
.aprv-recent-trigger:focus-visible {
  outline: 1px solid var(--status-waiting); outline-offset: 1px;
}
.aprv-recent-trigger-count {
  margin-left: auto; flex-shrink: 0; line-height: 1.5;
  color: var(--text-secondary); border: 1px solid var(--border-subtle);
  border-radius: 4px; padding: 0 6px;
}
/* 下拉面板（raw popover 内容样式自持，同 ApprovalTierPopover 手法；颜色全走
   主题变量）。条目只读——无按钮无点击语义，悬浮 title 出上下文（detail/理由） */
.aprv-recent {
  display: flex; flex-direction: column; gap: 2px;
  width: 300px; max-height: 320px; overflow-y: auto;
  background: var(--bg-panel); border: 1px solid var(--border-default);
  border-radius: 8px; padding: 8px; box-shadow: var(--shadow-pop-lg);
}
.aprv-recent-empty {
  font-size: 0.78em; color: var(--text-muted); text-align: center;
  padding: 10px 4px;
}
.aprv-recent-item {
  display: flex; align-items: baseline; gap: 6px; min-width: 0;
  padding: 4px 4px; border-radius: 6px;
}
.aprv-recent-item + .aprv-recent-item { border-top: 1px solid var(--border-subtle); }
.aprv-recent-status {
  flex-shrink: 0; font-size: 0.72em; line-height: 1.5;
  border: 1px solid currentColor; border-radius: 4px; padding: 0 5px;
  color: var(--text-secondary);
}
/* 结果分色（语义变量，四主题同名）：allowed 绿弱化、denied 红——与变更树
   状态色（utils/git STATUS_COLOR_MAP）同源变量 */
/* allowed 用 accent-green-dim 刻意弱档（回看面次级信息层级），色相与成功档同族 */
.aprv-recent-status[data-status='allowed'] { color: var(--accent-green-dim); }
.aprv-recent-status[data-status='denied'] { color: var(--status-failed); }
.aprv-recent-main {
  display: flex; flex-direction: column; gap: 1px;
  flex: 1; min-width: 0;
}
.aprv-recent-op {
  font-family: monospace; font-size: 0.78em; color: var(--text-primary);
  word-break: break-all;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  overflow: hidden;
}
.aprv-recent-target {
  font-size: 0.72em; color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.aprv-recent-time {
  flex-shrink: 0; margin-left: auto; font-size: 0.7em; color: var(--text-muted);
}
.aprv-recent-note {
  font-size: 0.7em; color: var(--text-muted); line-height: 1.5;
  border-top: 1px solid var(--border-subtle); padding: 4px 4px 0;
}
/* 导出按钮（P-20261003-247）：注记行尾的对齐小出口，占位独立一行不与条目
   争宽度（面板 300px 定宽） */
.aprv-recent-export {
  align-self: flex-start;
}
</style>
