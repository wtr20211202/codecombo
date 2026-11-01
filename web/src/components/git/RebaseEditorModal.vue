<script setup lang="ts">
/**
 * 交互式 rebase 编辑器（P-20261003-324 提交整理）：区间提交列表行内切换
 * 动作（pick/squash/reword/drop）、按钮上下移重排（MVP 免拖拽库）、reword
 * 行内编辑消息，实时预览结果序列。执行走 POST /rebase/interactive——区间含
 * 已推送提交时服务端 409 拒绝，此处展示影响面（远程分支 + force-with-lease
 * 提示）确认后重试（reword 先例两段式）；失败（冲突）服务端已 abort 回原状。
 * 逻辑在 useRebaseEditor（可单测），本组件承载 UI 与确认流。
 */
import { computed, watch } from 'vue'
import { NButton, NIcon, NInput, NSelect, NSpin, useMessage } from 'naive-ui'
import { ArrowUpOutline, ArrowDownOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { confirmDialog } from '../../composables/useDialog'
import { useProjectStore } from '../../stores/project'
import { OPS_FILES_EXTERNAL_CHANGE } from '../../utils/opsEvents'
import {
  executeRebasePlan,
  rebaseEditorValidationError,
  REBASE_EDITOR_MAX_STEPS,
  useRebaseEditor,
  type RebaseStepAction,
} from '../../composables/useRebaseEditor'

const emit = defineEmits<{
  /** 执行成功（历史已改写）：宿主刷新提交/分支列表 */
  (e: 'rebased'): void
}>()

const { t } = useI18n()
const message = useMessage()
const projectStore = useProjectStore()

const editor = useRebaseEditor()
const { show, loading, executing, onto, steps, preview } = editor

const actionOptions = (['pick', 'squash', 'reword', 'drop'] as RebaseStepAction[]).map(a => ({
  label: t(`rebase.editor.action.${a}`),
  value: a,
}))

/** 区间超出上限：只读展示并禁执行（服务端同值拒绝，提前到打开时反馈） */
const overLimit = computed(() => steps.value.length > REBASE_EDITOR_MAX_STEPS)
const validationError = computed(() =>
  overLimit.value ? 'rebase.editor.errorOverLimit' : rebaseEditorValidationError(steps.value))
const canExecute = computed(() =>
  show.value && !loading.value && !executing.value && !validationError.value && steps.value.length > 0)

async function open(commit: string) {
  const pid = projectStore.currentProjectId
  if (!pid) return
  await editor.open(pid, commit)
}
defineExpose({ open })

// 项目切换即弃稿：区间/基准是旧项目的提交，执行会被服务端按越界拒绝——
// 直接收起让用户在新项目重新选取
watch(() => projectStore.currentProjectId, () => {
  if (show.value) editor.close()
})

function close() {
  if (executing.value) return
  editor.close()
}

/** 执行 → 409（含已推送）确认影响面后携 confirmPushed 重试；失败服务端已 abort */
async function handleExecute() {
  const pid = projectStore.currentProjectId
  if (!pid || !canExecute.value) return
  executing.value = true
  try {
    const first = await executeRebasePlan(pid, onto.value, steps.value, false)
    if (first.ok) {
      succeed()
      return
    }
    if (!first.pushed) {
      message.error(first.userMessage || t('rebase.editor.executeFailed'))
      return
    }
    const branches = (first.remoteBranches || []).join('、')
    const confirmed = await confirmDialog({
      type: 'warning',
      title: t('rebase.editor.pushedTitle'),
      content: t('rebase.editor.pushedWarning', { branches }),
      confirmText: t('rebase.editor.pushedConfirm'),
      cancelText: t('common.cancel'),
    })
    if (!confirmed) return
    const retry = await executeRebasePlan(pid, onto.value, steps.value, true)
    if (retry.ok) {
      succeed()
    } else {
      message.error(retry.userMessage || t('rebase.editor.executeFailed'))
    }
  } finally {
    executing.value = false
  }
}

function succeed() {
  message.success(t('rebase.editor.success'))
  // 工作区文件被 rebase 重写：广播外部变更让打开中的编辑器标签重读
  window.dispatchEvent(new CustomEvent(OPS_FILES_EXTERNAL_CHANGE))
  emit('rebased')
  editor.close()
}
</script>

<template>
  <div
    v-show="show"
    class="modal-overlay"
    data-testid="rebase-editor-modal"
    @click.self="close"
  >
    <div class="rebase-card">
      <div class="rebase-title">
        {{ t('rebase.editor.title') }}
        <span
          class="rebase-range"
          data-testid="rebase-range-hint"
        >{{ onto ? t('rebase.editor.rangeHint', { count: steps.length }) : t('rebase.editor.rootRange', { count: steps.length }) }}</span>
      </div>

      <NSpin
        :show="loading"
        size="small"
      >
        <div class="rebase-body">
          <div
            v-if="steps.length === 0 && !loading"
            class="rebase-empty"
          >
            {{ t('rebase.editor.loadFailed') }}
          </div>

          <template v-else>
            <!-- 计划行：动作下拉 + hash + 消息（reword 行内编辑）+ 上下移。
                 testid 以消息锚定（重排后索引漂移，消息即稳定坐标） -->
            <div class="rebase-steps">
              <div
                v-for="(s, i) in steps"
                :key="s.hash"
                class="rebase-row"
                :class="{ dropped: s.action === 'drop' }"
                :data-testid="`rebase-row-${s.msg}`"
              >
                <n-select
                  :value="s.action"
                  :options="actionOptions"
                  size="tiny"
                  class="rebase-action"
                  @update:value="(v: RebaseStepAction) => editor.setAction(i, v)"
                />
                <span class="rebase-hash">{{ s.hash.substring(0, 7) }}</span>
                <n-input
                  v-if="s.action === 'reword'"
                  :value="s.newMessage"
                  size="tiny"
                  class="rebase-msg-input"
                  :placeholder="t('rebase.editor.rewordPlaceholder')"
                  @update:value="(v: string) => { s.newMessage = v }"
                />
                <span
                  v-else
                  class="rebase-msg"
                  :title="s.msg"
                >{{ s.msg }}</span>
                <span
                  v-if="s.action === 'squash'"
                  class="rebase-squash-tag"
                >{{ t('rebase.editor.squashIntoPrev') }}</span>
                <span class="rebase-move">
                  <n-button
                    size="tiny"
                    quaternary
                    :title="t('rebase.editor.moveUp')"
                    :aria-label="t('rebase.editor.moveUp')"
                    :disabled="i === 0"
                    class="rebase-move-up"
                    @click="editor.move(i, -1)"
                  >
                    <n-icon size="12"><ArrowUpOutline /></n-icon>
                  </n-button>
                  <n-button
                    size="tiny"
                    quaternary
                    :title="t('rebase.editor.moveDown')"
                    :aria-label="t('rebase.editor.moveDown')"
                    :disabled="i === steps.length - 1"
                    class="rebase-move-down"
                    @click="editor.move(i, 1)"
                  >
                    <n-icon size="12"><ArrowDownOutline /></n-icon>
                  </n-button>
                </span>
              </div>
            </div>

            <!-- 实时预览：结果序列 + 被丢弃 -->
            <div
              v-if="preview.rows.length || preview.dropped.length"
              class="rebase-preview"
              data-testid="rebase-preview"
            >
              <div class="rebase-preview-title">
                {{ t('rebase.editor.preview') }}
              </div>
              <div
                v-for="row in preview.rows"
                :key="row.hash"
                class="rebase-preview-row"
              >
                <span class="rebase-preview-msg">{{ row.subject }}</span>
                <span
                  v-for="sq in row.squashed"
                  :key="sq"
                  class="rebase-preview-squashed"
                >{{ t('rebase.editor.squashedInto', { msg: sq }) }}</span>
              </div>
              <div
                v-for="d in preview.dropped"
                :key="d"
                class="rebase-preview-dropped"
              >
                {{ t('rebase.editor.droppedItem', { msg: d }) }}
              </div>
            </div>

            <div
              v-if="validationError"
              class="rebase-error"
              data-testid="rebase-validation-error"
            >
              {{ t(validationError, { max: REBASE_EDITOR_MAX_STEPS }) }}
            </div>
            <div
              v-else
              class="rebase-hint"
            >
              {{ t('rebase.editor.hint') }}
            </div>
          </template>
        </div>
      </NSpin>

      <div class="rebase-footer">
        <n-button
          size="small"
          :disabled="executing"
          @click="close"
        >
          {{ t('common.cancel') }}
        </n-button>
        <n-button
          size="small"
          type="warning"
          :disabled="!canExecute"
          :loading="executing"
          data-testid="rebase-execute"
          @click="handleExecute"
        >
          {{ t('rebase.editor.execute') }}
        </n-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed; inset: 0; z-index: 2000;
  background: var(--overlay-mask);
  display: flex; align-items: center; justify-content: center;
}
.rebase-card {
  width: 620px; max-width: 92vw; max-height: 82vh;
  background: var(--bg-panel); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-pop-lg);
  display: flex; flex-direction: column;
}
.rebase-title {
  padding: var(--space-3) var(--space-4); font-size: 0.95em; font-weight: var(--fw-medium); color: var(--text-primary);
  border-bottom: 1px solid var(--border-default);
  display: flex; align-items: baseline; gap: var(--space-2);
}
.rebase-range { font-size: 0.8em; font-weight: var(--fw-regular); color: var(--text-muted); }
.rebase-body { padding: var(--space-3) var(--space-4); overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.rebase-empty { color: var(--text-muted); font-size: 0.85em; padding: var(--space-4) 0; text-align: center; }
.rebase-steps { display: flex; flex-direction: column; gap: var(--space-1); }
.rebase-row {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-1) 6px; border-radius: var(--radius-sm);
}
.rebase-row.dropped .rebase-msg, .rebase-row.dropped .rebase-hash { text-decoration: line-through; color: var(--text-muted); }
.rebase-row.dropped { background: var(--bg-hover); }
.rebase-action { width: 96px; flex-shrink: 0; }
.rebase-hash { font-family: monospace; font-size: 0.78em; color: var(--text-muted); flex-shrink: 0; }
.rebase-msg { font-size: 0.85em; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.rebase-msg-input { flex: 1; }
.rebase-squash-tag { font-size: 0.72em; color: var(--accent-orange); flex-shrink: 0; }
.rebase-move { display: flex; gap: 2px; flex-shrink: 0; }
.rebase-preview { border-top: 1px dashed var(--border-subtle); padding-top: var(--space-2); }
.rebase-preview-title { font-size: 0.78em; color: var(--text-muted); margin-bottom: var(--space-1); }
.rebase-preview-row { display: flex; flex-direction: column; padding-left: 6px; }
.rebase-preview-msg { font-size: 0.82em; color: var(--accent-green); }
.rebase-preview-squashed { font-size: 0.78em; color: var(--accent-orange); padding-left: var(--space-3); }
.rebase-preview-dropped { font-size: 0.78em; color: var(--text-muted); text-decoration: line-through; padding-left: 6px; }
.rebase-error { font-size: 0.82em; color: var(--accent-red); }
.rebase-hint { font-size: 0.78em; color: var(--text-muted); }
.rebase-footer {
  padding: 10px var(--space-4); display: flex; justify-content: flex-end; gap: var(--space-2);
  border-top: 1px solid var(--border-default);
}
</style>
