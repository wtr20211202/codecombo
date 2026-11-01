<script setup lang="ts">
// agent 协作流卡（P-20261008-6）：值班大屏的「agent 间正在发生什么」——
// 定向消息（P-20261004-68）与接续链（P-20261004-38）三枚 ops 直通分发事件的
// 时间线聚合（「A → B 留言」「B 已读 N 条」「B 接续 A（第 n 棒）」）+ 链健康
// 侧栏（GET /api/agent-chains 全量回填：死链置灰 / 棒数 / 冷却注记）。
// 数据走 useCollabStream（纯事件驱动零轮询）：挂载回填一次链清单 +
// defineExpose refresh() 供大屏 refreshAll（R 键/刷新按钮）同步。
// 常显卡：实例空闲空态时同样在位（MonitorView 在 isEmpty 守卫之外渲染）。
// 行点击直达目标会话（P-68 通知 Action 同款——留言→目标会话、已读→拉取方、
// 接续→下一棒；会话不在册的行维持纯展示，无处可跳不装可点）。
// 样式自包含镜像 mon-card 卡片语言——scoped 样式只有子组件根节点会拿到父
// 作用域（ChangeStreamCard/FleetNotifyCard 同款注记）
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from '../../composables/useI18n'
import { useAssistantTaskStore } from '../../stores/assistantTask'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useAgentTerminal } from '../../composables/useAgentTerminal'
import {
  chainLegOf,
  useCollabStream,
  type CollabChainRow,
  type CollabMessageRow,
  type CollabReadRow,
  type CollabRow,
} from '../../composables/useCollabStream'
import { COLLAB_CHAIN_COOLDOWN_MS } from '../../composables/useCollabStream'
import { OPS_ACTIVATE_TERMINAL } from '../../utils/opsEvents'
import { relativeTimeParts } from '../../utils/relative-time'

const { t } = useI18n()
const router = useRouter()
const sessionsStore = useTerminalSessionsStore()
const { jumpToProjectSession } = useAgentTerminal()
const { rows, chainsFailed, chainsLoaded, chainsById, refreshChains } = useCollabStream()
// 30s 心跳时钟（assistantTask.nowTick，P-37 值班大屏同源）：本卡纯事件驱动
// 无轮询，「N 分钟前」相对时间与「冷却中」注记靠它随时间自愈
const assistantTask = useAssistantTaskStore()

// 进大屏回填一次链清单（时间线三事件源无历史端点，不可回放——上线即观察面）
onMounted(() => { void refreshChains() })
defineExpose({ refresh: () => refreshChains() })

/** 心跳时钟登记依赖（读 nowTick 进计算图，30s 推进一次重算） */
const clock = computed(() => {
  void assistantTask.nowTick
  return Date.now()
})

/** 会话显示名（列表对账后缺失降级会话 id——文案不谎称，agentchain
 * sourceSessionName 服务端同口径） */
function sessionName(id: string): string {
  return sessionsStore.sessions.find(s => s.id === id)?.name || id
}

function timeText(at: number): string {
  const { key, n } = relativeTimeParts(at, clock.value)
  return t(`agentTerminal.${key}`, { n })
}

/** 行主语跳转锚点：留言→目标会话（P-68 通知 Action 同款）、已读→拉取方、
 *  接续→下一棒（「走到哪了」看的就是新会话） */
function rowTargetId(row: CollabRow): string {
  if (row.kind === 'message') return (row as CollabMessageRow).toId
  if (row.kind === 'read') return (row as CollabReadRow).sessionId
  return (row as CollabChainRow).nextId
}

/** 行可点表：目标会话在会话清单内才可点（已结束/未知会话无处可跳，保持
 *  纯展示不装可点——ChangeStreamTimeline 行深链同裁决）。sessions 一次遍历
 *  建 Set 逐行 O(1)，行数 ≤60 非热路径 */
const clickableRowIds = computed(() => {
  const alive = new Set(sessionsStore.sessions.map(s => s.id))
  const m = new Map<string, boolean>()
  for (const row of rows.value) m.set(row.id, alive.has(rowTargetId(row)))
  return m
})

/** 行 title/aria：可点行动作的人读描述（消息行 hover 显完整去向） */
function rowTitle(row: CollabRow): string | undefined {
  if (!clickableRowIds.value.get(row.id)) return undefined
  return t('collabStream.openHint', { name: sessionName(rowTargetId(row)) })
}

/** 行点击直达（大屏既有跳转链，MonitorView.jumpSession 同款分流）：项目会话
 *  走接管归还 + 切项目 + 底部终端激活；系统会话回首页交 OPS 激活意图 */
async function jumpRow(row: CollabRow): Promise<void> {
  if (!clickableRowIds.value.get(row.id)) return
  const id = rowTargetId(row)
  const s = sessionsStore.sessions.find(x => x.id === id)
  if (s?.projectId) {
    await jumpToProjectSession(s.projectId, id, router)
    return
  }
  if (router.currentRoute.value.name !== 'home') await router.push({ name: 'home' })
  window.dispatchEvent(new CustomEvent(OPS_ACTIVATE_TERMINAL, { detail: { id } }))
}

/** 行文案：三形态各一模板（名字现场解析——重命名/列表对账随 sessions store
 *  响应式跟进） */
function rowText(row: CollabRow): string {
  if (row.kind === 'message') {
    const r = row as CollabMessageRow
    return t('collabStream.msgLine', { from: sessionName(r.fromId), to: sessionName(r.toId), summary: r.summary })
  }
  if (row.kind === 'read') {
    const r = row as CollabReadRow
    return t('collabStream.readLine', { session: sessionName(r.sessionId), n: r.count })
  }
  const r = row as CollabChainRow
  return t('collabStream.chainLine', { next: sessionName(r.nextId), source: sessionName(r.sourceId) })
}

/** 接续行的棒数徽标：链清单联查（chain.triggered 触发的重读到位后即时点亮） */
function rowLeg(row: CollabRow): number | null {
  if (row.kind !== 'chain') return null
  return chainLegOf(chainsById.value.get((row as CollabChainRow).chainId)?.triggerCount)
}

/** 链健康行视图（侧栏）：冷却是纯展示注记（30s 心跳内自愈退场），真值在
 *  服务端三道闸；lastStatus 非 launched = 上次发起失败（警示档） */
interface ChainHealthView {
  id: string
  alive: boolean
  sourceName: string
  triggerCount: number
  leg: number | null
  lastSessionName: string
  inCooldown: boolean
  failed: boolean
}
const chainViews = computed<ChainHealthView[]>(() => {
  void clock.value
  return [...chainsById.value.values()].map(c => {
    const lastAt = c.lastTriggeredAt ? Date.parse(c.lastTriggeredAt) : NaN
    return {
      id: c.id,
      alive: c.sourceAlive,
      sourceName: c.sourceName || c.sourceTerminalId,
      triggerCount: c.triggerCount ?? 0,
      leg: chainLegOf(c.triggerCount),
      lastSessionName: c.lastSessionId ? (sessionsStore.sessions.find(s => s.id === c.lastSessionId)?.name || c.lastSessionId) : '',
      inCooldown: Number.isFinite(lastAt) && clock.value - lastAt < COLLAB_CHAIN_COOLDOWN_MS,
      failed: !!c.lastStatus && c.lastStatus !== 'launched',
    }
  })
})
</script>

<template>
  <article
    class="acc-card"
    data-testid="monitor-agent-collab-card"
  >
    <div class="acc-head">
      <span class="acc-kind">{{ t('collabStream.title') }}</span>
      <span
        v-if="chainsFailed && chainsLoaded"
        class="acc-stale"
        data-testid="collab-chains-stale"
      >{{ t('collabStream.chainsStaleHint') }}</span>
    </div>
    <div class="acc-body">
      <div
        class="acc-stream"
        data-testid="collab-stream"
      >
        <template v-if="rows.length > 0">
          <component
            :is="clickableRowIds.get(row.id) ? 'button' : 'div'"
            v-for="row in rows"
            :key="row.id"
            class="acc-row"
            :class="{
              'is-chain': row.kind === 'chain',
              'is-read': row.kind === 'read',
              'is-failed-relay': row.kind === 'chain' && (row as CollabChainRow).status === 'failed',
            }"
            :type="clickableRowIds.get(row.id) ? 'button' : undefined"
            :data-testid="`collab-row-${row.kind}`"
            :title="rowTitle(row)"
            :aria-label="rowTitle(row)"
            @click="jumpRow(row)"
          >
            <span
              class="acc-dot"
              :class="row.kind"
            />
            <span class="acc-text">{{ rowText(row) }}</span>
            <span
              v-if="rowLeg(row) !== null"
              class="acc-leg"
            >{{ t('collabStream.legBadge', { n: rowLeg(row) }) }}</span>
            <span class="acc-time">{{ timeText(row.at) }}</span>
          </component>
        </template>
        <div
          v-else
          class="acc-empty"
          data-testid="collab-stream-empty"
        >
          {{ t('collabStream.empty') }}
        </div>
      </div>
      <aside
        v-if="chainViews.length > 0"
        class="acc-chains"
        data-testid="collab-chains"
      >
        <div class="acc-chains-title">
          {{ t('collabStream.chainsTitle') }}
        </div>
        <div
          v-for="c in chainViews"
          :key="c.id"
          class="acc-chain"
          :class="{ dead: !c.alive }"
          :data-testid="`collab-chain-${c.id}`"
        >
          <span
            class="acc-dot"
            :class="c.alive ? 'alive' : 'dead'"
            :title="t(c.alive ? 'agentchain.sourceAlive' : 'agentchain.sourceDead')"
          />
          <div class="acc-chain-main">
            <div
              class="acc-chain-source"
              :title="c.sourceName"
            >
              {{ c.sourceName }}
            </div>
            <div class="acc-chain-meta">
              <template v-if="c.leg !== null">
                {{ t('collabStream.chainLeg', { n: c.leg }) }}
              </template>
              <template v-else>
                {{ t('collabStream.chainNoTrigger') }}
              </template>
              · {{ t('agentchain.triggerCount', { n: c.triggerCount }) }}
            </div>
            <div
              v-if="c.lastSessionName"
              class="acc-chain-meta"
              :title="c.lastSessionName"
            >
              → {{ c.lastSessionName }}
            </div>
          </div>
          <span
            v-if="c.inCooldown"
            class="acc-flag"
          >{{ t('collabStream.cooldown') }}</span>
          <span
            v-else-if="c.failed"
            class="acc-flag is-failed"
          >{{ t('agentchain.lastErrorBadge') }}</span>
        </div>
      </aside>
    </div>
    <div class="acc-foot">
      {{ t('collabStream.cardHint') }}
    </div>
  </article>
</template>

<style scoped>
/* 镜像 mon-card 卡片语言（值班大屏 .mon-wall 网格内消费），见文件头注释 */
.acc-card {
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  box-shadow: var(--shadow-soft);
  /* 时间线是横向最宽的内容面：固定区整行铺开（mon-guide 同款全跨语法），
     留出「时间线 + 链健康侧栏」双栏宽度；单列窄屏自然回落单栏 */
  grid-column: 1 / -1;
}
.acc-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
.acc-kind {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  flex-shrink: 0;
}
.acc-stale {
  margin-left: auto;
  font-size: 10px;
  color: var(--accent-yellow-warm);
  flex-shrink: 0;
}
/* 双栏：时间线吃剩余宽，链健康侧栏定宽右挂；窄容器整体换行落回上下两段 */
.acc-body {
  display: flex;
  gap: 16px;
  min-width: 0;
  flex-wrap: wrap;
}
.acc-stream {
  flex: 1 1 340px;
  min-width: 0;
  /* 卡墙值守卡以速览为界：钳到 ~10 行高度，更旧的事件让位（ChangeStreamCard
     同口径），不把卡墙撑成滚动页 */
  max-height: 244px;
  overflow-y: auto;
}
.acc-empty {
  font-size: 12px;
  color: var(--text-muted);
}
.acc-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 3px 0;
  border-bottom: 1px solid var(--bg-border);
  font-size: 12px;
  color: var(--text-primary);
}
/* 可点行（button 语义）：清 button 默认面容、继承行排版（ChangeStreamTimeline
   同款）——hover 背景/焦点环/cursor 表达可点性 */
button.acc-row {
  appearance: none;
  background: none;
  border: none;
  border-bottom: 1px solid var(--bg-border);
  border-radius: 6px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--motion-base) ease;
}
button.acc-row:hover { background: var(--bg-hover); }
button.acc-row:focus-visible {
  outline: 1px solid var(--accent-blue);
  outline-offset: -1px;
}
.acc-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  align-self: center;
  background: var(--text-muted);
}
/* 三形态语义色（主题变量，与卡墙状态点同词汇）：留言蓝 / 接续绿 / 已读灰；
   失败档接续（onFailure 链，源 failed 也接力）转警示黄——接续本身是成功事实，
   但触发缘由是失败，值班判读需要这一眼 */
.acc-dot.message { background: var(--accent-blue); }
.acc-dot.chain { background: var(--status-running); }
.is-failed-relay .acc-dot.chain { background: var(--status-waiting); }
.is-failed-relay .acc-leg { color: var(--status-waiting); }
.acc-dot.read { background: var(--text-muted); }
.acc-dot.alive { background: var(--status-running); }
.acc-dot.dead { background: var(--text-muted); }
.acc-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acc-leg {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--status-running);
}
.acc-time {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}
/* 链健康侧栏：定宽右挂（窄容器 flex-wrap 整体换行） */
.acc-chains {
  flex: 0 1 230px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 244px;
  overflow-y: auto;
}
.acc-chains-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  padding-bottom: 4px;
}
.acc-chain {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 4px 0;
  border-bottom: 1px solid var(--bg-border);
}
/* 死链整行弱化（事实仍在册，源会话已关——AgentChainPanel 同语言） */
.acc-chain.dead { opacity: 0.55; }
.acc-chain-main { flex: 1; min-width: 0; }
.acc-chain-source {
  font-size: 12px;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acc-chain-meta {
  font-size: 11px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acc-flag {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1.6;
  padding: 0 6px;
  border-radius: 4px;
  color: var(--status-waiting);
  border: 1px solid color-mix(in srgb, var(--status-waiting) 55%, transparent);
}
.acc-flag.is-failed {
  color: var(--status-failed);
  border-color: color-mix(in srgb, var(--status-failed) 55%, transparent);
}
.acc-foot {
  font-size: 11px;
  color: var(--text-muted);
}
</style>
