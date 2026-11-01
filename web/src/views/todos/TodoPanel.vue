<script setup lang="ts">
// TODO 面板（P-20261002-25）：代码注释 TODO/FIXME/XXX/HACK 聚合「赊账清单」。
// 数据面：GET /projects/:id/todos（复用内容搜索双后端，服务端按文件分组，
// 上限 500 条 + truncated 标记）；本组件只消费。低频查看场景不做 watch 实时，
// 手动刷新 + 项目切换重拉。点击条目复用 OPS_OPEN_FILE_AT 既有
// 「打开文件 + 行定位」链路（ProjectSearch / 终端文件链接同款）。
// 「交给智能体修」（P-20261003-159）：条目行内按钮单条发起（附上下文行）、
// 勾选多条批量一次交一个会话——prompt 组装与发起链收口 useTodoAgentFix。
// 「已处理」勾选（P-20261003-200）：面板态隐藏（代码注释保留不受影响），
// localStorage 项目维持久化 + 「显示已处理」开关——纯函数收口 utils/todoHandled。
import { computed, onMounted, ref, watch } from 'vue'
import { NButton, NEmpty, NIcon, NSpin, useMessage } from 'naive-ui'
import { CheckmarkOutline, EyeOffOutline, EyeOutline, RefreshOutline, SparklesOutline } from '@vicons/ionicons5'
import { projectApi } from '../../api/client'
import { useProjectStore } from '../../stores/project'
import { useI18n } from '../../composables/useI18n'
import { useTodoAgentFix, type TodoFixItem } from '../../composables/useTodoAgentFix'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../../utils/opsEvents'
import { safeStorage } from '../../utils/storage'
import {
  handledKeyOf,
  markHandled,
  parseHandledRecord,
  serializeHandledRecord,
  unmarkHandled,
} from '../../utils/todoHandled'

interface TodoMatch {
  path: string
  line: number
  column: number
  content: string
}

interface TodoFileGroup {
  path: string
  items: TodoMatch[]
}

const projectStore = useProjectStore()
const { t } = useI18n()
const message = useMessage()

const loading = ref(false)
const loadFailed = ref(false)
const groups = ref<TodoFileGroup[]>([])
const total = ref(0)
const truncated = ref(false)

// 徽标类型从整行文本提取（服务端返回整行不裁剪）；理论上必命中
// （服务端按 TODO|FIXME|XXX|HACK 整词扫描），兜底 TODO 防脏数据渲染空白
const MARK_RE = /\b(TODO|FIXME|XXX|HACK)\b/
function markerOf(content: string): string {
  return MARK_RE.exec(content)?.[1] ?? 'TODO'
}

// 刷新令牌：项目切换/连点刷新时旧请求的过期响应不落地（避免 A 项目结果
// 滞留在 B 项目面板里），最近一次刷新独占落地权
let reqToken = 0

async function refresh() {
  const pid = projectStore.currentProjectId
  if (!pid) return
  const token = ++reqToken
  loading.value = true
  loadFailed.value = false
  try {
    const res = (await projectApi.projectTodos(pid)) as {
      data?: TodoFileGroup[]
      total?: number
      truncated?: boolean
    }
    if (token !== reqToken) return
    groups.value = res.data ?? []
    total.value = res.total ?? 0
    truncated.value = !!res.truncated
    // 清单整体换新：勾选键基于旧快照，一并不保留（陈旧键静默失效更难解释）。
    // 「已处理」集合刻意不清（P-20261003-200）：它与代码注释生命周期独立，
    // 靠 path:line 匹配容忍漂移，陈旧键自然失配（见 todoHandled.ts 头注）
    selectedKeys.value = []
  } catch (e) {
    if (token !== reqToken) return
    loadFailed.value = true
    message.error((e as { userMessage?: string }).userMessage || t('todo.panel.loadFailed'))
  } finally {
    if (token === reqToken) loading.value = false
  }
}

function openAt(m: TodoMatch) {
  const pid = projectStore.currentProjectId
  if (!pid) return
  const detail: OpenFileAtDetail = { path: m.path, projectId: pid, line: m.line, col: m.column }
  window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, { detail }))
}

// ── 「交给智能体修」（P-20261003-159）：条目勾选 + 单条/批量发起 ──
const { handTodosToAgent } = useTodoAgentFix()
const fixing = ref(false)

// 勾选用 path:line:column 键（同一线两标记共存时仍互不干扰）；数组保勾选序
const selectedKeys = ref<string[]>([])
const selectedCount = computed(() => selectedKeys.value.length)
function itemKey(m: TodoMatch): string {
  return `${m.path}:${m.line}:${m.column}`
}
function isSelected(m: TodoMatch): boolean {
  return selectedKeys.value.includes(itemKey(m))
}
function toggleSelect(m: TodoMatch) {
  const k = itemKey(m)
  const idx = selectedKeys.value.indexOf(k)
  if (idx >= 0) selectedKeys.value.splice(idx, 1)
  else selectedKeys.value.push(k)
}
function selectAll() {
  // 全选只圈当前可见条目：已处理隐藏中的条目不进批量发起（所见即所选）
  selectedKeys.value = visibleGroups.value.flatMap(g => g.items.map(itemKey))
}
function clearSelection() {
  selectedKeys.value = []
}
/** 勾选键 → 发起条目（按当前清单投影，陈旧键自然剔除）；保持勾选顺序 */
function selectedItems(): TodoFixItem[] {
  const byKey = new Map<string, TodoFixItem>()
  for (const g of groups.value) {
    for (const m of g.items) byKey.set(itemKey(m), { path: m.path, line: m.line, content: m.content })
  }
  return selectedKeys.value
    .map(k => byKey.get(k))
    .filter((x): x is TodoFixItem => !!x)
}

/** 单条发起：附上下文行（组合式内静默读文件，失败自动降级） */
async function fixOne(m: TodoMatch) {
  if (fixing.value) return
  fixing.value = true
  try {
    await handTodosToAgent([{ path: m.path, line: m.line, content: m.content }], { withContext: true })
  } finally {
    fixing.value = false
  }
}

/** 批量发起：勾选 N 条一次交一个会话（500 字节装箱 + 分批注记在组合式内）；
 *  创建成功才清勾选（失败/取消保留，可调整后重试） */
async function fixSelected() {
  if (fixing.value) return
  const items = selectedItems()
  if (items.length === 0) return
  fixing.value = true
  try {
    if (await handTodosToAgent(items)) clearSelection()
  } finally {
    fixing.value = false
  }
}

// ── 「已处理」勾选（P-20261003-200）：面板态隐藏，代码注释保留不影响 ──
// 与 tp-check（交给智能体修的批量勾选）是两回事：那边是发起前的暂存选择，
// 这边是「这条我处置完了」的轻记账。键用 path:line（不带 column）——
// 扫描刷新按行号匹配，代码挪行后的陈旧键自然失配（漂移容忍，任务书注记）
const HANDLED_STORAGE_KEY = 'todo.handled'
const handledKeys = ref<Set<string>>(new Set())
const showHandled = ref(false)

function isHandled(m: TodoMatch): boolean {
  return handledKeys.value.has(handledKeyOf(m.path, m.line))
}

/** 读 localStorage：当前项目的已处理键集 + 全局显示开关（防御解析在 utils） */
function loadHandledState() {
  const rec = parseHandledRecord(safeStorage.getItem(HANDLED_STORAGE_KEY))
  showHandled.value = rec.showHandled
  const pid = projectStore.currentProjectId
  handledKeys.value = new Set(pid ? (rec.byProject[pid] ?? []) : [])
}

/** 落盘：低频用户动作即时写；空集删除项目键（不占映射槽位） */
function persistHandledState() {
  const pid = projectStore.currentProjectId
  if (!pid) return
  const rec = parseHandledRecord(safeStorage.getItem(HANDLED_STORAGE_KEY))
  const keys = [...handledKeys.value]
  if (keys.length) rec.byProject[pid] = keys
  else delete rec.byProject[pid]
  safeStorage.setItem(HANDLED_STORAGE_KEY, serializeHandledRecord(rec))
}

function toggleHandled(m: TodoMatch) {
  const k = handledKeyOf(m.path, m.line)
  const list = [...handledKeys.value]
  const marking = !handledKeys.value.has(k)
  handledKeys.value = new Set(marking ? markHandled(list, k) : unmarkHandled(list, k))
  if (marking) {
    // 隐藏即将条目带出视野：若它还挂在批量发起勾选上，一并摘除（不留幽灵勾选）
    const idx = selectedKeys.value.indexOf(itemKey(m))
    if (idx >= 0) selectedKeys.value.splice(idx, 1)
  }
  persistHandledState()
}

function toggleShowHandled() {
  showHandled.value = !showHandled.value
  const rec = parseHandledRecord(safeStorage.getItem(HANDLED_STORAGE_KEY))
  rec.showHandled = showHandled.value
  safeStorage.setItem(HANDLED_STORAGE_KEY, serializeHandledRecord(rec))
}

/** 当前扫描里已处理的条数（陈旧孤儿键不计——计数跟着面板可见口径走） */
const handledCount = computed(() => {
  let n = 0
  for (const g of groups.value) for (const m of g.items) if (isHandled(m)) n++
  return n
})

/** 展示分组：隐藏已处理时过滤条目并剔除空组；显示开关打开则原样透传 */
const visibleGroups = computed(() => {
  if (showHandled.value) return groups.value
  return groups.value
    .map(g => ({ ...g, items: g.items.filter(m => !isHandled(m)) }))
    .filter(g => g.items.length > 0)
})

// 项目切换（顶栏选择器/命令面板）后按新项目重拉；开关面板不重拉（手动语义）
watch(() => projectStore.currentProjectId, () => {
  loadHandledState()
  void refresh()
})
onMounted(() => {
  loadHandledState()
  void refresh()
})
</script>

<template>
  <div
    class="todo-panel"
    data-testid="todo-panel"
  >
    <div class="tp-header">
      <span class="tp-title">{{ t('todo.panel.title') }}</span>
      <span
        class="tp-total"
        data-testid="todo-total"
      >{{ total }}</span>
      <button
        v-if="handledCount > 0"
        class="tp-done-chip"
        :class="{ 'tp-done-chip-on': showHandled }"
        :title="t('todo.handled.chipTitle', { n: handledCount })"
        :aria-pressed="showHandled"
        data-testid="todo-handled-count"
        @click="toggleShowHandled"
      >
        {{ t('todo.handled.chip', { n: handledCount }) }}
      </button>
      <span
        v-if="truncated"
        class="tp-truncated"
      >{{ t('todo.panel.truncated') }}</span>
      <NButton
        quaternary
        size="tiny"
        class="tp-refresh"
        :title="t('todo.panel.refresh')"
        :aria-label="t('todo.panel.refresh')"
        data-testid="todo-refresh"
        @click="refresh()"
      >
        <template #icon>
          <NIcon><RefreshOutline /></NIcon>
        </template>
      </NButton>
      <NButton
        quaternary
        size="tiny"
        class="tp-eye"
        :title="t(showHandled ? 'todo.handled.hideDone' : 'todo.handled.showDone')"
        :aria-label="t(showHandled ? 'todo.handled.hideDone' : 'todo.handled.showDone')"
        :aria-pressed="showHandled"
        data-testid="todo-show-handled"
        @click="toggleShowHandled"
      >
        <template #icon>
          <NIcon><EyeOutline v-if="showHandled" /><EyeOffOutline v-else /></NIcon>
        </template>
      </NButton>
    </div>
    <div
      v-if="selectedCount > 0"
      class="tp-batch"
      data-testid="todo-batch-bar"
    >
      <span
        class="tp-batch-count"
        data-testid="todo-batch-count"
      >{{ t('todo.fix.selected', { n: selectedCount }) }}</span>
      <NButton
        quaternary
        size="tiny"
        class="tp-batch-link"
        @click="selectAll"
      >
        {{ t('todo.fix.selectAll') }}
      </NButton>
      <NButton
        quaternary
        size="tiny"
        class="tp-batch-link"
        @click="clearSelection"
      >
        {{ t('todo.fix.clear') }}
      </NButton>
      <NButton
        size="tiny"
        type="primary"
        secondary
        class="tp-batch-go"
        :loading="fixing"
        :title="t('todo.fix.batchTitle')"
        data-testid="todo-batch-fix"
        @click="fixSelected"
      >
        {{ t('todo.fix.batchAction', { n: selectedCount }) }}
      </NButton>
    </div>
    <NSpin
      v-if="loading"
      class="tp-loading"
      size="small"
    />
    <NEmpty
      v-else-if="loadFailed"
      class="tp-empty"
      size="small"
      :description="t('todo.panel.loadFailed')"
    />
    <NEmpty
      v-else-if="groups.length === 0"
      class="tp-empty"
      size="small"
      :description="t('todo.panel.empty')"
    />
    <NEmpty
      v-else-if="visibleGroups.length === 0"
      class="tp-empty"
      size="small"
      :description="t('todo.handled.allDone')"
    />
    <div
      v-else
      class="tp-list"
    >
      <div
        v-for="g in visibleGroups"
        :key="g.path"
        class="tp-file"
      >
        <div
          class="tp-file-header"
          :title="g.path"
        >
          <span class="tp-file-name">{{ g.path.split('/').pop() }}</span>
          <span class="tp-file-dir">{{ g.path }}</span>
          <span class="tp-file-count">{{ g.items.length }}</span>
        </div>
        <div
          v-for="m in g.items"
          :key="`${m.line}:${m.column}`"
          class="tp-item"
          :class="{ 'tp-sel': isSelected(m), 'tp-is-done': isHandled(m) }"
        >
          <input
            type="checkbox"
            class="tp-check"
            :checked="isSelected(m)"
            :aria-label="t('todo.fix.action')"
            :data-testid="'todo-check-' + m.line"
            @click="toggleSelect(m)"
          >
          <button
            class="tp-main"
            :title="m.content"
            :data-testid="'todo-item-' + m.line"
            @click="openAt(m)"
          >
            <span
              class="tp-badge"
              :class="'mk-' + markerOf(m.content).toLowerCase()"
            >{{ markerOf(m.content) }}</span>
            <span class="tp-line-num">{{ m.line }}</span>
            <span class="tp-content">{{ m.content.trim() }}</span>
          </button>
          <button
            class="tp-done"
            :class="{ 'tp-done-on': isHandled(m) }"
            :title="t(isHandled(m) ? 'todo.handled.unmarkTitle' : 'todo.handled.markTitle')"
            :aria-label="t(isHandled(m) ? 'todo.handled.unmark' : 'todo.handled.mark')"
            :aria-pressed="isHandled(m)"
            :data-testid="'todo-done-' + m.line"
            @click="toggleHandled(m)"
          >
            <NIcon :size="13">
              <CheckmarkOutline />
            </NIcon>
          </button>
          <button
            class="tp-fix"
            :title="t('todo.fix.actionTitle')"
            :aria-label="t('todo.fix.action')"
            :disabled="fixing"
            :data-testid="'todo-fix-' + m.line"
            @click="fixOne(m)"
          >
            <NIcon :size="13">
              <SparklesOutline />
            </NIcon>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.todo-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tp-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
  font-size: var(--fs-small);
}
.tp-title {
  font-weight: 600;
  color: var(--text-primary);
}
.tp-total {
  color: var(--accent-blue);
  background: var(--brand-accent-soft);
  border-radius: 8px;
  padding: 0 7px;
  font-size: var(--fs-tiny);
  line-height: 16px;
}
.tp-truncated {
  color: var(--accent-orange);
  font-size: var(--fs-tiny);
}
.tp-refresh {
  margin-left: auto;
}
/* 「显示已处理」开关（P-20261003-200）：与刷新钮同族的小图标钮，常驻右缘 */
.tp-eye {
  margin-left: 2px;
}
/* 已处理计数 chip：点按同开关切换显示；on 态描边提示当前正处于「显示」 */
.tp-done-chip {
  flex-shrink: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 0 7px;
  font-size: var(--fs-tiny);
  line-height: 16px;
  color: var(--text-muted);
  background: var(--bg-hover);
  cursor: pointer;
}
.tp-done-chip-on {
  color: var(--accent-blue);
  border-color: var(--accent-blue);
}
.tp-loading,
.tp-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px 0;
}
.tp-list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 8px;
}
.tp-file {
  margin-bottom: 2px;
}
.tp-file-header {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 4px 10px 2px;
  font-size: var(--fs-tiny);
  color: var(--text-secondary);
  overflow: hidden;
  white-space: nowrap;
}
.tp-file-name {
  color: var(--text-primary);
  font-weight: 600;
  flex-shrink: 0;
}
.tp-file-dir {
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl; /* 目录过长时截头部保文件名语境 */
  text-align: left;
}
.tp-file-count {
  flex-shrink: 0;
  color: var(--text-muted);
}
/* 批量操作条（P-20261003-159）：有勾选时出现在表头下方 */
.tp-batch {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
  font-size: var(--fs-tiny);
}
.tp-batch-count {
  color: var(--text-secondary);
  margin-right: auto;
}
.tp-batch-go {
  margin-left: 4px;
}
/* 条目行 = 勾选框 + 主点击区（徽标/行号/文本）+ 单条修复按钮 */
.tp-item {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  padding: 2px 10px 2px 6px;
  font-size: var(--fs-tiny);
}
.tp-item:hover {
  background: var(--bg-hover);
}
.tp-item.tp-sel {
  background: var(--brand-accent-soft);
}
/* 已处理条目（显示开关打开时可见）：删除线 + 整行降透明，与未处理一眼可辨 */
.tp-item.tp-is-done .tp-main {
  text-decoration: line-through;
  opacity: 0.55;
}
.tp-item.tp-is-done .tp-badge {
  opacity: 0.55;
}
.tp-check {
  flex-shrink: 0;
  width: 13px;
  height: 13px;
  margin: 0;
  cursor: pointer;
  accent-color: var(--accent-blue);
}
.tp-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 2px 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
  font-size: var(--fs-tiny);
  color: var(--text-body);
}
.tp-fix {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
}
.tp-fix:hover:not(:disabled) {
  color: var(--accent-blue);
  background: var(--bg-hover);
}
.tp-fix:disabled {
  opacity: 0.5;
  cursor: default;
}
/* 「已处理」勾选钮（P-20261003-200）：hover/聚焦浮现（.nc-dismiss 同款惯例），
 * 已处理态常驻显形；轻处置动作默认隐形免得与批量勾选/修复钮抢视觉 */
.tp-done {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
}
.tp-item:hover .tp-done,
.tp-item:focus-within .tp-done,
.tp-done.tp-done-on {
  opacity: 1;
}
.tp-done:hover {
  color: var(--accent-green);
  background: var(--bg-hover);
}
.tp-done.tp-done-on {
  color: var(--accent-blue);
}
.tp-badge {
  flex-shrink: 0;
  border-radius: 3px;
  padding: 0 4px;
  font-size: 10px;
  line-height: 14px;
  font-weight: 600;
}
/* 徽标衬底跟随主题强调色（color-mix 与 AgentSidebar 会话树同款用法），不再残留暗色调色板直写 */
.mk-todo { color: var(--accent-blue); background: color-mix(in srgb, var(--accent-blue) 14%, transparent); }
.mk-fixme { color: var(--accent-red); background: color-mix(in srgb, var(--accent-red) 14%, transparent); }
.mk-xxx { color: var(--accent-orange); background: color-mix(in srgb, var(--accent-orange) 14%, transparent); }
.mk-hack { color: var(--accent-purple); background: color-mix(in srgb, var(--accent-purple) 14%, transparent); }
.tp-line-num {
  flex-shrink: 0;
  color: var(--text-muted);
  min-width: 22px;
  text-align: right;
}
.tp-content {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
