<script setup lang="ts">
// 笔记管理侧栏（P-20261107-2 多篇笔记库）：在册篇清单（updatedAt 降序）+
// 标题搜索（本地过滤）+ 新建/重命名/移入回收站 + 回收站过滤段（恢复/彻底删除）+
// 标签徽记与标签过滤（P-20261112-7 S3：行内徽记点击=按该标签过滤清单——服务端
// ?tag= 过滤，与标题搜索 AND 叠加；过滤态在搜索行下显示可移除的标签胶囊）。
// 数据面在 useNotesMulti（宿主面板实例经 props 下传——面板侧栏是同一状态机
// 的第二呈现面，不持有独立状态）。
import { computed, ref } from 'vue'
import { NButton, NIcon, NInput, NTooltip } from 'naive-ui'
import {
  AddOutline, ArrowUndoOutline, CloseOutline, CreateOutline, FunnelOutline,
  SearchOutline, TrashBinOutline, TrashOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { promptDialog } from '../../composables/useDialog'
import { relativeTimeParts } from '../../utils/relative-time'
import type { NotesEngine } from '../../composables/useNotesMulti'

const props = defineProps<{
  notes: NotesEngine
  /** 侧栏宽度 px（P-20261112-9 S1 可调，宿主 NotesPanel 经 SidebarResizer 持值与
   *  记忆；缺省 260 = 提升后默认，与宿主 NOTES_SIDEBAR_W_DEFAULT 同值） */
  width?: number
}>()
// 空白区双击新建（P-20261112-8 随件同款）抛宿主面板：建篇即激活+焦点落编辑面
// 是面板侧 createNoteAndFocus 链（与 NotesPanelHeader 的 @create 接线同款）
const emit = defineEmits<{ (e: 'create'): void }>()
const { t } = useI18n()

// 侧栏标题搜索（本地过滤——篇数上界 100 内前端过滤零成本）；与服务端标签
// 过滤（notes.tagFilter）AND 叠加：清单本体已是标签过滤子集，这里再按标题筛
const filter = ref('')
// 回收站过滤段显隐（面板内过滤段，不另开面板）
const trashOpen = ref(false)
const confirmPurgeId = ref('') // 彻底删除的二次确认（点击一次变确认态，再点执行）

const filteredNotes = computed(() => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return props.notes.notes.value
  return props.notes.notes.value.filter(n => n.title.toLowerCase().includes(q))
})

/** 行内标签徽记点击（S3）：按该标签过滤清单——引擎 setTagFilter 重拉服务端
 *  过滤清单（.stop 防行 click 的 select 误触：点徽记是过滤意图不是切篇） */
function onTagFilter(tag: string): void {
  void props.notes.setTagFilter(tag)
}

/** 过滤胶囊 x：清标签过滤恢复全量清单 */
function onClearTagFilter(): void {
  void props.notes.clearTagFilter()
}

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

/** 列表空白区双击新建（P-20261112-8 随件同款，notepad 文档列表心智）：行外空白
 *  （最后行以下、回收站段前后）双击即建——只认容器本体空白面（target ===
 *  currentTarget），行/按钮上的双击不波及 */
function onBlankDblclick(e: MouseEvent): void {
  if (e.target !== e.currentTarget) return
  emit('create')
}
</script>

<template>
  <!-- 空白区双击新建（P-20261112-8 随件同款）：dblclick 只认容器本体空白面；
       行自带完整标题 title，兼防容器「双击新建」提示经 title 继承漏到行悬停误导 -->
  <div
    class="np-sidebar"
    data-testid="notes-sidebar"
    :style="{ width: `${props.width ?? 260}px` }"
    :title="t('notes.panel.dblclickCreate')"
    :aria-label="t('notes.panel.dblclickCreate')"
    @dblclick="onBlankDblclick"
  >
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
    <!-- 标签过滤态胶囊（P-20261112-7 S3）：过滤激活才出现——一眼可见清单为何
         收窄 + 可移除恢复全量（操作有反馈、失败可恢复）；文案与 chip 同款
         设计语言（bg-hover 底 + border-default + 圆角胶囊） -->
    <div
      v-if="notes.tagFilter.value"
      class="np-tag-filter"
      data-testid="notes-tag-filter"
    >
      <span class="np-tag-filter-pill">
        <NIcon
          size="11"
          :component="FunnelOutline"
        />
        <span
          class="np-tag-filter-name"
          data-testid="notes-tag-filter-name"
        >{{ notes.tagFilter.value }}</span>
        <NIcon
          class="np-tag-filter-x"
          size="11"
          :component="CloseOutline"
          :title="t('notes.panel.tagFilterRemove')"
          :aria-label="t('notes.panel.tagFilterRemove')"
          data-testid="notes-tag-filter-clear"
          @click="onClearTagFilter"
        />
      </span>
    </div>
    <div
      v-if="filteredNotes.length === 0"
      class="np-sidebar-empty"
    >
      <!-- 过滤激活的空态与空库区分：库不为空，只是没有匹配该标签的篇 -->
      {{ notes.tagFilter.value ? t('notes.panel.tagFilterEmpty') : t('notes.panel.noNotes') }}
    </div>
    <template v-else>
      <div
        v-for="n in filteredNotes"
        :key="n.id"
        class="np-note-row"
        :class="{ active: n.id === notes.activeId.value }"
        data-testid="notes-list-item"
        :title="noteTitle(n)"
        @click="notes.select(n.id)"
      >
        <span
          class="np-note-title"
          :title="noteTitle(n)"
        >{{ noteTitle(n) }}</span>
        <!-- 标签徽记（P-20261112-7 S3）：点击=按该标签过滤清单。title=全名
             （截断友好语境：侧栏宽可调 P-20261112-9-S1，拖宽即见全名）；
             @click.stop 防行 select 误触 -->
        <span
          v-if="n.tags?.length"
          class="np-note-tags"
        >
          <button
            v-for="tag in n.tags"
            :key="tag"
            type="button"
            class="np-note-tag"
            data-testid="notes-list-tag"
            :title="tag"
            :aria-label="t('notes.panel.tagFilterAria', { tag })"
            @click.stop="onTagFilter(tag)"
          >{{ tag }}</button>
        </span>
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
   标题 + 相对时间一行放得下，编辑面仍占主体。
   宽度可调（P-20261112-9 S1）：内联 width 来自宿主（NotesPanel 经
   SidebarResizer 持值与记忆，键 sc.notes.sidebarWidth），缺省 260 = 提升
   后默认（原固定 220px，「[项目名] 交接」前缀标题少截断） */
.np-sidebar {
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
/* 标签过滤态胶囊（P-20261112-7 S3）：搜索行下方轻量一行，仅过滤激活时渲染
   （不占常态空间）；视觉语言与面板标签行 chips 同源（bg-hover 底 + 圆角） */
.np-tag-filter {
  display: flex;
  align-items: center;
  margin-bottom: 4px;
  min-width: 0;
}
.np-tag-filter-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  min-width: 0;
  padding: 1px 6px;
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border: 1px solid var(--border-default);
  border-radius: 9px;
}
.np-tag-filter-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.np-tag-filter-x {
  border-radius: 50%;
  opacity: 0.4;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity var(--motion-fast) var(--ease-standard);
}
.np-tag-filter-x:hover {
  opacity: 1;
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
/* title 用 1 1 auto（非 grow-only 的 flex:1）：行内带徽记时弹性收缩要按内容
   比例分给标题与徽记容器——basis 0 会让标题在拥挤行先归零、徽记独占（行只剩
   一排 chip 没有篇名可读）。无徽记行与原 flex:1 视觉等价（grow 补满剩余） */
.np-note-title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 标签徽记容器（P-20261112-7 S3）：行内拥挤时整体收缩裁切（侧栏宽可调的
   截断友好语境——拖宽即见更多徽记），单徽记自身再 ellipsis 截断 + title 全名 */
.np-note-tags {
  display: flex;
  align-items: center;
  gap: 3px;
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
}
.np-note-tag {
  flex-shrink: 0;
  max-width: 84px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 0 5px;
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-tertiary);
  background: var(--bg-hover);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  cursor: pointer;
  transition:
    color var(--motion-fast) var(--ease-standard),
    background-color var(--motion-fast) var(--ease-standard);
}
.np-note-tag:hover {
  color: var(--text-primary);
  background: var(--bg-active, var(--bg-hover));
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
