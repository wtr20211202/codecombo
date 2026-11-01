<script setup lang="ts">
import { nextTick, ref } from 'vue'
import { NCollapse, NCollapseItem, NCheckbox, NFormItem, NInput, NSelect } from 'naive-ui'
import { useI18n } from '@/composables/useI18n'
import AtFileCompletionPopover from './AtFileCompletionPopover.vue'
import { useAtFileCompletion } from '@/composables/useAtFileCompletion'
import { useProjectStore } from '@/stores/project'
import type { SessionContextOption } from '@/utils/sessionContextSummary'

/**
 * 新建会话对话框的任务指令表单区（自 NewSessionDialog 按表单区拆分，纯搬运
 * 零逻辑改动）：任务模板下拉 + 任务指令 textarea + @ 文件引用补全（P-20261005-
 * 196）+ 占位符未解提示 + {selection} 无选区专属提示 + 字节计数 + 「本次上下文」
 * 折叠勾选区（P-176 git 勾选 → P-20261006-47 配置面）+ 上下文被弃提示 + 管理入口
 * 提示。模板联动/草稿持久化/上下文取数与组装在 useNewSessionPromptState（对话框
 * 域 composable），本组件只承载该表单区的呈现与输入上抛；@ 补全的浮层状态机
 * （useAtFileCompletion）就近 textarea 在场（触发/过滤/插入只依赖本区 DOM 与
 * v-model 指令文本），清单归属当前项目。
 */
const props = defineProps<{
  /** 选中模板 id（v-model:template-id，状态在 useNewSessionPromptState） */
  templateId: string
  /** 任务指令（v-model:prompt） */
  prompt: string
  /** 模板选项（无 + 管理面模板清单） */
  templateOptions: { label: string; value: string }[]
  /** 指令里仍以字面保留的已知占位符（上下文缺失），UI 提示「原样保留」 */
  unresolvedPlaceholders: string[]
  /** 占位符名单文案（script 侧拼装，见 useNewSessionPromptState 注记） */
  unresolvedLabel: string
  /** {selection} 未解（选区为空）：追加「无选区」专属提示（P-20261005-149） */
  selectionUnresolved: boolean
  promptBytes: number
  promptOverLimit: boolean
  /** 各上下文选项的按次覆选态（写者唯一 onCtxToggle，单向流） */
  ctxSelected: Record<SessionContextOption, boolean>
  /** 折叠「本次上下文」区展开态（v-model:context-expanded，状态在 composable） */
  contextExpanded: string[]
  /** 会话目录在当前项目语义内（worktree 等项目外目录不提供上下文勾选区） */
  contextScopeOk: boolean
  /** 指令 + 上下文超 500 字节被弃的选项（就地提示列被弃项） */
  contextDropped: string[]
  /** 被弃项本地化名单文案 */
  contextDroppedNames: string
}>()

const emit = defineEmits<{
  (e: 'update:templateId', v: string): void
  (e: 'update:prompt', v: string): void
  (e: 'templateChange'): void
  (e: 'promptInput'): void
  (e: 'update:contextExpanded', v: string[]): void
  (e: 'ctxToggle', option: SessionContextOption, checked: boolean): void
}>()

const { t } = useI18n()
const projectStore = useProjectStore()

// naive 载荷经 script 函数承接（模板内联箭头不写 TS 注解——模板表达式按 JS
// 编译，注解即编译错）
function onSelectTemplate(v: string) {
  emit('update:templateId', v)
  emit('templateChange')
}

function onPromptUpdate(v: string) {
  emit('update:prompt', v)
}

function onContextExpanded(v: string[]) {
  emit('update:contextExpanded', v)
}

function onCtxToggle(option: SessionContextOption, checked: boolean) {
  emit('ctxToggle', option, checked)
}

// ============== 打开聚焦（P-20261004-92 键盘流第一步，拆分适配） ==============
// 主输入裁决在壳（表单主次注记见彼处）；textarea 在场判定与壳的
// templateId||prompt 条件同镜像，本区经 expose 把 NInput 实例上提，壳的 show
// watch 打开 tick 聚焦（nameInputRef 在壳模板内，无需中转）
const promptInputRef = ref<InstanceType<typeof NInput> | null>(null)

defineExpose({ promptInputRef })

// ============== @ 文件引用补全（P-20261005-196） ==============
// 任务指令 textarea 敲 @ 弹项目文件补全浮层：清单取当前项目（会话 dir 可能是
// 项目外 worktree，此时补全仍给当前项目相对路径——提案边界「agent 会话在本地
// 项目域」，插入的是明确路径文本，引用基准由用户保证）；触发/过滤/插入状态机
// 全在 useAtFileCompletion，此处只供文本/光标/元素三个访问器。
// textareaElRef 提取做双形态防御：naive 实例 proxy 上 setup 返回的 ref 已解包
// （运行时是元素），类型声明却保留 Ref 形态——两种形态都认，错则空安全回落
function promptTextareaEl(): HTMLTextAreaElement | null {
  const raw = (promptInputRef.value as unknown as { textareaElRef?: unknown } | null)?.textareaElRef
  if (raw instanceof HTMLTextAreaElement) return raw
  if (raw && typeof raw === 'object' && 'value' in raw) {
    const el = (raw as { value?: unknown }).value
    if (el instanceof HTMLTextAreaElement) return el
  }
  return null
}

const atCompletion = useAtFileCompletion({
  projectId: () => projectStore.currentProjectId,
  // 文本经 DOM 元素直读（fallback props.prompt）：@update:value 经 emit→壳
  // v-model→props 回传要等重渲染，@input 同步段里 props 还是上一帧值，DOM
  // value 才是当帧真值（光标 selectionStart 同源同元素，切片口径一致）
  getText: () => promptTextareaEl()?.value ?? props.prompt,
  getCursor: () => promptTextareaEl()?.selectionStart ?? props.prompt.length,
  applyText: (start, end, replacement) => {
    // props.prompt 在本事件 tick 已是新值（点选/Enter 前渲染早已落定），按
    // v-model 通道回写
    emit('update:prompt', props.prompt.slice(0, start) + replacement + props.prompt.slice(end))
    // v-model 回写后再落光标（下一帧 DOM 才带上新值）；选中后键盘流直接续打
    void nextTick(() => {
      const el = promptTextareaEl()
      if (el) el.selectionStart = el.selectionEnd = start + replacement.length
    })
  },
  getAnchorEl: () => promptTextareaEl(),
})

/** 指令输入：草稿联动在壳（promptState.onPromptInput），@ 补全触发评估就近本区 */
function onPromptInput() {
  emit('promptInput')
  atCompletion.onInput()
}
</script>

<template>
  <n-form-item :label="t('agentTerminal.taskTemplate.fieldTemplate')">
    <n-select
      :value="templateId"
      :options="templateOptions"
      data-testid="agent-template-select"
      @update:value="onSelectTemplate"
    />
  </n-form-item>
  <n-form-item
    v-if="templateId || prompt"
    :label="t('agentTerminal.taskTemplate.fieldPrompt')"
  >
    <div class="nsd-prompt">
      <n-input
        ref="promptInputRef"
        :value="prompt"
        type="textarea"
        :rows="3"
        :placeholder="t('agentTerminal.taskTemplate.promptPlaceholder')"
        data-testid="agent-template-prompt"
        @update:value="onPromptUpdate"
        @input="onPromptInput"
        @keydown="atCompletion.onKeydown"
        @focusout="atCompletion.onFocusout"
        @compositionstart="atCompletion.onCompositionStart"
        @compositionend="atCompletion.onCompositionEnd"
      />
      <!-- @ 文件引用补全浮层（P-20261005-196）：fixed 定位挂在指令区下， -->
      <!-- 仅 atCompletion.open 在场时渲染 -->
      <AtFileCompletionPopover
        v-if="atCompletion.open.value"
        :items="atCompletion.items.value"
        :active-index="atCompletion.activeIndex.value"
        :placement="atCompletion.placement.value"
        @select="atCompletion.select"
        @hover="atCompletion.onHover"
      />
      <div
        v-if="unresolvedPlaceholders.length > 0"
        class="nsd-prompt-hint"
      >
        {{ t('agentTerminal.taskTemplate.unresolvedHint', { names: unresolvedLabel }) }}
      </div>
      <!-- {selection} 无选区专属提示（P-20261005-149）：缺失原因区分（选区
           为空非上下文不可得）+ 出路指引（选中后重开即可带入） -->
      <div
        v-if="selectionUnresolved"
        class="nsd-prompt-hint"
        data-testid="agent-template-selection-hint"
      >
        {{ t('agentTerminal.taskTemplate.selectionEmptyHint') }}
      </div>
      <div
        v-if="prompt"
        class="nsd-prompt-count"
        :class="{ over: promptOverLimit }"
      >
        {{ promptBytes }}/500
      </div>
      <!-- 本次上下文（P-176 git 勾选 → P-20261006-47 配置面，P-20261007-14 增环境
      画像）：仅任务指令非空且会话目录在当前项目语义内时出现（worktree 等项目外
      目录主树上下文是错误归属不提供；无指令不注入——背景资料是任务指令的增补，
      单独注入等于给运行时一句悬空陈述）。默认取设置、单次可调不改设置持久值 -->
      <n-collapse
        v-if="prompt && contextScopeOk"
        :expanded-names="contextExpanded"
        class="nsd-advanced"
        data-testid="agent-context-section"
        @update:expanded-names="onContextExpanded"
      >
        <n-collapse-item
          :title="t('agentTerminal.sessionContext.field')"
          name="ctx"
        >
          <div class="nsd-context-options">
            <n-checkbox
              :checked="ctxSelected.git"
              data-testid="agent-attach-git-status"
              @update:checked="v => onCtxToggle('git', v)"
            >
              {{ t('agentTerminal.gitSummary.attach') }}
            </n-checkbox>
            <n-checkbox
              :checked="ctxSelected.notes"
              data-testid="agent-attach-notes"
              @update:checked="v => onCtxToggle('notes', v)"
            >
              {{ t('agentTerminal.sessionContext.attachNotes') }}
            </n-checkbox>
            <n-checkbox
              :checked="ctxSelected.todos"
              data-testid="agent-attach-todos"
              @update:checked="v => onCtxToggle('todos', v)"
            >
              {{ t('agentTerminal.sessionContext.attachTodos') }}
            </n-checkbox>
            <n-checkbox
              :checked="ctxSelected.env"
              data-testid="agent-attach-env-profile"
              @update:checked="v => onCtxToggle('env', v)"
            >
              {{ t('agentTerminal.sessionContext.attachEnv') }}
            </n-checkbox>
          </div>
          <div class="nsd-prompt-hint">
            {{ t('agentTerminal.sessionContext.hint') }}
          </div>
        </n-collapse-item>
      </n-collapse>
      <div
        v-if="contextDropped.length > 0"
        class="nsd-prompt-hint"
        data-testid="agent-git-summary-dropped"
      >
        {{ t('agentTerminal.sessionContext.dropped', { names: contextDroppedNames }) }}
      </div>
      <div class="nsd-prompt-manage">
        {{ t('agentTerminal.taskTemplate.manageHint') }}
      </div>
    </div>
  </n-form-item>
</template>

<style scoped>
.nsd-prompt {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
}
.nsd-prompt-hint {
  font-size: 11px;
  color: var(--accent-yellow);
}
.nsd-prompt-count {
  align-self: flex-end;
  font-size: 11px;
  color: var(--text-secondary);
}
.nsd-prompt-count.over {
  color: var(--accent-red);
}
.nsd-context-options {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
}
.nsd-prompt-manage {
  font-size: 11px;
  color: var(--text-secondary);
}
/* 与对话框其余区块共用的 .nsd-advanced（跨组件 scoped 边界各自带同值规则，
   改动需与 NewSessionDialog / NewSessionAdvancedSections 同步） */
.nsd-advanced {
  margin-bottom: 12px;
}
</style>
