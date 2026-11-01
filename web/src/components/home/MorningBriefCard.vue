<script setup lang="ts">
// 开工检查单横幅卡（P-20261005-219）：首页顶栏下的一屏聚合——未推送提交/
// 运行中 agent 会话/未读通知与待审批，逐项直达（进项目提交面板/会话中心/
// 通知中心）+ 未推送项一键 push。显隐纪律在 useMorningBrief + utils/morningBrief：
// 任一项非零且当日未已阅才显示，全零/全已阅 = 不渲染（零打扰）。组件自包含
// （LocaleSuggestBar 同款形态：挂载即拉取、解锁后补拉，动作不经装配点转发）。
import { computed, onMounted, watch } from 'vue'
import { NIcon } from 'naive-ui'
import { SunnyOutline, CloudUploadOutline, ChatbubblesOutline, NotificationsOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useMorningBrief } from '../../composables/useMorningBrief'
import { useNotificationStore } from '../../stores/notification'
import { useLockStore } from '../../stores/lock'
import { useAgentTerminal } from '../../composables/useAgentTerminal'

const emit = defineEmits<{ enter: [projectId: string] }>()

const { t } = useI18n()
const {
  brief, visibleItems, showCard, pushing,
  load, dismissToday, dismissItemToday, pushProject,
} = useMorningBrief()
const notificationStore = useNotificationStore()
const lockStore = useLockStore()
const agentTerminal = useAgentTerminal()

// 未推送项目行渲染上限：检查单是提醒面不是清单面（完整清单在项目提交面板），
// 超出折叠为计数行——极端多项目下卡片不无限长
const BRIEF_PROJECT_ROWS_MAX = 5
const unpushedShown = computed(() => brief.value?.unpushed?.projects.slice(0, BRIEF_PROJECT_ROWS_MAX) ?? [])
const unpushedOverflow = computed(() =>
  Math.max((brief.value?.unpushed?.projects.length ?? 0) - BRIEF_PROJECT_ROWS_MAX, 0),
)

const itemVisible = (key: 'unpushed' | 'runningAgents' | 'unread') => visibleItems.value.includes(key)

// 未读行的三形态文案（通知/审批组合）：unread.count 是「通知 + 待审批」总和
const unreadLine = computed(() => {
  const u = brief.value?.unread
  if (!u) return ''
  if (u.notifications > 0 && u.approvals > 0) return t('morningBrief.unreadAll', { count: u.count, notifications: u.notifications, approvals: u.approvals })
  if (u.notifications > 0) return t('morningBrief.unreadNotifyOnly', { count: u.notifications })
  return t('morningBrief.unreadApprovalsOnly', { count: u.approvals })
})

// 解锁后补拉：HomeView 常驻挂载（锁定遮罩只是覆盖层），锁定态挂载期的一次
// 拉取会被 423 拒（silent），解锁转换时重取（与项目清单解锁联动同款时序）
watch(() => lockStore.isLocked, (newVal, oldVal) => {
  if (oldVal && !newVal) void load()
})

onMounted(() => {
  void load()
})
</script>

<template>
  <Transition name="brief-card">
    <div
      v-if="showCard"
      class="brief-card"
      data-testid="morning-brief-card"
      role="region"
      :aria-label="t('morningBrief.title')"
    >
      <div class="brief-head">
        <n-icon
          size="14"
          class="brief-head-icon"
        >
          <SunnyOutline />
        </n-icon>
        <span class="brief-title">{{ t('morningBrief.title') }}</span>
        <span class="brief-spacer" />
        <button
          type="button"
          class="brief-action"
          data-testid="brief-ack-all"
          @click="dismissToday"
        >
          {{ t('morningBrief.ackAll') }}
        </button>
      </div>

      <!-- 未推送提交：逐项目行（点击进项目=提交面板），行内一键 push -->
      <div
        v-if="itemVisible('unpushed')"
        class="brief-group"
      >
        <div class="brief-row">
          <n-icon
            size="13"
            class="brief-row-icon"
          >
            <CloudUploadOutline />
          </n-icon>
          <span class="brief-text">
            {{ t('morningBrief.unpushedSummary', { count: brief?.unpushed?.count ?? 0, projects: brief?.unpushed?.projects.length ?? 0 }) }}
          </span>
          <span class="brief-spacer" />
          <button
            type="button"
            class="brief-mute"
            data-testid="brief-mute-unpushed"
            @click="dismissItemToday('unpushed')"
          >
            {{ t('morningBrief.muteToday') }}
          </button>
        </div>
        <div
          v-for="p in unpushedShown"
          :key="p.id"
          class="brief-row brief-row-sub"
          :data-testid="`brief-unpushed-${p.id}`"
        >
          <button
            type="button"
            class="brief-link"
            @click="emit('enter', p.id)"
          >
            {{ p.name }}
          </button>
          <span class="brief-ahead">×{{ p.ahead }}</span>
          <span class="brief-spacer" />
          <button
            type="button"
            class="brief-action"
            data-testid="brief-push"
            :disabled="pushing[p.id]"
            @click="pushProject(p)"
          >
            {{ t('morningBrief.push') }}
          </button>
        </div>
        <div
          v-if="unpushedOverflow > 0"
          class="brief-row brief-row-sub"
        >
          <span class="brief-more">{{ t('morningBrief.moreProjects', { count: unpushedOverflow }) }}</span>
        </div>
      </div>

      <!-- 运行中 agent 会话：直达会话中心 -->
      <div
        v-if="itemVisible('runningAgents')"
        class="brief-row"
      >
        <n-icon
          size="13"
          class="brief-row-icon"
        >
          <ChatbubblesOutline />
        </n-icon>
        <span class="brief-text">{{ t('morningBrief.agentsSummary', { count: brief?.runningAgents?.count ?? 0 }) }}</span>
        <span class="brief-spacer" />
        <button
          type="button"
          class="brief-action"
          data-testid="brief-open-sessions"
          @click="agentTerminal.open()"
        >
          {{ t('morningBrief.openSessions') }}
        </button>
        <button
          type="button"
          class="brief-mute"
          data-testid="brief-mute-agents"
          @click="dismissItemToday('runningAgents')"
        >
          {{ t('morningBrief.muteToday') }}
        </button>
      </div>

      <!-- 未读通知与待审批：直达通知中心（待审批卡同在此） -->
      <div
        v-if="itemVisible('unread')"
        class="brief-row"
      >
        <n-icon
          size="13"
          class="brief-row-icon"
        >
          <NotificationsOutline />
        </n-icon>
        <span class="brief-text">{{ unreadLine }}</span>
        <span class="brief-spacer" />
        <button
          type="button"
          class="brief-action"
          data-testid="brief-open-notifications"
          @click="notificationStore.toggle()"
        >
          {{ t('morningBrief.openNotifications') }}
        </button>
        <button
          type="button"
          class="brief-mute"
          data-testid="brief-mute-unread"
          @click="dismissItemToday('unread')"
        >
          {{ t('morningBrief.muteToday') }}
        </button>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 视觉对齐 LocaleSuggestBar 细横条形态：中性面板底 + accent 蓝点，是友好
   提醒面（非安全警示）不抢首屏注意力；出现在 .home-header 与 .home-content
   之间随 flex 自然排布，按行堆叠 */
.brief-card {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 6px 28px;
  font-size: var(--fs-small);
  color: var(--text-secondary);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
  gap: 2px;
}

.brief-head {
  display: flex;
  align-items: center;
  gap: 6px;
}

.brief-head-icon {
  color: var(--accent-blue);
}

.brief-title {
  font-weight: 600;
  color: var(--text-primary);
}

.brief-spacer {
  flex: 1;
}

.brief-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.brief-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}

.brief-row-sub {
  padding-left: 21px;
}

.brief-row-icon {
  color: var(--text-muted);
  flex-shrink: 0;
}

.brief-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 项目名即「直达提交面板」链接（进入项目后 git 底部 tab 为默认落点） */
.brief-link {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  color: var(--accent-blue);
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 320px;
}
.brief-link:hover {
  text-decoration: underline;
  text-underline-offset: 2px;
}

.brief-ahead {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.brief-more {
  color: var(--text-muted);
}

/* 动作钮（直达/推送/已阅）与静音钮（今天不再）两级视觉：前者可点色、后者弱化 */
.brief-action {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 2px 6px;
  font: inherit;
  color: var(--accent-blue);
  cursor: pointer;
  border-radius: 4px;
}
.brief-action:hover {
  background: color-mix(in srgb, var(--accent-blue) 10%, transparent);
}
.brief-action:disabled {
  color: var(--text-muted);
  cursor: default;
}

.brief-mute {
  flex-shrink: 0;
  border: none;
  background: none;
  padding: 2px 4px;
  font: inherit;
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
  opacity: 0.85;
}
.brief-mute:hover {
  opacity: 1;
}

/* 出现/消失淡入淡出（LocaleSuggestBar 同节奏） */
.brief-card-enter-active,
.brief-card-leave-active {
  transition: opacity var(--motion-slow) ease;
}
.brief-card-enter-from,
.brief-card-leave-to {
  opacity: 0;
}
</style>
