<script setup lang="ts">
// 笔记面板头（P-20261107-5 起拆出）：快捷新建 + 管理侧栏/编辑/预览三钮 + 关闭钮
// （P-20261108-2 独立视图宿主 closable 时出现）。纯呈现件——状态与动作全部由
// 宿主 NotesPanel 注入（props in / emits out），本组件不触数据面。
// P-20261108-3 单库化：「全局库|项目库」数据源分段切换随双源一并退役——笔记只有
// 项目无关的一个库，项目归属靠标题「[项目名] 」前缀（侧栏标题搜索即可按项目筛）
import { NButton, NIcon } from 'naive-ui'
import { AddOutline, CloseOutline, CreateOutline, EyeOutline, GridOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import type { NoteSaveState } from '../../composables/useNotesMulti'

defineProps<{
  /** 保存态徽标文案（'' = 不显示） */
  statusText: string
  statusKind: NoteSaveState
  sidebarOpen: boolean
  mode: 'edit' | 'preview'
  /** 宿主提供关闭语义时出关闭钮（独立视图两形态：项目页主区 / 首页 overlay） */
  closable?: boolean
}>()

const emit = defineEmits<{
  (e: 'create'): void
  (e: 'toggle-sidebar'): void
  (e: 'set-mode', m: 'edit' | 'preview'): void
  (e: 'close'): void
}>()

const { t } = useI18n()
</script>

<template>
  <div class="nph-bar">
    <span class="nph-title">{{ t('notes.panel.title') }}</span>
    <span
      v-if="statusText"
      class="nph-status"
      :class="'st-' + statusKind"
      data-testid="notes-status"
    >{{ statusText }}</span>
    <div class="nph-actions">
      <NButton
        quaternary
        size="tiny"
        :title="t('notes.panel.create')"
        :aria-label="t('notes.panel.create')"
        data-testid="notes-create-quick"
        @click="emit('create')"
      >
        <template #icon>
          <NIcon data-icon-action="common.new">
            <AddOutline />
          </NIcon>
        </template>
      </NButton>
      <NButton
        quaternary
        size="tiny"
        :type="sidebarOpen ? 'primary' : 'default'"
        :title="t('notes.panel.listToggle')"
        :aria-label="t('notes.panel.listToggle')"
        data-testid="notes-list-toggle"
        @click="emit('toggle-sidebar')"
      >
        <template #icon>
          <NIcon><GridOutline /></NIcon>
        </template>
      </NButton>
      <NButton
        quaternary
        size="tiny"
        :type="mode === 'edit' ? 'primary' : 'default'"
        :title="t('notes.panel.edit')"
        :aria-label="t('notes.panel.edit')"
        data-testid="notes-mode-edit"
        @click="emit('set-mode', 'edit')"
      >
        <template #icon>
          <NIcon data-icon-action="common.edit">
            <CreateOutline />
          </NIcon>
        </template>
      </NButton>
      <NButton
        quaternary
        size="tiny"
        :type="mode === 'preview' ? 'primary' : 'default'"
        :title="t('notes.panel.preview')"
        :aria-label="t('notes.panel.preview')"
        data-testid="notes-mode-preview"
        @click="emit('set-mode', 'preview')"
      >
        <template #icon>
          <NIcon data-icon-action="common.preview">
            <EyeOutline />
          </NIcon>
        </template>
      </NButton>
      <!-- 关闭独立视图（宿主 closable）：项目页主区回到编辑器 / 首页收起 overlay。
           前置竖线分隔：「离开视图」不与编辑/预览等就地动作混为一组 -->
      <span
        v-if="closable"
        class="nph-sep"
        aria-hidden="true"
      />
      <NButton
        v-if="closable"
        quaternary
        size="tiny"
        :title="t('common.close')"
        :aria-label="t('common.close')"
        data-testid="notes-close"
        @click="emit('close')"
      >
        <template #icon>
          <NIcon data-icon-action="common.close">
            <CloseOutline />
          </NIcon>
        </template>
      </NButton>
    </div>
  </div>
</template>

<style scoped>
.nph-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-default);
}
.nph-title {
  font-weight: 600;
  font-size: 12px;
}
.nph-status {
  font-size: 11px;
  color: var(--text-tertiary);
}
.nph-status.st-error {
  color: var(--accent-red, #e05561);
}
.nph-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 2px;
}
.nph-sep {
  width: 1px;
  height: 14px;
  margin: 0 4px;
  background: var(--border-default);
}
</style>
