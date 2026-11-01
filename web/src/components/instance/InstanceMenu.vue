<script setup lang="ts">
// 实例切换下拉面板：状态点 + URL 副行 + 当前 ✓ + 操作行
// 自定义 popover 替代 NDropdown 纯文本选项（NDropdown 难以渲染两行结构）
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { NIcon } from 'naive-ui'
import { AddOutline, GridOutline, SettingsOutline, CheckmarkOutline, RefreshOutline, GitNetworkOutline, NotificationsOutline } from '@vicons/ionicons5'
import { useInstanceStore, type Instance } from '../../stores/instance'
import { useI18n } from '../../composables/useI18n'
import { getInstanceDotColor, getInstanceHost, getInstanceDisplayName } from './instanceStatus'

const props = defineProps<{
  show: boolean
  x: number
  y: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'select', id: string): void
  (e: 'add'): void
  (e: 'manage'): void
  (e: 'sessions'): void
  (e: 'fleet'): void
  (e: 'notify'): void
}>()

const instanceStore = useInstanceStore()
const { t } = useI18n()

const panelRef = ref<HTMLElement | null>(null)
const refreshing = ref(false)

// 面板宽度：夹紧计算与渲染共用同一来源
const MENU_WIDTH = 264

// 视口右缘夹紧，避免小窗口下面板溢出
const panelX = computed(() => {
  const max = window.innerWidth - MENU_WIDTH - 8
  return Math.max(8, Math.min(props.x, max))
})

// 垂直方向选择：锚点在下半屏（窄屏「更多」抽屉里的实例入口、底部工具栏）
// 时向上展开——固定向下会在手机底栏外溢出；桌面顶部活动栏仍向下（原行为）
const panelStyle = computed(() => {
  const base = { left: panelX.value + 'px', width: MENU_WIDTH + 'px' }
  if (props.y > window.innerHeight / 2) {
    return { ...base, bottom: (window.innerHeight - props.y + 6) + 'px' }
  }
  return { ...base, top: props.y + 'px' }
})

function subline(inst: Instance): string {
  const host = getInstanceHost(inst)
  return inst.version ? `${host} · v${inst.version}` : host
}

// 手动刷新按钮：强制重拉列表 + 全量探测（绕过 store 的探测 TTL）
async function refresh() {
  refreshing.value = true
  try {
    await instanceStore.ensureInstancesFresh(true)
  } finally {
    refreshing.value = false
  }
}

// 打开面板时轻量刷新：列表为空才重拉，否则走 TTL 内的状态复用
watch(() => props.show, (v) => {
  if (v) void instanceStore.ensureInstancesFresh()
})

// 点击外部关闭：锚定按钮（.instance-indicator）由父组件 toggle 处理，跳过
function handleOutside(e: MouseEvent) {
  if (!props.show) return
  const target = e.target as HTMLElement
  if (panelRef.value?.contains(target)) return
  if (target.closest('.instance-indicator')) return
  emit('close')
}

function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.show) emit('close')
}

onMounted(() => {
  document.addEventListener('mousedown', handleOutside)
  document.addEventListener('keydown', handleKeydown)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', handleOutside)
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Transition name="menu-fade">
    <div
      v-if="props.show"
      ref="panelRef"
      class="menu-panel"
      :style="panelStyle"
    >
      <div class="menu-header">
        <span class="menu-title">{{ t('instance.instances') }}</span>
        <button
          class="menu-refresh"
          :title="t('instance.refreshStatus')"
          @click="refresh"
        >
          <n-icon
            size="13"
            :class="{ spinning: refreshing }"
          >
            <RefreshOutline />
          </n-icon>
        </button>
      </div>

      <div class="menu-list">
        <button
          v-for="inst in instanceStore.orderedInstances"
          :key="inst.id"
          class="instance-row"
          :class="{ current: inst.id === instanceStore.currentInstanceId }"
          @click="emit('select', inst.id)"
        >
          <span
            class="status-dot"
            :style="{ background: getInstanceDotColor(inst) }"
          />
          <span class="row-main">
            <span class="row-name">{{ getInstanceDisplayName(inst) }}</span>
            <span class="row-sub">{{ subline(inst) }}</span>
          </span>
          <n-icon
            v-if="inst.id === instanceStore.currentInstanceId"
            size="14"
            class="row-check"
          >
            <CheckmarkOutline />
          </n-icon>
        </button>
      </div>

      <div class="menu-divider" />

      <button
        class="action-row"
        @click="emit('add')"
      >
        <n-icon size="14">
          <AddOutline />
        </n-icon>
        <span>{{ t('instance.addRemote') }}</span>
      </button>
      <button
        class="action-row"
        @click="emit('sessions')"
      >
        <n-icon size="14">
          <GridOutline />
        </n-icon>
        <span>{{ t('instanceSessions.title') }}</span>
      </button>
      <!-- 实例族总览（P-20261003-56）：同机多实例 fleet 一览 -->
      <button
        class="action-row"
        data-testid="menu-instance-fleet"
        @click="emit('fleet')"
      >
        <n-icon size="14">
          <GitNetworkOutline />
        </n-icon>
        <span>{{ t('fleet.title') }}</span>
      </button>
      <!-- 跨实例通知聚合（P-20261003-125）：fleet 值守面，所有实例异常一屏看 -->
      <button
        class="action-row"
        data-testid="menu-fleet-notify"
        @click="emit('notify')"
      >
        <n-icon size="14">
          <NotificationsOutline />
        </n-icon>
        <span>{{ t('fleetNotify.title') }}</span>
      </button>
      <button
        class="action-row"
        @click="emit('manage')"
      >
        <n-icon size="14">
          <SettingsOutline />
        </n-icon>
        <span>{{ t('instance.manage') }}</span>
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.menu-panel {
  position: fixed;
  z-index: 1800;
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  box-shadow: var(--shadow-strong);
  padding: 4px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px 4px;
}
.menu-title {
  font-size: 11px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.menu-refresh {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  padding: 3px;
  border-radius: 4px;
  display: inline-flex;
}
.menu-refresh:hover { background: var(--bg-hover); color: var(--text-primary); }
/* .spinning 旋转动画由 App.vue 全局提供 */

.menu-list {
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px;
}
.instance-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background var(--motion-fast);
}
.instance-row:hover { background: var(--bg-hover); }
.instance-row.current { background: var(--bg-active); }
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.row-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1;
}
.row-name {
  font-size: 12.5px;
  color: var(--text-primary);
  font-family: var(--font-ui);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.instance-row.current .row-name { font-weight: 500; }
.row-sub {
  font-size: 10.5px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-check { color: var(--accent-blue); flex-shrink: 0; }

.menu-divider { height: 1px; background: var(--border-subtle); margin: 4px 6px; }
.action-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12.5px;
  font-family: var(--font-ui);
  cursor: pointer;
  text-align: left;
  width: 100%;
  transition: background var(--motion-fast);
}
.action-row:hover { background: var(--bg-hover); color: var(--text-primary); }

.menu-fade-enter-active,
.menu-fade-leave-active { transition: opacity var(--motion-base), transform var(--motion-base); }
.menu-fade-enter-from,
.menu-fade-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
