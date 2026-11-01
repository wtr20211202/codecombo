<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { NButton, NIcon, NInput } from 'naive-ui'
import { PaperPlaneOutline, TrashOutline, CreateOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { useAgentQueueStore } from '../../stores/agentQueue'
import { useDraftGuard } from '../../composables/useDraftGuard'
import { useProjectStore } from '../../stores/project'
import { useAtFileCompletion } from '../../composables/useAtFileCompletion'
import AtFileCompletionPopover from './AtFileCompletionPopover.vue'

/**
 * 会话行排队指令面板（P-20261003-248）：会话行内联展开的排队输入 + 列表管理。
 * 数据与写口全在 agentQueue store（服务端为事实源，自动发送由服务端完成回执
 * 驱动）；本组件只承载输入/编辑/删除/手动发送的界面层。
 * - 排队输入：Enter 入尾；服务端 idle 即发时以「已立即发送」反馈（sent 回告）
 * - 排队输入防丢草稿（P-20261005-229）：半成品指令防抖 1s 存 sessionStorage
 *   （sc.agentQueue.draft.<sessionId>，会话级生命周期：刷新存活/关标签页即清）；
 *   面板条件挂载（收起/切行即卸载）同险，卸载时 useDraftGuard 同步落键，重开/
 *   刷新静默回填（文本重现于输入框即「从上次继续」，不加提示条），入队成功即清
 * - 列表管理：队首在前；单条编辑（转内联输入）/ 删除（整表替换写口）
 * - 降级注记：autoSend=false（会话无进度上报数据）时提示手动发送，逐条出
 *   「立即发送」按钮（broadcast-write 直写 + 摘除）
 * - @ 文件引用补全（P-20261005-196）：排队指令输入敲 @ 弹项目文件补全浮层
 *   （与 NewSessionDialog 同一状态机 useAtFileCompletion）；清单按 props.projectId
 *   （项目分组树传入会话归属项目）取数，会话树调用方未传时回落当前项目
 */
const props = defineProps<{
  sessionId: string
  /** 会话归属项目 id（项目分组树传入；会话树的 agent 会话无归属，回落当前项目） */
  projectId?: string
}>()

const { t } = useI18n()
const queueStore = useAgentQueueStore()
const projectStore = useProjectStore()

const view = computed(() => queueStore.queues[props.sessionId])
const items = computed(() => view.value?.items ?? [])
const autoSend = computed(() => view.value?.autoSend ?? false)

const draft = ref('')
const queueing = ref(false)
const /** 编辑中的下标（-1 = 无）；编辑稿与新增稿共用 draft 语义分开持有 */
  editIndex = ref(-1)
const editDraft = ref('')

// 排队输入防丢草稿（P-20261005-229）：按会话 id 分键——键随 props 漂移由
// useDraftGuard 的 schedule 时刻锁键守卫承接（复用换绑不串键）
const QUEUE_DRAFT_KEY_PREFIX = 'sc.agentQueue.draft.'
const draftGuard = useDraftGuard({
  key: () => QUEUE_DRAFT_KEY_PREFIX + props.sessionId,
  read: () => draft.value,
})

// 挂载/切行回填该会话的半成品指令（刷新/收起面板不丢）；静默回填不加提示条
draft.value = draftGuard.restore()

watch(() => props.sessionId, () => {
  queueAtCompletion.close() // 换绑会话：旧触发点不得写入新会话草稿
  draft.value = draftGuard.restore()
  editIndex.value = -1
})

/** 用户键入排队指令：防抖落草稿（回填/入队清空等程序性写入不落键） */
function onDraftInput(): void {
  draftGuard.scheduleSave()
  queueAtCompletion.onInput() // @ 补全触发评估（P-20261005-196）
}

// ============== @ 文件引用补全（P-20261005-196） ==============
// 单行 n-input 的内部 input 元素提取（NewSessionDialog.promptTextareaEl 同款
// 双形态防御：实例 proxy 解包 vs 类型声明的 Ref 形态都认）
function queueInputEl(): HTMLInputElement | null {
  const raw = (queueInputRef.value as unknown as { inputElRef?: unknown } | null)?.inputElRef
  if (raw instanceof HTMLInputElement) return raw
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const el = (raw as { value?: unknown }).value
    if (el instanceof HTMLInputElement) return el
  }
  return null
}

const queueInputRef = ref<InstanceType<typeof NInput> | null>(null)

const queueAtCompletion = useAtFileCompletion({
  projectId: () => props.projectId || projectStore.currentProjectId,
  getText: () => draft.value,
  getCursor: () => queueInputEl()?.selectionStart ?? draft.value.length,
  applyText: (start, end, replacement) => {
    draft.value = draft.value.slice(0, start) + replacement + draft.value.slice(end)
    void nextTick(() => {
      const el = queueInputEl()
      if (el) el.selectionStart = el.selectionEnd = start + replacement.length
    })
  },
  getAnchorEl: () => queueInputEl(),
})

/** 浮层消费过的 Enter（keydown 选中补全）不再触发排队提交——提交挂 keyup，
 *  keydown 的 preventDefault 拦不住它，须按消费标记放行 */
function onEnterKeyup(): void {
  if (queueAtCompletion.consumeEnterKeyup()) return
  void submitDraft()
}

/** 排队入尾：满队/空文本由服务端校验回错（错误经拦截器 toast），这里只挡空回车 */
async function submitDraft(): Promise<void> {
  const text = draft.value.trim()
  if (!text || queueing.value) return
  queueing.value = true
  try {
    // sent=false 是「排队成功等回执」的正常路径（true = idle 即发），成功即清
    const sent = await queueStore.enqueue(props.sessionId, text)
    // 入队成功即清草稿（已提交无保留意义）：先清键撤在途防抖再清文本，
    // 防卸载 flush 把已提交文本复活成草稿
    draftGuard.clearDraft()
    draft.value = ''
    if (sent) flashSent()
    // 失败（服务端 409 满队/400 校验，拦截器已 toast）向上冒：输入框文本与
    // 草稿都保留可修正重试
  } finally {
    queueing.value = false
  }
}

/** 入队即发的瞬时反馈（3s 自灭——操作有反馈，不打断） */
const justSent = ref(false)
let justSentTimer: ReturnType<typeof setTimeout> | null = null
function flashSent(): void {
  justSent.value = true
  if (justSentTimer) clearTimeout(justSentTimer)
  justSentTimer = setTimeout(() => { justSent.value = false }, 3000)
}

function startEdit(index: number): void {
  editIndex.value = index
  editDraft.value = items.value[index]?.text ?? ''
}
async function confirmEdit(): Promise<void> {
  const idx = editIndex.value
  const text = editDraft.value.trim()
  editIndex.value = -1
  if (idx < 0 || !text || text === items.value[idx]?.text) return
  const next = items.value.map((it, i) => (i === idx ? text : it.text))
  await queueStore.updateItems(props.sessionId, next)
}
function removeAt(index: number): void {
  const next = items.value.filter((_, i) => i !== index).map(it => it.text)
  void queueStore.updateItems(props.sessionId, next)
}
/** 手动发送（降级路径/停摆兜底）：broadcast-write 直写 + 摘除，失败交拦截器提示 */
async function sendNow(index: number): Promise<void> {
  await queueStore.sendNow(props.sessionId, index)
}
</script>

<template>
  <div
    class="asq-panel"
    data-testid="session-queue-panel"
    @click.stop
    @dblclick.stop
  >
    <!-- 排队输入 -->
    <div class="asq-input-row">
      <n-input
        ref="queueInputRef"
        v-model:value="draft"
        size="tiny"
        :placeholder="t('agentTerminal.queue.placeholder')"
        :disabled="queueing"
        data-testid="queue-draft-input"
        @input="onDraftInput"
        @keyup.enter="onEnterKeyup"
        @keydown="queueAtCompletion.onKeydown"
        @focusout="queueAtCompletion.onFocusout"
        @compositionstart="queueAtCompletion.onCompositionStart"
        @compositionend="queueAtCompletion.onCompositionEnd"
      />
      <n-button
        size="tiny"
        quaternary
        :title="t('agentTerminal.queue.enqueue')"
        :disabled="!draft.trim() || queueing"
        data-testid="queue-enqueue"
        @click="submitDraft"
      >
        <n-icon size="12">
          <PaperPlaneOutline />
        </n-icon>
      </n-button>
    </div>
    <!-- @ 文件引用补全浮层（P-20261005-196）：fixed 定位，不随面板 overflow 裁剪 -->
    <AtFileCompletionPopover
      v-if="queueAtCompletion.open.value"
      :items="queueAtCompletion.items.value"
      :active-index="queueAtCompletion.activeIndex.value"
      :placement="queueAtCompletion.placement.value"
      @select="queueAtCompletion.select"
      @hover="queueAtCompletion.onHover"
    />
    <div
      v-if="justSent"
      class="asq-flash"
    >
      {{ t('agentTerminal.queue.sentNow') }}
    </div>

    <!-- 降级注记：会话无进度上报数据，完成不自动发送 -->
    <div
      v-if="items.length > 0 && !autoSend"
      class="asq-note"
      data-testid="queue-manual-note"
    >
      {{ t('agentTerminal.queue.manualNote') }}
    </div>

    <!-- 排队列表（队首在前） -->
    <div
      v-if="items.length === 0"
      class="asq-empty"
    >
      {{ t('agentTerminal.queue.empty') }}
    </div>
    <template v-else>
      <div
        v-for="(item, i) in items"
        :key="item.queuedAt + i"
        class="asq-item"
      >
        <n-input
          v-if="editIndex === i"
          v-model:value="editDraft"
          size="tiny"
          autofocus
          @keyup.enter="confirmEdit"
          @blur="confirmEdit"
        />
        <template v-else>
          <span
            class="asq-item-text"
            :title="item.text"
          >{{ item.text }}</span>
          <button
            class="asq-item-btn"
            :title="t('agentTerminal.queue.edit')"
            @click.stop="startEdit(i)"
          >
            <n-icon size="11" data-icon-action="common.edit">
              <CreateOutline />
            </n-icon>
          </button>
          <button
            class="asq-item-btn is-danger"
            :title="t('agentTerminal.queue.delete')"
            :data-testid="`queue-delete-${i}`"
            @click.stop="removeAt(i)"
          >
            <n-icon size="11" data-icon-action="common.delete">
              <TrashOutline />
            </n-icon>
          </button>
        </template>
        <!-- 手动发送（仅降级态渲染；自动态回执驱动，无需逐条按钮） -->
        <n-button
          v-if="!autoSend && editIndex !== i"
          size="tiny"
          quaternary
          :title="t('agentTerminal.queue.sendNow')"
          :data-testid="`queue-send-now-${i}`"
          @click.stop="sendNow(i)"
        >
          {{ t('agentTerminal.queue.sendNow') }}
        </n-button>
      </div>
      <div class="asq-count">
        {{ t('agentTerminal.queue.count', { n: items.length }) }}
      </div>
    </template>
  </div>
</template>

<style scoped>
.asq-panel {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 2px 0 4px 14px;
  padding: 6px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-secondary);
}
.asq-input-row { display: flex; align-items: center; gap: 4px; }
.asq-flash { font-size: 0.72em; color: var(--accent-green); }
.asq-note {
  font-size: 0.72em;
  color: var(--accent-yellow);
  line-height: 1.4;
}
.asq-empty { font-size: 0.72em; color: var(--text-dim); }
.asq-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-body);
}
.asq-item-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: default;
}
.asq-item-btn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  border: none;
  background: none;
  color: var(--text-dim);
  cursor: pointer;
  padding: 0 2px;
  border-radius: 3px;
}
.asq-item-btn:hover { color: var(--text-primary); background: var(--bg-hover); }
.asq-item-btn.is-danger:hover { color: var(--accent-red); }
.asq-count { font-size: 0.7em; color: var(--text-dim); text-align: right; }
</style>
