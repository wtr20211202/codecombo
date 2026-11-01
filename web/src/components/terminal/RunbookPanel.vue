<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { NButton, NIcon, useMessage } from 'naive-ui'
import { CloseOutline, ArrowBackOutline, AddOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { runbookApi, type Runbook, type RunbookOnFailure } from '../../api/client'
import type { RunbookRunRequest, RunbookRunState } from '../../composables/useRunbookRunner'
import type { TermTab } from '../../composables/useTerminalTabs'
import { useRunbookDraftStore } from '../../stores/runbookDraft'
import RunbookCreateForm from './RunbookCreateForm.vue'
import RunbookBookList from './RunbookBookList.vue'
import RunbookBookView from './RunbookBookView.vue'

/**
 * 运行书面板（P-20261003-24）：侧板挂在终端区内（与片段选择器同款形态）。
 * - 列表 → 打开 → 逐步「发送到当前终端」：插入不执行（回车由人按，安全默认）；
 *   带 {参数} 占位符的步骤内联展开填值后插值发送（P-123 兼容）
 * - 步骤完成勾选：会话内 transient 状态（面板关闭即失，不落盘）；发送即视为完成
 * - 新建/删除内联在本面板闭环（规模 M：不另设设置分区）
 * - 序贯「运行」（P-20261004-13 onFailure 语义）：显式触发，各步命令 + \r 真执行；
 *   执行器在宿主（TerminalView）持有（面板关闭运行不中断），本面板只发请求与呈现
 * - 全书参数（P-20261004-17）：执行时先汇集待执行步骤的 {参数} 并集去重，一次
 *   内联表单填完（多步共享同名参数只问一次），确认后统一替换进各步——与片段
 *   P-123 同款语法（utils/textTemplate 共用解析，不弹新窗）
 *
 * 面板区拆分（热点瘦身第三批，纯搬运零逻辑改动）：新建表单区/列表区/打开书区
 * 各为就近子组件（RunbookCreateForm/RunbookBookList/RunbookBookView），本壳持有
 * 跨区状态（books/opened/doneSteps/creating）与宿主事件转发。
 * - 舰队运行（P-20261005-147）：目标多选（本机 shell / agent / 远程主机三组，
 *   广播候选同源）+ 服务端编排引擎——每步广播写全目标 + 逐步逐目标矩阵
 *   （task.progress 事件驱动合并态），中止（Ctrl+C 广播）与失败格单台重试；
 *   点格拉该会话 scrollback 尾部回看（P-20261005-12 聚合视图的单步化复用）。
 *   实施面在 RunbookBookView（与全书参数表单同域），本壳只透传 tabs 候选。
 */
const props = defineProps<{ runState?: RunbookRunState | null; tabs?: TermTab[] }>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'insert', command: string): void
  (e: 'run', payload: RunbookRunRequest): void
  (e: 'runStop'): void
}>()

const { t } = useI18n()
const message = useMessage()

const books = ref<Runbook[]>([])
const loading = ref(false)

// 打开的运行书（一次一本）；步骤勾选按运行书 id 记（步骤序号集合）
const opened = ref<Runbook | null>(null)
const doneSteps = ref<Record<string, number[]>>({})

// 新建表单显隐：字段态在表单子组件自持（挂载即空白，等价原 startCreate 重置）
const creating = ref(false)

async function fetchBooks() {
  loading.value = true
  try {
    const res = await runbookApi.list({ silent: true })
    books.value = res.data || []
  } catch { /* silent：保留上次结果 */ } finally {
    loading.value = false
  }
}

// 打开书区的展开/填值态（expandedStep/paramValues/全书参数表单）是书内
// transient——子组件按 :key=book.id 重挂即重置，等价原先这里的显式清空
function openBook(b: Runbook) {
  opened.value = b
}

function backToList() {
  opened.value = null
}

function toggleDone(index: number) {
  const id = opened.value?.id || ''
  const cur = doneSteps.value[id] || []
  doneSteps.value[id] = cur.includes(index) ? cur.filter(i => i !== index) : [...cur, index]
}

function resetDone() {
  if (opened.value) doneSteps.value[opened.value.id] = []
}

async function deleteBook(b: Runbook) {
  try {
    await runbookApi.remove(b.id)
    message.success(t('runbook.deleted'))
    if (opened.value?.id === b.id) backToList()
    delete doneSteps.value[b.id]
    await fetchBooks()
  } catch { /* 拦截器提示 */ }
}

// 新建表单落库成功收尾：关表单 + 刷新列表（saveBook 链在子组件）
function onFormSaved() {
  creating.value = false
  fetchBooks()
}

/** 失败即停开关（打开的书内直接改，走 update 既有链路；乐观更新失败回滚）。
 *  运行态守卫在打开书区发件侧判定（开关运行态禁用的兜底），books 持有方执行 */
async function updateOnFailure(v: boolean) {
  const b = opened.value
  if (!b) return
  const next: RunbookOnFailure = v ? 'stop' : 'continue'
  const prev: RunbookOnFailure = (b.onFailure || 'continue') as RunbookOnFailure
  b.onFailure = next
  try {
    await runbookApi.update(b.id, { onFailure: next })
  } catch {
    b.onFailure = prev
  }
}

// ── 录制一键转运行书（P-20261005-3）：见草稿在位即展开新建表单；字段预填与
// 消费清位在表单子组件挂载时进行（immediate 守住「面板随草稿在位挂载」时序）──
const draftStore = useRunbookDraftStore()
watch(() => draftStore.pending, (d) => { if (d) creating.value = true }, { immediate: true })

onMounted(fetchBooks)
defineExpose({ refresh: fetchBooks })
</script>

<template>
  <aside class="runbook-panel">
    <div class="runbook-header">
      <button
        v-if="opened"
        class="runbook-back"
        :title="t('runbook.back')"
        @click="backToList"
      >
        <n-icon size="13">
          <ArrowBackOutline />
        </n-icon>
      </button>
      <span class="runbook-title">{{ opened ? opened.title : t('runbook.title') }}</span>
      <div class="runbook-header-actions">
        <n-button
          v-if="!opened && !creating"
          size="tiny"
          quaternary
          :title="t('runbook.add')"
          @click="creating = true"
        >
          <template #icon>
            <n-icon size="13">
              <AddOutline />
            </n-icon>
          </template>
        </n-button>
        <n-button
          size="tiny"
          quaternary
          :title="t('common.close')"
          @click="emit('close')"
        >
          <template #icon>
            <n-icon size="13">
              <CloseOutline />
            </n-icon>
          </template>
        </n-button>
      </div>
    </div>

    <!-- 新建表单区：字段态自持，进入即空白（原 startCreate 显式重置的等价物） -->
    <RunbookCreateForm
      v-if="creating"
      @close="creating = false"
      @saved="onFormSaved"
    />

    <!-- 运行书列表区：打开/删除上抛，账目（doneSteps）与显隐在壳 -->
    <RunbookBookList
      v-else-if="!opened"
      :books="books"
      :loading="loading"
      @open="openBook"
      @delete="deleteBook"
    />

    <!-- 打开书区：步骤逐步发送 + 序贯运行（P-20261004-13）；:key 按书重挂，
         书内 transient（展开/填值）即弃，等价原 openBook 的显式重置 -->
    <RunbookBookView
      v-else
      :key="opened.id"
      :book="opened"
      :run-state="runState"
      :tabs="props.tabs"
      :done="doneSteps[opened.id] || []"
      @insert="(c) => emit('insert', c)"
      @run="(p) => emit('run', p)"
      @run-stop="emit('runStop')"
      @toggle-done="toggleDone"
      @reset-done="resetDone"
      @update-onfailure="updateOnFailure"
    />
  </aside>
</template>

<style scoped>
.runbook-panel {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 360px;
  max-width: 60%;
  z-index: 25;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-left: 1px solid var(--border-default);
  box-shadow: var(--shadow-pop-drawer);
}
.runbook-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.runbook-back {
  display: flex; align-items: center;
  border: none; background: none; color: var(--text-secondary);
  cursor: pointer; padding: 2px; flex-shrink: 0;
}
.runbook-title {
  flex: 1; min-width: 0;
  font-size: 13px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.runbook-header-actions { display: flex; gap: 2px; flex-shrink: 0; }
</style>
