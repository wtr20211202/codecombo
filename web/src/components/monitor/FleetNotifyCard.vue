<script setup lang="ts">
// 跨实例通知卡（P-20261003-125）：值班大屏的「通知区」——fleet 各实例未读
// 水位与离线标记一卡速览，点击开聚合弹层看明细（MonitorView 宿主接线）。
// 数据走 useFleetNotifications（与聚合弹层同源）：挂载全量 load + 60s 静默
// 轮询既有块 + defineExpose refresh() 供大屏 refreshAll（R 键/刷新按钮）
// 同步刷新。常显卡：机群空闲空态时同样在位（MonitorView 在 isEmpty 守卫
// 之外渲染）。样式自包含镜像 mon-card 卡片语言——scoped 样式只有子组件
// 根节点会拿到父作用域（InstanceHealthCard 同款注记）。轮询失败不打扰
// 值守：块级降级为离线标记，下一轮自愈。
import { onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from '../../composables/useI18n'
import { useFleetNotifications } from '../../composables/useFleetNotify'

const POLL_MS = 60_000

const emit = defineEmits<{ (e: 'open'): void }>()
const { t } = useI18n()
const {
  instances, load, refreshAll, offlineCount,
  unreadErrorCount, unreadIssueCount, unreadByInstance,
} = useFleetNotifications()

let timer: ReturnType<typeof setInterval> | null = null

/** 挂载/手动刷新 = 块未建时全量装载，已建时静默重拉（60s 轮询同径） */
async function refresh(): Promise<void> {
  if (instances.value.length === 0) await load()
  else await refreshAll()
}
onMounted(() => {
  void refresh()
  timer = setInterval(() => void refresh(), POLL_MS)
})
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})
defineExpose({ refresh })

/** 状态点：红 = 有未读 error，黄 = 有未读 warning，灰 = 全部已读/暂无 */
function dotClass(): string {
  if (unreadErrorCount.value > 0) return 'is-error'
  if (unreadIssueCount.value > 0) return 'is-warn'
  return ''
}
</script>

<template>
  <article
    class="fnm-card"
    data-testid="monitor-fleet-notify-card"
    role="button"
    :aria-label="t('fleetNotify.openTip')"
    :title="t('fleetNotify.openTip')"
    @click="emit('open')"
  >
    <div class="fnm-head">
      <span
        class="fnm-dot"
        :class="dotClass()"
      />
      <span class="fnm-kind">{{ t('fleetNotify.title') }}</span>
      <span
        v-if="offlineCount > 0"
        class="fnm-offline"
        data-testid="monitor-fleet-notify-offline"
      >{{ t('fleetNotify.offlineShort', { n: offlineCount }) }}</span>
    </div>
    <div
      v-if="instances.length === 0"
      class="fnm-empty"
    >
      {{ t('fleetNotify.loading') }}
    </div>
    <div
      v-else
      class="fnm-grid"
    >
      <div
        v-for="b in instances"
        :key="b.id"
        class="fnm-item"
        data-testid="monitor-fleet-notify-instance"
      >
        <span
          class="fnm-name"
          :title="b.name"
        >{{ b.name }}</span>
        <span
          v-if="!b.isLocal && !b.reachable && !b.loading"
          class="fnm-tag"
        >{{ t('fleetNotify.unreachable') }}</span>
        <span
          v-else-if="(unreadByInstance.get(b.id) || 0) > 0"
          class="fnm-count"
          data-testid="monitor-fleet-notify-unread"
        >{{ unreadByInstance.get(b.id) }}</span>
        <span
          v-else
          class="fnm-zero"
        >0</span>
      </div>
    </div>
    <div class="fnm-foot">
      {{ t('fleetNotify.cardHint', { sec: 60 }) }}
    </div>
  </article>
</template>

<style scoped>
/* 镜像 mon-card 卡片语言（值班大屏 .mon-wall 网格内消费），见文件头注释 */
.fnm-card {
  background: var(--bg-panel);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  box-shadow: var(--shadow-soft);
  cursor: pointer;
  transition: border-color var(--motion-base);
}
.fnm-card:hover { border-color: var(--accent-blue); }
.fnm-head { display: flex; align-items: center; gap: 6px; min-width: 0; }
.fnm-kind { font-size: 11px; font-weight: 600; color: var(--text-muted); flex-shrink: 0; }
.fnm-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--text-muted);
}
.fnm-dot.is-error { background: var(--accent-red); }
.fnm-dot.is-warn { background: var(--accent-yellow-warm); }
.fnm-offline {
  margin-left: auto; font-size: 10px; color: var(--accent-red);
  border: 1px solid color-mix(in srgb, var(--accent-red) 45%, transparent);
  border-radius: 8px; padding: 0 6px; flex-shrink: 0;
}
.fnm-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 12px;
}
.fnm-item { display: flex; align-items: center; gap: 6px; min-width: 0; }
.fnm-name {
  flex: 1; min-width: 0;
  font-size: 12px; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.fnm-count {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  color: var(--accent-red);
  background: color-mix(in srgb, var(--accent-red) 12%, transparent);
  border-radius: 8px;
  padding: 0 6px;
}
.fnm-zero {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
}
.fnm-tag {
  flex-shrink: 0;
  font-size: 10px;
  color: var(--accent-red);
}
.fnm-empty { font-size: 12px; color: var(--text-muted); }
.fnm-foot { font-size: 11px; color: var(--text-muted); }
</style>
