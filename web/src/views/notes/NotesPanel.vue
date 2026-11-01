<script setup lang="ts">
// 项目笔记面板（P-20261002-110，人机共享便签层）：项目一文档的 markdown 便签，
// 人机共享——人写交接说明/待办/决策记录，agent 经 ops 手册登记的 REST 通道
// 读写同一份（服务端 GET/PUT /projects/:id/notes）。
// 编辑形态：textarea + 预览切换（MVP 不上 Monaco，与提案一致），防抖自动保存
// （停顿 800ms 落盘；切项目/卸载前 flush）。并发策略为 last-writer-wins
// （面板与 agent 后写覆盖，无版本协商——面板每次挂载重读磁盘最新内容）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NIcon, NSpin, useMessage } from 'naive-ui'
import { CreateOutline, EyeOutline } from '@vicons/ionicons5'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { projectApi } from '../../api/client'
import { useProjectStore } from '../../stores/project'
import { useI18n } from '../../composables/useI18n'
import { NOTES_EXTERNAL_UPDATE, type NotesExternalUpdateDetail } from '../../utils/opsEvents'

const projectStore = useProjectStore()
const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const loadFailed = ref(false)
const content = ref('')
// edit | preview——切换不重置编辑态，仅换呈现层
const mode = ref<'edit' | 'preview'>('edit')
// 保存状态：idle（已同步）| dirty（待存）| saving | error
const saveState = ref<'idle' | 'dirty' | 'saving' | 'error'>('idle')
const statusText = computed(() => ({
  idle: '',
  dirty: t('notes.panel.dirty'),
  saving: t('notes.panel.saving'),
  error: t('notes.panel.saveFailed'),
})[saveState.value])

// 刷新令牌：项目切换/快速重开时旧请求的过期响应不落地（TodoPanel 同款，
// 避免 A 项目笔记滞留在 B 项目面板里）
let reqToken = 0
// 防抖定时器与挂起写入的目标项目：闭包捕获输入时的 pid，项目切换后
// 迟到的 flush 仍写回原项目（内容归属正确）
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingPid = ''

const NOTES_SAVE_DEBOUNCE_MS = 800

/** markdown → 消毒后的 HTML（changelog/帮助中心同一条 marked+DOMPurify 管线；
 *  笔记是 agent 也可写的内容，消毒不可省） */
function renderPreview(md: string): string {
  const html = marked.parse(md || '', { async: false }) as string
  return DOMPurify.sanitize(html)
}

async function load(): Promise<void> {
  const pid = projectStore.currentProjectId
  if (!pid) return
  const token = ++reqToken
  loading.value = true
  loadFailed.value = false
  try {
    const res = (await projectApi.projectNotes(pid)) as { data?: { content?: string } }
    if (token !== reqToken) return
    content.value = res.data?.content ?? ''
    saveState.value = 'idle'
  } catch {
    if (token !== reqToken) return
    loadFailed.value = true
    saveState.value = 'idle'
  } finally {
    if (token === reqToken) loading.value = false
  }
}

function scheduleSave(): void {
  const pid = projectStore.currentProjectId
  if (!pid) return
  pendingPid = pid
  saveState.value = 'dirty'
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => { void flushSave() }, NOTES_SAVE_DEBOUNCE_MS)
}

function isTooLarge(e: unknown): boolean {
  const err = e as { status?: number; response?: { status?: number } }
  return err?.status === 413 || err?.response?.status === 413
}

/** 立即落盘挂起的修改（防抖到期 / 失焦 / 切项目 / 面板卸载共用）。
 *  全量覆盖写（last-writer-wins）：写挂起时捕获的 pid，不写当前项目 */
async function flushSave(): Promise<void> {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
  if (saveState.value !== 'dirty' || !pendingPid) return
  const pid = pendingPid
  saveState.value = 'saving'
  try {
    await projectApi.saveProjectNotes(pid, content.value)
    // 项目已切走时只终结状态，不碰新项目的编辑态（新项目已由 load 接管）
    if (projectStore.currentProjectId === pid && saveState.value === 'saving') {
      saveState.value = 'idle'
    }
  } catch (e) {
    if (projectStore.currentProjectId !== pid) return
    saveState.value = 'error'
    message.error(
      (e as { userMessage?: string }).userMessage
      || (isTooLarge(e) ? t('notes.panel.tooLarge') : t('notes.panel.saveFailed')),
    )
  }
}

/** 项目切换：先落盘旧项目挂起修改，再读新项目（token 令牌保证乱序响应不落地） */
watch(() => projectStore.currentProjectId, () => { void flushSave().then(load) })

/** 笔记被外部整份写回（P-20261003-292「沉淀到笔记」等）：无未保存编辑时从
 *  服务端重读——否则面板旧内容会在下次防抖保存时整体覆盖外部写入（
 *  last-writer-wins 无版本协商）；有挂起编辑时不动本面板（人的输入优先，
 *  外部内容下次挂载自然可见），面板未挂载时事件落空由挂载 load() 兜底 */
function onExternalUpdate(e: Event): void {
  const detail = (e as CustomEvent<NotesExternalUpdateDetail>).detail
  if (!detail || detail.projectId !== projectStore.currentProjectId) return
  if (saveState.value === 'dirty' || saveState.value === 'saving') return
  void load()
}

onMounted(() => {
  window.addEventListener(NOTES_EXTERNAL_UPDATE, onExternalUpdate)
  void load()
})
onBeforeUnmount(() => {
  window.removeEventListener(NOTES_EXTERNAL_UPDATE, onExternalUpdate)
  void flushSave()
})
</script>

<template>
  <div
    class="notes-panel"
    data-testid="notes-panel"
  >
    <div class="np-header">
      <span class="np-title">{{ t('notes.panel.title') }}</span>
      <span
        v-if="statusText"
        class="np-status"
        :class="'st-' + saveState"
        data-testid="notes-status"
      >{{ statusText }}</span>
      <div class="np-mode">
        <NButton
          quaternary
          size="tiny"
          :type="mode === 'edit' ? 'primary' : 'default'"
          :title="t('notes.panel.edit')"
          :aria-label="t('notes.panel.edit')"
          data-testid="notes-mode-edit"
          @click="mode = 'edit'"
        >
          <template #icon>
            <NIcon data-icon-action="common.edit"><CreateOutline /></NIcon>
          </template>
        </NButton>
        <NButton
          quaternary
          size="tiny"
          :type="mode === 'preview' ? 'primary' : 'default'"
          :title="t('notes.panel.preview')"
          :aria-label="t('notes.panel.preview')"
          data-testid="notes-mode-preview"
          @click="mode = 'preview'"
        >
          <template #icon>
            <NIcon data-icon-action="common.preview"><EyeOutline /></NIcon>
          </template>
        </NButton>
      </div>
    </div>
    <NSpin
      v-if="loading"
      class="np-loading"
      size="small"
    />
    <NEmpty
      v-else-if="loadFailed"
      class="np-empty"
      size="small"
      :description="t('notes.panel.loadFailed')"
    />
    <NEmpty
      v-else-if="!projectStore.currentProjectId"
      class="np-empty"
      size="small"
      :description="t('notes.panel.noProject')"
    />
    <template v-else>
      <div class="np-body">
        <textarea
          v-show="mode === 'edit'"
          v-model="content"
          class="np-editor"
          :placeholder="t('notes.panel.placeholder')"
          :aria-label="t('notes.panel.title')"
          data-testid="notes-editor"
          @input="scheduleSave"
          @blur="flushSave"
        />
        <!-- eslint-disable-next-line vue/no-v-html —— marked+DOMPurify 消毒后渲染（agent 亦可写，消毒不可省） -->
        <div
          v-if="mode === 'preview'"
          class="np-preview"
          data-testid="notes-preview"
          v-html="renderPreview(content)"
        />
      </div>
    </template>
  </div>
</template>

<style scoped>
.notes-panel {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  user-select: text;
}
.np-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border-default);
}
.np-title {
  font-weight: 600;
  font-size: 12px;
}
.np-status {
  font-size: 11px;
  color: var(--text-tertiary);
}
.np-status.st-error {
  color: var(--accent-red, #e05561);
}
.np-mode {
  margin-left: auto;
  display: flex;
  gap: 2px;
}
.np-loading,
.np-empty {
  margin: auto;
}
.np-body {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.np-editor {
  flex: 1;
  min-height: 0;
  width: 100%;
  border: none;
  outline: none;
  resize: none;
  padding: 10px 12px;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.6;
}
.np-editor::placeholder {
  /* --text-tertiary 从未定义（回退继承正文色）；占位符统一走辅助文字档
     （P-20261019-4），在双底 ≥4.5 且与 Naive 输入框占位符同源 */
  color: var(--text-muted);
}
.np-preview {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}
.np-preview :deep(h1),
.np-preview :deep(h2),
.np-preview :deep(h3) {
  font-size: 13px;
  margin: 8px 0 4px;
}
.np-preview :deep(p) {
  margin: 4px 0;
}
.np-preview :deep(ul),
.np-preview :deep(ol) {
  padding-left: 20px;
  margin: 4px 0;
}
.np-preview :deep(code) {
  background: var(--bg-hover);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 11px;
}
.np-preview :deep(pre) {
  background: var(--bg-hover);
  padding: 8px;
  border-radius: 4px;
  overflow: auto;
}
.np-preview :deep(a) {
  color: var(--accent-blue);
}
</style>
