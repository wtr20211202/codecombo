<script setup lang="ts">
/**
 * 接续链列表面板（P-20261004-38）：已建链的管理视图——源会话（死链置灰可删）、
 * 模板摘要、运行时、最近触发事实（时刻/下一棒/结果/累计次数）。可见性是模块级
 * 单例（useAgentChain），本组件全局唯一挂载（Layout.vue，CompareExperimentPanel
 * 同范式）；打开即拉列表，chain.triggered 广播（含本页之外的触发）驱动重读。
 */
import { computed, watch } from 'vue'
// 应用未全局注册 naive-ui：模板里用到的组件必须显式 import（历史回归教训）
import { NButton, NEmpty, NIcon, NModal, NSpin, NTooltip } from 'naive-ui'
import { RefreshOutline, TimeOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useAgentChain } from '../../composables/useAgentChain'
import type { AgentChainItem } from '../../api/domains/agentchain'

const { t } = useI18n()
const {
  panelShow, chains, loading, creating,
  refresh, removeChain,
} = useAgentChain()

const showRef = computed({
  get: () => panelShow.value,
  set: (v: boolean) => { panelShow.value = v },
})

// 打开即对账（他页/他标签页建的链也能见到；chain.triggered 广播承担打开期间的
// 增量重读，此处兜底打开时点的全量对账，CompareExperimentPanel 同范式）
watch(showRef, (v) => {
  if (v) void refresh()
})

/** 模板摘要：首行截 48 字符（列表面是扫读面，全文在 title） */
function templateSummary(c: AgentChainItem): string {
  const first = (c.promptTemplate || '').split('\n')[0] || ''
  return first.length > 48 ? `${first.slice(0, 48)}…` : first
}

function runtimeLabel(c: AgentChainItem): string {
  return c.runtime || t('agentTerminal.runtimeAuto')
}

/** 相对时间（通知中心 formatTime 同词汇，复用 notification.* 既有键零新增翻译面） */
function relTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60 * 1000) return t('notification.justNow')
  if (diff < 60 * 60 * 1000) return t('notification.minutesAgo', { n: Math.floor(diff / 60000) })
  if (diff < 24 * 60 * 60 * 1000) return t('notification.hoursAgo', { n: Math.floor(diff / 3600000) })
  return t('notification.daysAgo', { n: Math.floor(diff / 86400000) })
}

/** 最近触发文案：从未触发显示 —，否则相对时间（精确时刻在 title） */
function lastTriggerText(c: AgentChainItem): string {
  if (!c.lastTriggeredAt) return '—'
  return relTime(c.lastTriggeredAt)
}

/** 触发结果徽标语义色：launched 绿 / error 橙红 / 无中性 */
function statusClass(c: AgentChainItem): string {
  if (!c.lastStatus) return ''
  return c.lastStatus === 'launched' ? 'ok' : 'err'
}
</script>

<template>
  <n-modal
    v-model:show="showRef"
    preset="card"
    :title="t('agentchain.panelTitle')"
    style="width: var(--modal-w-lg); max-width: 94vw"
    :content-style="{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: '320px', maxHeight: '70vh' }"
    :mask-closable="true"
    data-testid="agentchain-panel"
  >
    <div class="acp-toolbar">
      <span class="acp-count">{{ t('agentchain.count', { n: chains.length }) }}</span>
      <n-button
        size="tiny"
        quaternary
        :title="t('common.refresh')"
        data-testid="agentchain-refresh"
        @click="() => { void refresh() }"
      >
        <template #icon>
          <n-icon><RefreshOutline /></n-icon>
        </template>
      </n-button>
    </div>
    <div
      v-if="loading && chains.length === 0"
      class="acp-center"
    >
      <n-spin size="small" />
    </div>
    <n-empty
      v-else-if="chains.length === 0"
      :description="t('agentchain.empty')"
      class="acp-center"
    />
    <div
      v-else
      class="acp-list"
    >
      <div
        v-for="c in chains"
        :key="c.id"
        class="acp-item"
        :class="{ dead: !c.sourceAlive }"
        :data-testid="`agentchain-item-${c.id}`"
      >
        <span
          class="acp-dot"
          :class="c.sourceAlive ? 'alive' : 'dead'"
          :title="t(c.sourceAlive ? 'agentchain.sourceAlive' : 'agentchain.sourceDead')"
        />
        <div class="acp-main">
          <div class="acp-line1">
            <span
              class="acp-source"
              :title="c.sourceName || c.sourceTerminalId"
            >{{ c.sourceName || c.sourceTerminalId }}</span>
            <span class="acp-arrow">→</span>
            <span
              class="acp-template"
              :title="c.promptTemplate"
            >{{ templateSummary(c) }}</span>
          </div>
          <div class="acp-line2">
            <span class="acp-chip">{{ runtimeLabel(c) }}</span>
            <span
              v-if="c.onFailure"
              class="acp-chip warn"
            >{{ t('agentchain.onFailureBadge') }}</span>
            <span
              class="acp-chip"
              :class="statusClass(c)"
              :title="c.lastTriggeredAt ? `${t('agentchain.lastTriggered')} ${new Date(c.lastTriggeredAt).toLocaleString()}` : t('agentchain.lastTriggered')"
            >
              <n-icon size="11"><TimeOutline /></n-icon>
              {{ lastTriggerText(c) }}
            </span>
            <span
              v-if="c.triggerCount"
              class="acp-chip"
            >{{ t('agentchain.triggerCount', { n: c.triggerCount }) }}</span>
            <n-tooltip
              v-if="c.lastStatus && c.lastStatus !== 'launched'"
              trigger="hover"
            >
              <template #trigger>
                <span class="acp-chip err">{{ t('agentchain.lastErrorBadge') }}</span>
              </template>
              {{ c.lastStatus }}
            </n-tooltip>
          </div>
        </div>
        <n-button
          size="tiny"
          quaternary
          class="acp-del"
          :disabled="creating"
          :title="t('common.delete')"
          :data-testid="`agentchain-delete-${c.id}`"
          @click="() => { void removeChain(c.id) }"
        >
          {{ t('common.delete') }}
        </n-button>
      </div>
    </div>
    <div class="acp-foot">
      {{ t('agentchain.panelHint') }}
    </div>
  </n-modal>
</template>

<style scoped>
.acp-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.acp-count {
  font-size: 0.8em;
  color: var(--text-muted);
}
.acp-center {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.acp-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  border: 1px solid var(--border-default);
  border-radius: 6px;
}
.acp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-default);
  min-width: 0;
}
.acp-item:last-child {
  border-bottom: none;
}
.acp-item:hover {
  background: var(--bg-hover);
}
/* 死链置灰：定义保留可删，但不再触发（服务端存活校验同口径） */
.acp-item.dead {
  opacity: 0.55;
}
.acp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.acp-dot.alive {
  background: var(--accent-green);
}
.acp-dot.dead {
  background: var(--text-tertiary);
}
.acp-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.acp-line1 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 0.8em;
  color: var(--text-primary);
}
.acp-source {
  flex-shrink: 0;
  max-width: 32%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.acp-arrow {
  flex-shrink: 0;
  color: var(--text-muted);
}
.acp-template {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.acp-line2 {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 0.72em;
  color: var(--text-muted);
}
.acp-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 5px;
  border-radius: 2px;
  background: color-mix(in srgb, var(--text-muted) 12%, transparent);
}
.acp-chip.ok {
  color: var(--accent-green);
}
.acp-chip.warn,
.acp-chip.err {
  color: var(--accent-yellow-warm);
}
.acp-del {
  flex-shrink: 0;
  opacity: 0;
}
.acp-item:hover .acp-del {
  opacity: 1;
}
.acp-foot {
  font-size: 0.76em;
  color: var(--text-muted);
  line-height: 1.5;
}
</style>
