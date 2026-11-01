<script setup lang="ts">
// 任务运行器：通过后端 /api/projects/:id/tasks 一次性获取项目所有可用任务
// 支持 npm/Make/Maven/Gradle/Go/Cargo/Python/Just/Taskfile/VSCode/Scripts 共 11 种 manifest
// 点击条目在新终端中执行；如任务带 cwd，注入 "cd <dir> && <cmd>" 跨平台兼容
// 运行历史（P-20261002-120）：按次记录于 uiState，行内「重跑」以原任务定义
// 快照走同一执行链路一键再跑（新终端新记录，旧记录保留）
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { NIcon, NEmpty, NSpin, NInput } from 'naive-ui'
import {
  CloseOutline, PlayOutline, TimeOutline, RefreshOutline,
  CubeOutline,       // npm
  CodeSlashOutline,  // make
  LogoJavascript,    // (fallback)
  FlaskOutline,      // python
  RocketOutline,     // cargo
  TerminalOutline,   // go/just/taskfile/scripts
  Cube,              // maven/gradle (java)
  SettingsOutline,   // vscode
} from '@vicons/ionicons5'
import { useProjectStore } from '../../stores/project'
import { useUIStateStore, type TaskRunEntry } from '../../stores/uiState'
import { tasksApi, terminalApi, getTerminalWsUrl, type TaskItem } from '../../api/client'
import { OPS_ACTIVATE_TERMINAL } from '../../utils/opsEvents'
import { useI18n } from '../../composables/useI18n'
import { hasBlockingOverlay } from '../../utils/overlayGuard'

const props = defineProps<{ show: boolean }>()

const emit = defineEmits<{
  (e: 'update:show', val: boolean): void
}>()

const projectStore = useProjectStore()
const uiStateStore = useUIStateStore()
const { t } = useI18n()

const loading = ref(false)
const allTasks = ref<TaskItem[]>([])

const hasTasks = computed(() => allTasks.value.length > 0)

// 运行历史（P-20261002-120）：uiState.taskRunner.recent 按次持久化运行条目
// （任务定义快照 + 时间戳，新→旧，至多 5 条）——build/test 等高频任务置顶
// 直达；重跑以快照为原任务定义重触发（不依赖清单仍含该任务），快照即参数
const RECENT_LIMIT = 5
const recentRuns = ref<TaskRunEntry[]>([])
function taskKey(task: TaskItem): string {
  return `${task.source}::${task.cwd ?? ''}::${task.name}`
}
// 过滤：按任务名/命令/cwd 子串（不区分大小写）；Enter 在输入框内直开首个匹配
const filter = ref('')
const matchFilter = (task: TaskItem): boolean => {
  const q = filter.value.trim().toLowerCase()
  if (!q) return true
  return task.name.toLowerCase().includes(q) ||
    task.command.toLowerCase().includes(q) ||
    (task.cwd || '').toLowerCase().includes(q)
}

// 运行历史分区同样响应过滤（过滤语义全局一致）；直接渲染快照，不回查清单
const recentTasks = computed<TaskRunEntry[]>(() => {
  return recentRuns.value.filter(e => matchFilter(e.task))
})
const filteredTasks = computed(() => {
  if (!filter.value.trim()) return allTasks.value
  return allTasks.value.filter(matchFilter)
})
const filterInputRef = ref<{ focus: () => void } | null>(null)

// 按 source 分组（保留后端返回的排序）
const groupedTasks = computed(() => {
  const map = new Map<string, TaskItem[]>()
  for (const task of filteredTasks.value) {
    if (!map.has(task.source)) map.set(task.source, [])
    map.get(task.source)!.push(task)
  }
  return Array.from(map.entries())
})

async function loadTasks() {
  if (!projectStore.currentProjectId) return
  loading.value = true
  allTasks.value = []
  try {
    const res: any = await tasksApi.list(projectStore.currentProjectId)
    allTasks.value = res.data || []
    recentRuns.value = await uiStateStore.getTaskRunnerRecent()
  } catch {
    // 静默：后端错误时显示空状态
  } finally {
    loading.value = false
  }
}

// 触发中任务键：创建终端→注入命令的异步窗口内对同任务二次触发（双击/连点）
// 直接忽略（防同任务并发双跑，提案③）；注入已排程/创建失败即解除，面板
// 重开时整体复位——纯启动器无命令完成回执，跨面板的「运行中」不可知
const startingKeys = ref(new Set<string>())

async function runTask(task: TaskItem) {
  if (!projectStore.currentProjectId) return
  const key = taskKey(task)
  if (startingKeys.value.has(key)) return
  startingKeys.value.add(key)
  try {
    const name = task.cwd ? `[${task.cwd}] ${task.source}: ${task.name}` : `${task.source}: ${task.name}`
    const res: any = await terminalApi.create(projectStore.currentProjectId, name)
    const termId = res.data?.id
    if (!termId) {
      startingKeys.value.delete(key)
      return
    }
    // 激活新建的任务终端：TerminalView 的对账只追加 tab 不设激活态，若不
    // 显式广播，任务会在一个永不可见的隐藏终端里静默执行
    window.dispatchEvent(new CustomEvent(OPS_ACTIVATE_TERMINAL, { detail: { id: termId } }))
    // 注入命令：分开发送 cd 与任务命令——Windows PowerShell 5.1 不支持 &&
    // 分隔符（实测 ParserError: InvalidEndOfLine），会话内 cd 持久生效，
    // 拆分发送在 bash/PowerShell 行为一致
    const ws = new WebSocket(getTerminalWsUrl(termId))
    ws.onopen = () => {
      if (task.cwd) {
        ws.send(`cd "${task.cwd}"\r`)
        setTimeout(() => ws.send(task.command + '\r'), 300)
      } else {
        ws.send(task.command + '\r')
      }
      setTimeout(() => ws.close(), 800)
    }
    ws.onerror = () => {
      startingKeys.value.delete(key)
      ws.close()
    }
    // 记录运行历史（P-20261002-120 按次新增：重跑产生新行不复用旧记录，
    // 快照固化原任务定义；新→旧，至多 5 条）并持久化
    recentRuns.value = [{ task: { ...task }, at: Date.now() }, ...recentRuns.value].slice(0, RECENT_LIMIT)
    void uiStateStore.saveTaskRunnerRecent(recentRuns.value)
    emit('update:show', false)
  } catch {
    startingKeys.value.delete(key)
    // 静默
  }
}

// 运行历史行的时间戳：区分同任务多次运行（与命令历史面板 formatTime 同款
// 本地时区呈现，历史只留 5 条、当日为主）
function formatRunTime(at: number): string {
  return new Date(at).toLocaleTimeString()
}

// source 元信息：图标、显示名 i18n key
const sourceMeta: Record<string, { icon: any; color: string }> = {
  npm:      { icon: CubeOutline,       color: 'var(--accent-red)' },
  maven:    { icon: Cube,              color: 'var(--accent-orange)' },
  gradle:   { icon: Cube,              color: 'var(--accent-green)' },
  go:       { icon: TerminalOutline,   color: 'var(--accent-blue)' },
  cargo:    { icon: RocketOutline,     color: 'var(--accent-orange)' },
  python:   { icon: FlaskOutline,      color: 'var(--accent-yellow)' },
  make:     { icon: CodeSlashOutline,  color: 'var(--text-primary)' },
  just:     { icon: TerminalOutline,   color: 'var(--accent-yellow)' },
  taskfile: { icon: TerminalOutline,   color: 'var(--accent-blue)' },
  vscode:   { icon: SettingsOutline,   color: 'var(--accent-blue)' },
  scripts:  { icon: TerminalOutline,   color: 'var(--text-secondary)' },
}

function sourceIcon(source: string): any {
  return sourceMeta[source]?.icon || LogoJavascript
}

function sourceLabel(source: string): string {
  return t(`taskRunner.source.${source}`)
}

watch(() => props.show, async (val) => {
  if (!val) return
  // 面板重开即复位触发中守卫：纯启动器无命令完成回执，上一会话的触发窗口
  // 已不可考，残留只会把历史行重跑永久禁用
  startingKeys.value.clear()
  await loadTasks()
  // 打开即聚焦过滤框：输入即过滤、Enter 运行首个匹配、↓ 进入列表
  if (props.show) {
    filter.value = ''
    filterInputRef.value?.focus()
  }
})

function runFirstFiltered(): void {
  const first = filteredTasks.value[0]
  if (first) runTask(first)
}

function close() {
  emit('update:show', false)
}

// Esc 关闭：与大纲/通知中心等弹层的关闭惯例一致（浮层此前只能点遮罩/×关闭）；
// 有模态弹窗打开时让位（同 AgentTerminal onKeyDown 惯例）。
// ↑↓ 在任务项间移动焦点（环绕）：列表为原生 button，焦点即高亮、Enter 运行；
// 焦点在过滤框内时 ↓ 进入列表首项 / ↑ 到末项，其余输入框类元素让位
const cardRef = ref<HTMLElement>()
function onWindowKeydown(e: KeyboardEvent) {
  if (!props.show) return
  if (e.defaultPrevented) return // Layout 级已消费的 Esc（如退出最大化）不重复处理
  if (e.key === 'Escape') {
    if (hasBlockingOverlay()) return
    e.preventDefault()
    close()
    return
  }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const target = e.target as HTMLElement
  if (target.closest('input, textarea, [contenteditable="true"]')) {
    if (!target.closest('.tr-filter')) return
    e.preventDefault()
    const arr = Array.from(cardRef.value?.querySelectorAll<HTMLButtonElement>('.tr-item') || [])
    if (arr.length === 0) return
    const first = e.key === 'ArrowDown' ? arr[0] : arr[arr.length - 1]
    first?.focus()
    first?.scrollIntoView({ block: 'nearest' })
    return
  }
  if (hasBlockingOverlay()) return
  const items = cardRef.value?.querySelectorAll<HTMLButtonElement>('.tr-item')
  if (!items || items.length === 0) return
  const arr = Array.from(items)
  const cur = arr.indexOf(document.activeElement as HTMLButtonElement)
  const delta = e.key === 'ArrowDown' ? 1 : -1
  const next = cur === -1 ? (delta === 1 ? 0 : arr.length - 1) : (cur + delta + arr.length) % arr.length
  e.preventDefault()
  arr[next]?.focus()
  arr[next]?.scrollIntoView({ block: 'nearest' })
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))
</script>

<template>
  <transition name="tr-fade">
    <div
      v-if="props.show"
      class="tr-mask"
      @click.self="close"
    >
      <div
        ref="cardRef"
        class="tr-card glass-panel"
        tabindex="-1"
      >
        <div class="tr-header">
          <n-icon
            size="13"
            class="tr-icon"
          >
            <PlayOutline />
          </n-icon>
          <span class="tr-title">{{ t('taskRunner.title') }}</span>
          <span class="tr-project">{{ projectStore.currentProject?.name }}</span>
          <button
            class="tr-close"
            :title="t('commandPalette.close')"
            @click="close"
          >
            <n-icon size="12">
              <CloseOutline />
            </n-icon>
          </button>
        </div>

        <div class="tr-filter">
          <n-input
            ref="filterInputRef"
            v-model:value="filter"
            size="small"
            clearable
            :placeholder="t('taskRunner.filterPlaceholder')"
            @keydown.enter.prevent="runFirstFiltered"
          />
        </div>

        <div class="tr-list">
          <div
            v-if="loading"
            class="tr-loading"
          >
            <n-spin size="small" />
          </div>
          <div
            v-else-if="!hasTasks"
            class="tr-empty"
          >
            <n-empty
              size="small"
              :description="t('taskRunner.noTasks')"
            />
          </div>
          <div
            v-else-if="filteredTasks.length === 0"
            class="tr-empty"
          >
            <n-empty
              size="small"
              :description="t('taskRunner.noMatch')"
            />
          </div>
          <template v-else>
            <!-- 运行历史（P-20261002-120）：按次条目（快照+时间戳），行内「重跑」
                 以原任务定义重触发——走 runTask 同一链路，新终端新记录、旧记录保留 -->
            <div
              v-if="recentTasks.length > 0"
              class="tr-section"
            >
              <div class="tr-section-header">
                <n-icon
                  size="11"
                  style="color: var(--accent-green)"
                >
                  <TimeOutline />
                </n-icon>
                <span>{{ t('taskRunner.recentSection') }}</span>
                <span class="tr-section-count">{{ recentTasks.length }}</span>
              </div>
              <div
                v-for="(run, idx) in recentTasks"
                :key="`run-${run.at}-${idx}`"
                class="tr-item-row"
              >
                <button
                  class="tr-item"
                  :title="run.task.command"
                  @click="runTask(run.task)"
                >
                  <span
                    v-if="run.task.cwd"
                    class="tr-item-cwd"
                  >{{ run.task.cwd }}/</span>
                  <span class="tr-item-name">{{ run.task.name }}</span>
                  <span class="tr-item-time">{{ formatRunTime(run.at) }}</span>
                  <span class="tr-item-cmd">{{ run.task.command }}</span>
                  <n-icon
                    size="11"
                    class="tr-item-run"
                  >
                    <PlayOutline />
                  </n-icon>
                </button>
                <button
                  class="tr-rerun"
                  data-testid="task-rerun-btn"
                  :disabled="startingKeys.has(taskKey(run.task))"
                  :title="startingKeys.has(taskKey(run.task)) ? t('task.rerun.running') : t('task.rerun.title')"
                  @click="runTask(run.task)"
                >
                  <n-icon size="11">
                    <RefreshOutline />
                  </n-icon>
                  <span>{{ t('task.rerun.action') }}</span>
                </button>
              </div>
            </div>
            <div
              v-for="[source, tasks] in groupedTasks"
              :key="source"
              class="tr-section"
            >
              <div class="tr-section-header">
                <n-icon
                  size="11"
                  :style="{ color: sourceMeta[source]?.color }"
                >
                  <component :is="sourceIcon(source)" />
                </n-icon>
                <span>{{ sourceLabel(source) }}</span>
                <span class="tr-section-count">{{ tasks.length }}</span>
              </div>
              <button
                v-for="task in tasks"
                :key="`${task.source}-${task.cwd}-${task.name}`"
                class="tr-item"
                :title="task.command"
                @click="runTask(task)"
              >
                <span
                  v-if="task.cwd"
                  class="tr-item-cwd"
                >{{ task.cwd }}/</span>
                <span class="tr-item-name">{{ task.name }}</span>
                <span class="tr-item-cmd">{{ task.command }}</span>
                <n-icon
                  size="11"
                  class="tr-item-run"
                >
                  <PlayOutline />
                </n-icon>
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.tr-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}

.tr-card {
  position: absolute;
  top: 80px;
  right: 16px;
  width: 380px;
  max-height: 70vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tr-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface));
}
.tr-icon { color: var(--brand-accent); }
.tr-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.tr-project {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tr-close {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.tr-close:hover { color: var(--text-primary); background: var(--bg-hover); }

.tr-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.tr-loading { padding: 24px; display: flex; justify-content: center; }
.tr-empty { padding: 28px 16px; display: flex; justify-content: center; }

.tr-section { margin-bottom: 4px; }
.tr-section-header {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  background: var(--bg-panel);
  color: var(--text-secondary);
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}
.tr-section-count {
  margin-left: auto;
  background: var(--brand-accent-soft);
  color: var(--brand-accent);
  padding: 0 5px;
  border-radius: 6px;
  font-size: 9px;
}

.tr-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast);
}
.tr-item:hover { background: var(--bg-hover); }
/* 运行历史行：主体（点击运行）+ 行内「重跑」动作并排（P-20261002-120，
 * 同 P-60 部署重跑的行内动作模式）；悬停整行联动高亮 */
.tr-item-row { display: flex; align-items: stretch; }
.tr-item-row .tr-item { flex: 1; min-width: 0; }
.tr-item-row:hover .tr-item { background: var(--bg-hover); }
.tr-rerun {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 0 10px 0 4px;
  flex-shrink: 0;
  cursor: pointer;
  transition: color var(--motion-fast), background var(--motion-fast);
}
.tr-rerun:hover:not(:disabled) { color: var(--accent-green); }
.tr-rerun:disabled { opacity: 0.4; cursor: default; }
/* 键盘导航：卡片承接焦点（容器 outline 抑制），任务项焦点环即指示 */
.tr-card:focus, .tr-card:focus-visible { outline: none; }
.tr-filter { padding: 0 12px 8px; }

.tr-item-cwd {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  background: color-mix(in srgb, var(--accent-blue) 12%, transparent);
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}

.tr-item-name {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--brand-accent);
  flex-shrink: 0;
}
/* 运行历史行的时间戳（区分同任务多次运行） */
.tr-item-time {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-muted);
  flex-shrink: 0;
}
.tr-item-cmd {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-muted);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tr-item-run {
  color: var(--text-muted);
  flex-shrink: 0;
  opacity: 0;
  transition: opacity var(--motion-fast);
}
.tr-item:hover .tr-item-run { opacity: 1; color: var(--accent-green); }

.tr-fade-enter-active, .tr-fade-leave-active { transition: opacity var(--motion-base); }
.tr-fade-enter-active .tr-card, .tr-fade-leave-active .tr-card { transition: transform var(--motion-base), opacity var(--motion-base); }
.tr-fade-enter-from, .tr-fade-leave-to { opacity: 0; }
.tr-fade-enter-from .tr-card, .tr-fade-leave-to .tr-card { transform: translateY(-8px) scale(0.98); opacity: 0; }
</style>
