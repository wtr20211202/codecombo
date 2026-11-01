<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NIcon, NModal, NSpin } from 'naive-ui'
import { NotificationsOutline, RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useNotificationStore } from '../../stores/notification'
import {
  useFleetNotifications, notifyTitle, notifyBody,
  type FleetNotifyInstance, type FleetNotifyRow,
} from '../../composables/useFleetNotify'

/**
 * 跨实例通知聚合（P-20261003-125）：值班面的「所有实例的异常」一屏看——
 * 本机 + 各远程实例的通知统一列表（error/warning 优先排序，实例徽标随行）。
 * 只读聚合：行无任何操作（已读/移除/延后属跨实例写，不引入；本机操作回
 * 通知中心——头部按钮直开），拉取失败实例在徽标区标离线不拖垮整体。
 * 打开即全量装载（重取实例列表，新注册实例即现），「全部刷新」静默重拉
 * 既有块。宿主：Layout（命令面板 / 实例菜单 / 实例族总览联动入口）与
 * 值班大屏（通知卡联动入口），两处各自实例化、数据经 useFleetNotify 同源。
 */
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const { t } = useI18n()
const notificationStore = useNotificationStore()
const {
  instances, loading, load, refreshAll, aggregated,
  offlineCount, unreadByInstance,
} = useFleetNotifications()

// 实例徽标过滤（'' = 全部实例）与范围过滤（全部/异常/未读），二者正交叠加
const activeInstance = ref('')
const activeFilter = ref<'all' | 'issues' | 'unread'>('all')
const filters = computed(() => [
  { key: 'all' as const, label: t('fleetNotify.filterAll') },
  { key: 'issues' as const, label: t('fleetNotify.filterIssues') },
  { key: 'unread' as const, label: t('fleetNotify.filterUnread') },
])

watch(() => props.show, (v) => {
  if (v) {
    activeInstance.value = ''
    activeFilter.value = 'all'
    void load()
  }
})

/** 本机操作回通知中心（只读聚合的出口：写操作只在自己实例的通知中心做） */
function openLocalCenter() {
  emit('update:show', false)
  notificationStore.open()
}

const visibleRows = computed<FleetNotifyRow[]>(() => aggregated.value.filter((r) => {
  if (activeInstance.value !== '' && r.instanceId !== activeInstance.value) return false
  if (activeFilter.value === 'unread') return !r.item.read
  if (activeFilter.value === 'issues') return r.item.type === 'error' || r.item.type === 'warning'
  return true
}))

/** 徽标悬停提示：可达 = 点击过滤，离线 = 未计入说明 */
function chipTitle(b: FleetNotifyInstance): string {
  if (!b.isLocal && !b.reachable && !b.loading) return t('fleetNotify.chipTipOffline')
  return t('fleetNotify.chipTipOnline')
}
function chipDotClass(b: FleetNotifyInstance): string {
  if (b.isLocal) return 'is-local'
  if (b.loading) return 'is-loading'
  return b.reachable ? 'is-online' : 'is-offline'
}
/** 行悬停全文：标题 + 正文 + 绝对时间（聚合行单行截断，全文看 title） */
function rowTitle(r: FleetNotifyRow): string {
  const abs = new Date(r.item.time).toLocaleString()
  const body = notifyBody(r.item, t)
  return body ? `${r.instanceName} · ${notifyTitle(r.item, t)}\n${body}\n${abs}` : `${r.instanceName} · ${notifyTitle(r.item, t)} · ${abs}`
}

/** 相对时间（notification.justNow/minutesAgo 同族文案，与通知中心口径一致） */
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff) || diff < 60_000) return t('notification.justNow')
  if (diff < 3_600_000) return t('notification.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('notification.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  return t('notification.daysAgo', { n: Math.floor(diff / 86_400_000) })
}
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    style="width: var(--modal-w-lg); max-width: 94vw"
    :title="t('fleetNotify.title')"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <template #header-extra>
      <!-- 只读聚合的出口：写操作回本实例通知中心 -->
      <n-button
        size="tiny"
        quaternary
        data-testid="fleet-notify-open-center"
        :title="t('fleetNotify.openCenter')"
        @click="openLocalCenter"
      >
        <template #icon>
          <n-icon size="12">
            <NotificationsOutline />
          </n-icon>
        </template>
        {{ t('fleetNotify.openCenter') }}
      </n-button>
      <n-button
        size="tiny"
        quaternary
        data-testid="fleet-notify-refresh"
        :loading="loading"
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

    <div
      class="fno-meta"
      data-testid="fleet-notify-summary"
    >
      {{ t('fleetNotify.summary', { n: aggregated.length, m: instances.length }) }}
    </div>
    <!-- 离线注记：不可达实例的通知未计入（拉取失败不拖垮整体的可视面） -->
    <div
      v-if="offlineCount > 0"
      class="fno-offline"
      data-testid="fleet-notify-offline"
    >
      {{ t('fleetNotify.offlineNote', { n: offlineCount }) }}
    </div>

    <!-- 实例徽标行：状态点 + 名称 + 未读数；点击过滤该实例（再点取消） -->
    <div class="fno-chips">
      <button
        v-for="b in instances"
        :key="b.id"
        class="fno-chip"
        data-testid="fleet-notify-chip"
        :class="{ active: activeInstance === b.id, offline: !b.isLocal && !b.reachable && !b.loading }"
        :title="chipTitle(b)"
        @click="activeInstance = activeInstance === b.id ? '' : b.id"
      >
        <span
          class="fno-chip-dot"
          :class="chipDotClass(b)"
        />
        <span class="fno-chip-name">{{ b.name }}</span>
        <span
          v-if="!b.isLocal && !b.reachable && !b.loading"
          class="fno-chip-off"
        >{{ t('fleetNotify.unreachable') }}</span>
        <span
          v-else-if="(unreadByInstance.get(b.id) || 0) > 0"
          class="fno-chip-count"
        >{{ unreadByInstance.get(b.id) }}</span>
      </button>
    </div>

    <!-- 范围过滤：全部 / 异常（error+warning）/ 未读 -->
    <div class="fno-filters">
      <button
        v-for="f in filters"
        :key="f.key"
        class="fno-filter"
        :class="{ active: activeFilter === f.key }"
        @click="activeFilter = f.key"
      >
        {{ f.label }}
      </button>
    </div>

    <n-spin :show="loading">
      <div
        class="fno-list"
        data-testid="fleet-notify-list"
      >
        <div
          v-if="visibleRows.length === 0"
          class="fno-empty"
          data-testid="fleet-notify-empty"
        >
          {{ loading ? t('fleetNotify.loading') : t('fleetNotify.empty') }}
        </div>
        <!-- 只读行：无任何操作按钮（跨实例写不引入）；悬停看全文 -->
        <div
          v-for="r in visibleRows"
          :key="r.instanceId + ':' + r.item.id"
          class="fno-row"
          data-testid="fleet-notify-row"
          :class="[`is-${r.item.type}`, { unread: !r.item.read }]"
          :title="rowTitle(r)"
        >
          <span class="fno-dot" />
          <span
            class="fno-inst"
            :title="r.instanceName"
          >{{ r.instanceName }}</span>
          <span class="fno-main">
            <span class="fno-title">{{ notifyTitle(r.item, t) }}</span>
            <span
              v-if="r.item.projectName"
              class="fno-proj"
            >{{ r.item.projectName }}</span>
          </span>
          <span class="fno-time">{{ relTime(r.item.time) }}</span>
        </div>
      </div>
    </n-spin>
  </n-modal>
</template>

<style scoped>
.fno-meta {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}
/* 离线注记条：警示黄弱样式（与 .iso-refreshed.stale 同族），只提示不阻塞 */
.fno-offline {
  font-size: 11px;
  color: var(--accent-yellow-warm);
  border: 1px solid color-mix(in srgb, var(--accent-yellow-warm) 45%, transparent);
  border-radius: 6px;
  padding: 4px 8px;
  margin-bottom: 8px;
}
.fno-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
}
.fno-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--border-default);
  border-radius: 12px;
  background: var(--bg-surface);
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  cursor: pointer;
  max-width: 180px;
}
.fno-chip:hover { border-color: var(--accent-blue); color: var(--text-primary); }
.fno-chip.active { border-color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 10%, transparent); color: var(--text-primary); }
.fno-chip.offline { border-style: dashed; color: var(--text-tertiary); }
.fno-chip-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.fno-chip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-muted);
}
.fno-chip-dot.is-local { background: var(--accent-blue); }
.fno-chip-dot.is-online { background: var(--accent-green); }
.fno-chip-dot.is-offline { background: var(--accent-red); }
.fno-chip-count {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  color: var(--accent-red);
  background: color-mix(in srgb, var(--accent-red) 12%, transparent);
  border-radius: 8px;
  padding: 0 5px;
}
.fno-chip-off {
  font-size: 10px;
  color: var(--accent-red);
}
.fno-filters {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}
.fno-filter {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
}
.fno-filter:hover { background: var(--bg-hover); color: var(--text-primary); }
.fno-filter.active {
  background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
  color: var(--accent-blue);
  font-weight: 600;
}
.fno-list {
  max-height: 52vh;
  overflow-y: auto;
  min-height: 120px;
}
.fno-empty {
  font-size: 12px;
  color: var(--text-tertiary);
  text-align: center;
  padding: 40px 0;
}
.fno-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 6px;
  font-size: 12px;
  border-radius: 4px;
  position: relative;
  /* 大列表渲染优化（通知中心 .nc-item 同款）：视口外行跳过布局/绘制 */
  content-visibility: auto;
  contain-intrinsic-size: auto 30px;
}
.fno-row:hover { background: var(--bg-hover); }
/* 未读：品牌色左条 + 未弱化；已读：标题弱化 */
.fno-row.unread::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--brand-accent);
}
.fno-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--text-muted);
}
.fno-row.is-error .fno-dot { background: var(--accent-red); }
.fno-row.is-warning .fno-dot { background: var(--accent-orange); }
.fno-row.is-success .fno-dot { background: var(--accent-green); }
.fno-row.is-info .fno-dot { background: var(--accent-blue); }
.fno-inst {
  flex-shrink: 0;
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border-radius: 6px;
  padding: 0 6px;
  line-height: 16px;
}
.fno-main {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.fno-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}
.fno-row:not(.unread) .fno-title { color: var(--text-tertiary); }
.fno-proj {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-muted);
  background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
  padding: 0 5px;
  border-radius: 3px;
}
.fno-time {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--font-mono);
  color: var(--text-muted);
}
</style>
