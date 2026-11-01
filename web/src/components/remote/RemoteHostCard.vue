<script setup lang="ts">
import { computed } from 'vue'
import { NButton, NIcon, NDropdown } from 'naive-ui'
import type { DropdownMixedOption } from 'naive-ui/es/dropdown/src/interface'
import { TerminalOutline, EllipsisHorizontalOutline, FolderOpenOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'

/**
 * 远程主机卡片（P-20261030-3 密度重塑终态）：单行紧凑形态——状态点 + 名称主显 +
 * 地址次显灰显，其余信息（凭据/协议/路径等）全收进编辑弹窗（点击卡片打开，
 * 弹窗为唯一详情面）。开终端 / 文件管理等动作走 hover 显现的快捷钮与「⋯」菜单
 * （不占纵向空间）。纯展示 + 事件外抛（开终端、菜单选择、拖拽源、右键菜单），
 * 状态由宿主持有。
 */
const props = defineProps<{
  host: { id: string; name: string; host: string; port: number; user: string; protocol?: string }
  statusClass: string
  creating: boolean
  menuOptions: DropdownMixedOption[]
  /** 测试连接进行中（store.testing[id]，全部重测/单台测试共用）——状态点转蓝色脉冲 */
  testing?: boolean
}>()

const emit = defineEmits<{
  (e: 'open', hostId: string): void
  (e: 'select', payload: { hostId: string; key: string }): void
  (e: 'dragstart', payload: { hostId: string; event: DragEvent }): void
  (e: 'ctx', payload: { hostId: string; event: MouseEvent }): void
}>()

const { t } = useI18n()

/** 状态点悬停提示：测试进行中优先（复用既有 testRunning 文案），否则按探测态 */
const statusTitle = computed(() => {
  if (props.testing) return t('remoteConsole.testRunning')
  if (props.statusClass === 'online') return t('remoteConsole.statusAuthOkTip')
  if (props.statusClass === 'auth-pending') return t('remoteConsole.statusAuthPendingTip')
  return ''
})

// 点击卡片 = 编辑弹窗（P-20261030-3 用户定调：列表只承担「看到 + 进详情」，
// 开终端走快捷钮/菜单——误触即弹编辑弹窗而非产生真实 SSH 连接，副作用更轻）
function onCardClick() {
  emit('select', { hostId: props.host.id, key: 'edit' })
}

function onDragStart(e: DragEvent) {
  emit('dragstart', { hostId: props.host.id, event: e })
}
</script>

<template>
  <div
    class="host-card"
    draggable="true"
    @click="onCardClick"
    @dragstart="onDragStart"
    @contextmenu.prevent="emit('ctx', { hostId: host.id, event: $event })"
  >
    <span
      class="host-status"
      :class="[{ 'is-testing': testing }, `is-${statusClass}`]"
      :title="statusTitle"
    />
    <span
      class="host-card-name"
      :title="host.name"
    >{{ host.name }}</span>
    <span
      v-if="host.protocol === 'ftp'"
      class="host-card-proto"
      :title="t('deploy.host.field.ftpHint')"
    >FTP</span>
    <span
      class="host-card-addr"
      :title="`${host.user}@${host.host}:${host.port}`"
    >
      {{ host.user }}@{{ host.host }}:{{ host.port }}
    </span>
    <span class="host-card-quick">
      <!-- FTP 无 shell：不出现开终端钮（文件管理即其主动作），避免点出报错 -->
      <n-button
        v-if="host.protocol !== 'ftp'"
        size="tiny"
        quaternary
        class="host-card-term"
        :loading="creating"
        :title="t('remoteConsole.newTerminal')"
        :aria-label="t('remoteConsole.newTerminal')"
        @click.stop="emit('open', host.id)"
      >
        <template #icon><n-icon><TerminalOutline /></n-icon></template>
      </n-button>
      <n-button
        size="tiny"
        quaternary
        class="host-card-files"
        :title="t('remoteFiles.menu')"
        :aria-label="t('remoteFiles.menu')"
        @click.stop="emit('select', { hostId: host.id, key: 'files' })"
      >
        <template #icon><n-icon><FolderOpenOutline /></n-icon></template>
      </n-button>
      <n-dropdown
        trigger="click"
        :options="menuOptions"
        @select="(key: string) => emit('select', { hostId: host.id, key })"
      >
        <n-button
          size="tiny"
          quaternary
          class="host-card-more"
          :title="t('remoteConsole.quickActions')"
          :aria-label="t('remoteConsole.quickActions')"
          @click.stop
        >
          <template #icon><n-icon data-icon-action="common.more"><EllipsisHorizontalOutline /></n-icon></template>
        </n-button>
      </n-dropdown>
    </span>
  </div>
</template>

<style scoped>
.host-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  /* 密度对齐全局界面密度档（P-20261003-322）：--row-pad-y 仅紧凑档注入（3px），
     舒适档回落 6px 基线（单行列表行内边距惯例） */
  padding: var(--row-pad-y, 6px) 10px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  background: var(--bg-elevated);
  cursor: pointer;
  transition: border-color var(--motion-base);
}
.host-card:hover {
  border-color: var(--brand-accent);
}
.host-status {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
  background: var(--text-dim);
}
.host-status.is-online { background: var(--accent-green); }
.host-status.is-auth-pending { background: var(--status-waiting); }
.host-status.is-offline { background: color-mix(in srgb, var(--accent-red) 55%, var(--text-dim)); }
/* 测试连接进行中（单台/全部重测共用）：蓝色脉冲点——与 auth-pending 的静态黄区分，
   进行中态属运行语义（--status-running 同族）；animation 时长不入 check-motion 门禁面 */
.host-status.is-testing {
  background: var(--status-running);
  animation: host-test-pulse 1.4s ease-in-out infinite;
}
@keyframes host-test-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--status-running) 45%, transparent); }
  50% { box-shadow: 0 0 0 4px transparent; }
}
.host-card-name {
  flex: 1 1 auto; min-width: 0;
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.host-card-proto {
  flex-shrink: 0;
  font-size: max(var(--fs-meta-min, 11.5px), 0.7em); padding: 0 4px; border-radius: 2px;
  background: var(--bg-active); color: var(--text-secondary);
  font-family: var(--font-mono);
}
.host-card-addr {
  /* 次显灰显：内容宽即可，过长先于名称收敛（名称 flex-grow 优先占位），
     上限 55% 防超长地址挤压名称 */
  flex: 0 1 auto; max-width: 55%; min-width: 0;
  text-align: right;
  font-size: max(var(--fs-meta-min, 11.5px), 0.85em); color: var(--text-muted); font-family: var(--font-mono);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 快捷钮悬浮在地址上方（不占布局宽）：单行 240px 侧栏里名称+地址已占满，
   三钮内联会把两者挤到双双截断（实测 name 21px/addr 89px 均截）——绝对定位
   悬浮 + 左缘渐变垫底，悬停时地址优雅隐入。触屏无 hover：coarse 档常显 */
.host-card-quick {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding-left: 14px;
  background: linear-gradient(to right, transparent, var(--bg-elevated) 14px);
}
.host-card-term, .host-card-files, .host-card-more { opacity: 0; transition: opacity var(--motion-base); }
.host-card:hover .host-card-term,
.host-card:hover .host-card-files,
.host-card:hover .host-card-more { opacity: 1; }
@media (pointer: coarse) {
  .host-card-term, .host-card-files, .host-card-more { opacity: 1; }
}
</style>
