<script setup lang="ts">
// 笔记面板（P-20261002-110 单篇便签 → P-20261107-2 多篇笔记库 → P-20261107-5
// 独立化 → P-20261108-2 独立视图 → P-20261108-3 单库化）：快捷新建 + 管理侧栏 +
// markdown 编辑/预览双栏 + 续迁横幅。笔记只有项目无关的一个库（/api/notes 族，
// 「全局库|项目库」双源切换退役），项目归属靠标题「[项目名] 」前缀——侧栏标题
// 搜索即按项目筛。数据面收在 useNotesMulti 单例引擎，本组件只做呈现与事件接线。
// 宿主 = NotesView（项目页主区 / 首页 overlay 两形态，closable 时头部出关闭钮，
// 关闭语义归宿主）。
//
// 快捷键（keymap notes 域，useNotesKeyboard 焦点域消费——按面板根 contains 判定，
// 宿主无关）：保存（未命名且有内容时顺带命名——notepad「保存即命名」心智，取消
// 即本会话不再追问）/新建（命名后置：空标题建篇即激活进编辑，「无标题笔记」占位）/
// 重命名。
//
// 兼容端点协议保持：notes-editor/notes-preview/notes-mode-*/notes-status 等
// data-testid 与单文档时代一致（e2e 既有契约面）。
// 覆盖保护三件套：自动保存默认带 baseUpdatedAt，409 挂起冲突条三动作
// （用我的覆盖/载入服务端版本/另存为新篇）；丢失上界 = 防抖窗（诚实声明，
// beforeunload keepalive fetch 尽力而为）。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NIcon, NSpin } from 'naive-ui'
import { CloseOutline } from '@vicons/ionicons5'
import { getUnlockToken } from '../../stores/lock'
import { useI18n } from '../../composables/useI18n'
import { promptDialog } from '../../composables/useDialog'
import { useNarrowLayout } from '../../composables/useNarrowLayout'
import { useNotesKeyboard } from '../../composables/useNotesKeyboard'
import { suggestNoteTitle } from '../../utils/noteTitle'
import { NOTES_EXTERNAL_UPDATE, notesSaveUrl, useNotesMulti } from '../../composables/useNotesMulti'
import { OPS_NOTES_UPDATED, type NotesExternalUpdateDetail } from '../../utils/opsEvents'
import NotesMigrationBanner from './NotesMigrationBanner.vue'
import NotesPanelHeader from './NotesPanelHeader.vue'
import NotesPreviewPane from './NotesPreviewPane.vue'
import NotesSidebar from './NotesSidebar.vue'

defineProps<{
  /** 宿主提供关闭语义（NotesView 两形态）：头部出关闭钮，点击抛 close */
  closable?: boolean
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const { t } = useI18n()

// 单例引擎（单库：全部读写走 /api/notes 族，无作用域切换）
const notes = useNotesMulti()

// edit | preview——切换不重置编辑态，仅换呈现层
const mode = ref<'edit' | 'preview'>('edit')
// 管理侧栏（列表/搜索/回收站，子组件 NotesSidebar）显隐——独立视图大区域默认常显
// （P-20261108-2，notepad 文档列表心智）；窄屏（≤700px）放不下列表+编辑面默认收起
const sidebarOpen = ref(!useNarrowLayout().narrow.value)

const panelRoot = ref<HTMLElement | null>(null)
const editorRef = ref<HTMLTextAreaElement | null>(null)

// 「已保存」闪示（快捷保存的可见反馈——自动保存走既有 dirty/saving 态徽标）
const justSaved = ref(false)
let savedFlashTimer: ReturnType<typeof setTimeout> | null = null
// 本会话内拒绝命名的篇（Ctrl+S 命名追问取消一次即不再问——显式取消是意图）
const namingDeclined = new Set<string>()

const statusText = computed(() => {
  if (justSaved.value) return t('notes.panel.saved')
  return ({
    idle: '',
    dirty: t('notes.panel.dirty'),
    saving: t('notes.panel.saving'),
    error: t('notes.panel.saveFailed'),
  })[notes.activeSaveState.value]
})

/** markdown 预览渲染收口 NotesPreviewPane 子组件（marked+DOMPurify 消毒管线） */

/** tab 条关闭钮：与侧栏行「移入回收站」同动作（软删可恢复） */
function onTrash(id: string): void {
  void notes.trashNote(id)
}

function noteTitle(n: { title: string }): string {
  return n.title || t('notes.panel.untitled')
}

function focusEditor(): void {
  void nextTick(() => editorRef.value?.focus())
}

function flashSaved(): void {
  justSaved.value = true
  if (savedFlashTimer) clearTimeout(savedFlashTimer)
  savedFlashTimer = setTimeout(() => { justSaved.value = false }, 1200)
}

/** 快捷新建：空标题建篇即激活进编辑（命名后置——侧栏「+」/头部「+」/快捷键
 *  三入口同此链），焦点落编辑面立即可打字 */
async function createNoteAndFocus(): Promise<void> {
  const created = await notes.createNote('')
  if (created) focusEditor()
}

/** 重命名当前篇（头部动作 + notesRename 快捷键共用）：promptDialog 与侧栏行
 *  内重命名同款 */
async function renameActiveNote(): Promise<void> {
  const cur = notes.activeNote.value
  if (!cur) return
  const next = await promptDialog({
    title: t('notes.panel.rename'),
    label: t('notes.panel.renamePrompt'),
    defaultValue: cur.title,
  })
  if (next === null) return
  const ok = await notes.renameNote(cur.id, next.trim())
  if (ok && next.trim()) flashSaved()
}

/** 保存当前篇（notesSave 快捷键 + 头部未来入口共用）：先落挂起修改，未命名
 *  且有内容时弹命名框（预填正文首行建议——「快捷键保存命名」；取消 = 本会话
 *  不再追问该篇，内容照常已保存）。冲突挂起时跳过命名追问（冲突条是模态裁决
 *  面，不叠第二张弹窗） */
async function saveActiveNote(): Promise<void> {
  const id = notes.activeId.value
  if (!id) return
  await notes.flushSave(id)
  const meta = notes.activeNote.value
  const content = notes.contents[id] ?? ''
  if (!notes.conflict.value && meta && !meta.title && content.trim() && !namingDeclined.has(id)) {
    const suggested = suggestNoteTitle(content)
    const next = await promptDialog({
      title: t('notes.panel.saveNameTitle'),
      label: t('notes.panel.renamePrompt'),
      defaultValue: suggested,
    })
    if (next === null || !next.trim()) {
      namingDeclined.add(id) // 取消/空名：本会话不再追问（内容已保存，不受影响）
    } else {
      await notes.renameNote(id, next.trim())
    }
  }
  // 反馈门：落盘收口到 idle 才闪「已保存」（error 态不谎报成功；占位空篇没有
  // 「已保存」事实）
  if (notes.saveStates[id] === 'idle' && !notes.isPlaceholder(id)) {
    flashSaved()
  }
  focusEditor()
}

useNotesKeyboard(panelRoot, {
  save: () => { void saveActiveNote() },
  create: () => { void createNoteAndFocus() },
  rename: () => { void renameActiveNote() },
})

/** 管理侧栏展开时拉取软删清单（回收站徽标与恢复/彻底删除动作的数据面）——
 *  immediate：大区域侧栏默认常显，挂载即拉 */
watch(sidebarOpen, (side) => {
  if (side) void notes.loadTrash()
}, { immediate: true })

/** 续迁横幅迁入了旧项目笔记：重拉清单（服务端 notes.updated 广播同样会到，
 *  这里是同窗口确定性收口，不依赖 WS 时序） */
function onMigrated(): void {
  void notes.loadList()
  if (sidebarOpen.value) void notes.loadTrash()
}

/** 笔记被外部写回（服务端 notes.updated 直通分发 + 前端内部事件统一消费口）。
 *  服务端事件的 projectId = 笔记库哨兵 '_global'，引擎按其对位 */
function onExternalUpdate(e: Event): void {
  const detail = (e as CustomEvent<NotesExternalUpdateDetail>).detail
  void notes.onExternalUpdate(detail)
}

/** 页面隐藏（切 tab/最小化）：防抖窗内的编辑全部落盘——多端/多标签场景
 *  隐藏面是高频丢失窗 */
function onVisibility(): void {
  if (document.visibilityState === 'hidden') void notes.flushAll()
}

/** 卸载前的尽力而为：keepalive fetch 直发（uiState 关页补丁同款——sendBeacon
 *  只支持 POST，本族单篇保存只有 PUT 路由；且 sendBeacon 无法携 X-Lock-Token，
 *  锁定实例会被 401 拒收）。诚实边界：浏览器不保证送达、>64KB 载荷被浏览器
 *  截拒，丢失上界 = 防抖窗 */
function onBeforeUnload(): void {
  for (const id of notes.dirtyIds.value) {
    const content = notes.contents[id] ?? ''
    const base = notes.bases[id]
    const body = JSON.stringify({ content, baseUpdatedAt: base || undefined })
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const token = getUnlockToken()
      if (token) headers['X-Lock-Token'] = token
      fetch(notesSaveUrl(id), {
        method: 'PUT',
        headers,
        body,
        keepalive: true,
      })
    } catch { /* 尽力而为：失败落回防抖窗丢失上界（诚实声明） */ }
  }
}

onMounted(() => {
  window.addEventListener(NOTES_EXTERNAL_UPDATE, onExternalUpdate)
  window.addEventListener(OPS_NOTES_UPDATED, onExternalUpdate)
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('beforeunload', onBeforeUnload)
  void notes.loadList()
})
onBeforeUnmount(() => {
  window.removeEventListener(NOTES_EXTERNAL_UPDATE, onExternalUpdate)
  window.removeEventListener(OPS_NOTES_UPDATED, onExternalUpdate)
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('beforeunload', onBeforeUnload)
  if (savedFlashTimer) clearTimeout(savedFlashTimer)
  void notes.flushAll()
})
</script>

<template>
  <div
    ref="panelRoot"
    class="notes-panel"
    data-testid="notes-panel"
  >
    <NotesPanelHeader
      :status-text="statusText"
      :status-kind="notes.activeSaveState.value"
      :sidebar-open="sidebarOpen"
      :mode="mode"
      :closable="closable"
      @create="createNoteAndFocus"
      @toggle-sidebar="sidebarOpen = !sidebarOpen"
      @set-mode="mode = $event"
      @close="emit('close')"
    />
    <!-- 单库化续迁横幅（P-20261108-3）：仍有旧项目笔记滞留（笔记库满额中止）才出现 -->
    <NotesMigrationBanner @migrated="onMigrated" />

    <NSpin
      v-if="notes.loading.value"
      class="np-loading"
      size="small"
    />
    <NEmpty
      v-else-if="notes.loadFailed.value"
      class="np-empty"
      size="small"
      :description="t('notes.panel.loadFailed')"
    />
    <template v-else>
      <div class="np-body">
        <!-- 管理侧栏（列表/搜索/回收站，子组件持有过滤与确认态） -->
        <NotesSidebar
          v-if="sidebarOpen"
          :notes="notes"
        />

        <!-- 主编辑区 -->
        <div class="np-main">
          <div
            v-if="notes.notes.value.length > 0"
            class="np-tabs"
            data-testid="notes-tabs"
          >
            <button
              v-for="n in notes.notes.value"
              :key="n.id"
              class="np-tab"
              :class="{ active: n.id === notes.activeId.value }"
              :data-testid="'notes-tab-' + n.id"
              @click="notes.select(n.id)"
            >
              <span class="np-tab-title">{{ noteTitle(n) }}</span>
              <span
                v-if="notes.saveStates[n.id] === 'dirty' || notes.saveStates[n.id] === 'error'"
                class="np-tab-dot"
                :class="{ error: notes.saveStates[n.id] === 'error' }"
              />
              <NIcon
                class="np-tab-close"
                size="12"
                :component="CloseOutline"
                :aria-label="t('notes.panel.trash')"
                @click.stop="onTrash(n.id)"
              />
            </button>
          </div>

          <!-- 冲突条（覆盖保护三件套②：409 不静默覆盖，三动作裁决） -->
          <div
            v-if="notes.conflict.value"
            class="np-conflict"
            data-testid="notes-conflict"
          >
            <span class="np-conflict-text">{{ t('notes.panel.conflictDetected') }}</span>
            <span class="np-conflict-actions">
              <NButton
                size="tiny"
                type="warning"
                secondary
                data-testid="notes-conflict-overwrite"
                @click="notes.resolveConflictOverwrite()"
              >{{ t('notes.panel.conflictOverwrite') }}</NButton>
              <NButton
                size="tiny"
                secondary
                data-testid="notes-conflict-load"
                @click="notes.resolveConflictLoadServer()"
              >{{ t('notes.panel.conflictLoad') }}</NButton>
              <NButton
                size="tiny"
                secondary
                data-testid="notes-conflict-saveas"
                @click="notes.resolveConflictSaveAsNew()"
              >{{ t('notes.panel.conflictSaveAs') }}</NButton>
            </span>
          </div>

          <!-- 编辑面恒在（空库时占位默认篇承载——「打开即可打字」单篇时代契约，
               首写经服务端 default-upsert 落真身） -->
          <div class="np-editor-area">
            <textarea
              v-show="mode === 'edit' && notes.activeId.value"
              ref="editorRef"
              :value="notes.activeContent.value"
              class="np-editor"
              :placeholder="t('notes.panel.placeholder')"
              :aria-label="t('notes.panel.title')"
              data-testid="notes-editor"
              @input="notes.edit(notes.activeId.value, ($event.target as HTMLTextAreaElement).value)"
              @blur="notes.flushSave(notes.activeId.value)"
            />
            <NotesPreviewPane
              v-if="mode === 'preview'"
              :content="notes.activeContent.value"
            />
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 根自带弹性填充：宿主两形态（主区 flex 列 / overlay 卡片）直接撑满 */
.notes-panel {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: text;
}
.np-loading,
.np-empty {
  margin: auto;
}
.np-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
/* ── 主区 ── */
.np-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.np-tabs {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px 0;
  overflow-x: auto;
  flex-shrink: 0;
  scrollbar-width: thin;
}
.np-tab {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 180px;
  padding: 3px 8px;
  font-size: 12px;
  color: var(--text-secondary);
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: 6px 6px 0 0;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color var(--motion-fast) var(--ease-standard);
}
.np-tab:hover {
  background: var(--bg-hover);
}
.np-tab.active {
  background: var(--bg-hover);
  color: var(--text-primary);
  border-color: var(--border-default);
}
.np-tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-blue);
  flex-shrink: 0;
}
.np-tab-dot.error {
  background: var(--accent-red, #e05561);
}
.np-tab-close {
  border-radius: 3px;
  opacity: 0.4;
  cursor: pointer;
  flex-shrink: 0;
}
.np-tab-close:hover {
  opacity: 1;
  background: var(--bg-hover);
}
/* ── 冲突条 ── */
.np-conflict {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 10px;
  background: var(--bg-warn, var(--bg-hover));
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.np-conflict-text {
  font-size: 11px;
  color: var(--text-primary);
}
.np-conflict-actions {
  display: flex;
  gap: 6px;
  margin-left: auto;
}
/* ── 编辑面 ── */
.np-editor-area {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 编辑面：大区域形态字号/留白上调一档（窄条时代 12px 在主区宽度下过挤） */
.np-editor {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 14px 18px;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  line-height: 1.65;
}
.np-editor::placeholder {
  /* 占位符统一走辅助文字档（P-20261019-4），双底 ≥4.5 */
  color: var(--text-muted);
}
</style>
