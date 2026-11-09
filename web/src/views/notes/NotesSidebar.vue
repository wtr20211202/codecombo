<script setup lang="ts">
// 笔记管理侧栏（P-20261107-2 多篇笔记库）：在册篇清单（updatedAt 降序）+
// 标题搜索（本地过滤）+ 新建/重命名/移入回收站 + 回收站过滤段（恢复/彻底删除）。
// 数据面在 useNotesMulti（宿主面板实例经 props 下传——面板侧栏是同一状态机
// 的第二呈现面，不持有独立状态）。
import { computed, ref } from 'vue'
import { NButton, NIcon, NInput, NTooltip } from 'naive-ui'
import {
  AddOutline, ArrowUndoOutline, CreateOutline, SearchOutline,
  TrashBinOutline, TrashOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { promptDialog } from '../../composables/useDialog'
import { relativeTimeParts } from '../../utils/relative-time'
import type { NotesEngine } from '../../composables/useNotesMulti'

const props = defineProps<{ notes: NotesEngine }>()
const { t } = useI18n()

// 侧栏标题搜索（本地过滤——篇数上界 100 内前端过滤零成本）
const filter = ref('')
// 回收站过滤段显隐（面板内过滤段，不另开面板）
const trashOpen = ref(false)
const confirmPurgeId = ref('') // 彻底删除的二次确认（点击一次变确认态，再点执行）

const filteredNotes = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return props.notes.notes.value
  return props.notes.notes.value.filter(n => n.title.toLowerCase().includes(q))
})

/** updatedAt → 相对时间文案（relativeTimeParts 纯函数 + agentTerminal 既有
 *  相对时间词条复用——侧栏行内微文案，绝对时刻进 title） */
function fmtUpdatedAt(iso: string): string {
  if (!iso) return ''
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return ''
  const p = relativeTimeParts(ts)
  return t(`agentTerminal.${p.key}`, { n: p.n })
}

function noteTitle(n: { title: string }): string {
  return n.title || t('notes.panel.untitled')
}

/** 重命名（promptDialog——confirmDialog 同族 n-modal，window.prompt 阻塞主线程
 *  且 Playwright page.on('dialog') 够不着） */
async function onRename(id: string, current: string): Promise<void> {
  const next = await promptDialog({
    title: t('notes.panel.rename'),
    label: t('notes.panel.renamePrompt'),
    defaultValue: current,
  })
  if (next === null) return
  await props.notes.renameNote(id, next.trim())
}

/** 彻底删除两段确认（不可恢复动作：第一击进确认态，再点执行） */
function onPurge(id: string): void {
  if (confirmPurgeId.value !== id) {
    confirmPurgeId.value = id
    return
  }
  confirmPurgeId.value = ''
  void props.notes.purgeNote(id)
}
</script>

<template>
  <div class="np-sidebar">
    <div class="np-search">
      <NInput
        v-model:value="filter"
        size="tiny"
        clearable
        :placeholder="t('notes.panel.searchPlaceholder')"
        data-testid="notes-search"
      >
        <template #prefix>
          <NIcon :component="SearchOutline" />
        </template>
      </NInput>
      <NButton
        quaternary
        size="tiny"
        :title="t('notes.panel.create')"
        :aria-label="t('notes.panel.create')"
        data-testid="notes-create"
        @click="notes.createNote('')"
      >
        <template #icon>
          <NIcon data-icon-action="common.new">
            <AddOutline />
          </NIcon>
        </template>
      </NButton>
    </div>
    <div
      v-if="filteredNotes.length === 0"
      class="np-sidebar-empty"
    >
      {{ t('notes.panel.noNotes') }}
    </div>
    <template v-else>
      <div
        v-for="n in filteredNotes"
        :key="n.id"
        class="np-note-row"
        :class="{ active: n.id === notes.activeId.value }"
        data-testid="notes-list-item"
        @click="notes.select(n.id)"
      >
        <span
          class="np-note-title"
          :title="noteTitle(n)"
        >{{ noteTitle(n) }}</span>
        <span class="np-note-time">{{ fmtUpdatedAt(n.updatedAt) }}</span>
        <span class="np-note-actions">
          <NButton
            quaternary
            size="tiny"
            :title="t('notes.panel.rename')"
            :aria-label="t('notes.panel.rename')"
            :data-testid="'notes-rename-' + n.id"
            @click.stop="onRename(n.id, n.title)"
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
            :title="t('notes.panel.trash')"
            :aria-label="t('notes.panel.trash')"
            :data-testid="'notes-trash-' + n.id"
            @click.stop="notes.trashNote(n.id)"
          >
            <template #icon>
              <NIcon data-icon-action="common.delete">
                <TrashOutline />
              </NIcon>
            </template>
          </NButton>
        </span>
      </div>
    </template>
    <!-- 回收站过滤段（软删篇：恢复 / 彻底删除） -->
    <button
      class="np-trash-toggle"
      data-testid="notes-trash-toggle"
      @click="trashOpen = !trashOpen"
    >
      <NIcon
        size="12"
        :component="TrashBinOutline"
      />
      <span>{{ t('notes.panel.trashSection') }}</span>
      <span
        v-if="notes.trash.value.length"
        class="np-trash-count"
      >{{ notes.trash.value.length }}</span>
    </button>
    <div
      v-if="trashOpen"
      class="np-trash-list"
      data-testid="notes-trash-list"
    >
      <div
        v-if="notes.trash.value.length === 0"
        class="np-sidebar-empty"
      >
        {{ t('notes.panel.trashEmpty') }}
      </div>
      <template v-else>
        <div
          v-for="n in notes.trash.value"
          :key="n.id"
          class="np-note-row trashed"
        >
          <span
            class="np-note-title"
            :title="noteTitle(n)"
          >{{ noteTitle(n) }}</span>
          <span class="np-note-actions">
            <NTooltip
              trigger="hover"
              placement="top"
            >
              <template #trigger>
                <NButton
                  quaternary
                  size="tiny"
                  :aria-label="t('notes.panel.restore')"
                  :data-testid="'notes-restore-' + n.id"
                  @click.stop="notes.restoreNote(n.id)"
                >
                  <template #icon>
                    <NIcon>
                      <ArrowUndoOutline />
                    </NIcon>
                  </template>
                </NButton>
              </template>
              {{ t('notes.panel.restore') }}
            </NTooltip>
            <NButton
              quaternary
              size="tiny"
              :type="confirmPurgeId === n.id ? 'error' : 'default'"
              :title="confirmPurgeId === n.id ? t('notes.panel.purgeConfirm') : t('notes.panel.purge')"
              :aria-label="t('notes.panel.purge')"
              :data-testid="'notes-purge-' + n.id"
              @click.stop="onPurge(n.id)"
            >
              <template #icon>
                <NIcon data-icon-action="common.delete">
                  <TrashOutline />
                </NIcon>
              </template>
            </NButton>
          </span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 列表宽度按独立视图大区域取值（P-20261108-2；原侧栏窄条时代 178px）：
   标题 + 相对时间一行放得下，编辑面仍占主体 */
.np-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-default);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 6px 10px;
}
.np-search {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-bottom: 4px;
}
.np-sidebar-empty {
  font-size: 11px;
  color: var(--text-muted);
  padding: 6px 4px;
}
.np-note-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 4px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  transition: background-color var(--motion-fast) var(--ease-standard);
}
.np-note-row:hover {
  background: var(--bg-hover);
}
.np-note-row.active {
  background: var(--bg-active, var(--bg-hover));
}
.np-note-row.trashed {
  opacity: 0.75;
}
.np-note-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.np-note-time {
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.np-note-actions {
  display: none;
  flex-shrink: 0;
}
.np-note-row:hover .np-note-actions {
  display: inline-flex;
}
.np-trash-toggle {
  margin-top: 6px;
  display: flex;
  align-items: center;
  gap: 5px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 11px;
  padding: 4px 4px;
  cursor: pointer;
  border-top: 1px solid var(--border-default);
  text-align: left;
}
.np-trash-count {
  margin-left: auto;
  background: var(--bg-hover);
  border-radius: 8px;
  padding: 0 6px;
  font-size: 10px;
}
.np-trash-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
