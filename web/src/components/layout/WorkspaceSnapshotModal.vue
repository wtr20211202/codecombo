<script setup lang="ts">
// 工作现场存档（P-20261002-84）：恢复列表弹层——列表 + 行内「恢复/改名/删除」
// （P-20261003-68 补行内改名）。纯展示组件：存档流程编排在
// useWorkspaceSnapshot（Layout 宿主经 useLayoutShell 注入 props/事件）
import { NModal, NButton, NEmpty, NSpin } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { relativeTimeParts } from '../../utils/relative-time'
import type { WorkspaceSnapshot } from '../../stores/uiState'

defineProps<{
  show: boolean
  snapshots: WorkspaceSnapshot[]
  listLoading?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  (e: 'restore', snap: WorkspaceSnapshot): void
  (e: 'delete', snap: WorkspaceSnapshot): void
  (e: 'rename', snap: WorkspaceSnapshot): void
}>()

const { t } = useI18n()

// 存档时刻（相对时间）：复用 agentTerminal.activityXxx 文案切片，不新增 i18n 键
function savedAtLabel(ts: number): string {
  const p = relativeTimeParts(ts)
  return t(`agentTerminal.${p.key}`, { n: p.n })
}
</script>

<template>
  <NModal
    :show="show"
    preset="card"
    class="workspace-snapshot-modal"
    :title="t('snapshot.managerTitle')"
    @update:show="emit('update:show', $event)"
  >
    <NSpin :show="!!listLoading">
      <NEmpty
        v-if="!listLoading && snapshots.length === 0"
        :description="t('snapshot.empty')"
        style="padding: 24px 0"
      />
      <div
        v-else
        class="wsnap-list"
      >
        <div
          v-for="(s, idx) in snapshots"
          :key="s.id"
          class="wsnap-row"
          :data-snapshot-name="s.name"
        >
          <div class="wsnap-main">
            <div
              class="wsnap-name"
              :title="s.name"
            >
              <!-- 序号 = Ctrl/Cmd+Alt+N 直达恢复键号（P-20261004-49）：列表第 N 个
                   即键位目标，数字随列表位次走；第 10 个起超出 1-9 键位不提示 -->
              <span
                v-if="idx < 9"
                class="wsnap-ordinal"
                :title="t('presets.ordinalTip', { n: idx + 1 })"
              >{{ idx + 1 }}</span>
              {{ s.name }}
            </div>
            <div class="wsnap-meta">
              <span
                v-if="s.branch"
                class="wsnap-branch"
              >{{ s.branch }}</span>
              <span>{{ t('snapshot.metaFiles', { n: s.editor.openFiles.length }) }}</span>
              <span>{{ savedAtLabel(s.savedAt) }}</span>
            </div>
          </div>
          <div class="wsnap-actions">
            <NButton
              size="small"
              type="primary"
              data-testid="snapshot-restore-btn"
              @click="emit('restore', s)"
            >
              {{ t('snapshot.restore') }}
            </NButton>
            <NButton
              size="small"
              quaternary
              data-testid="snapshot-rename-btn"
              @click="emit('rename', s)"
            >
              {{ t('presets.rename') }}
            </NButton>
            <NButton
              size="small"
              quaternary
              type="warning"
              data-testid="snapshot-delete-btn"
              @click="emit('delete', s)"
            >
              {{ t('snapshot.del') }}
            </NButton>
          </div>
        </div>
      </div>
    </NSpin>
  </NModal>
</template>

<style scoped>
.wsnap-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 420px;
  overflow-y: auto;
}

.wsnap-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
}

.wsnap-main {
  min-width: 0;
  flex: 1;
}

.wsnap-name {
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 键号徽标（P-20261004-49）：kbd 样式小芯片，等宽走 --font-mono token（硬编码
 * 字体门禁），色板全部主题变量（主题适配红线） */
.wsnap-ordinal {
  display: inline-block;
  min-width: 18px;
  margin-right: 6px;
  padding: 0 4px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 400;
  line-height: 16px;
  text-align: center;
  color: var(--text-secondary);
  vertical-align: 1px;
}

.wsnap-meta {
  display: flex;
  gap: 12px;
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  white-space: nowrap;
}

.wsnap-branch {
  font-family: monospace;
  color: var(--accent-blue-light);
}

.wsnap-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
</style>
