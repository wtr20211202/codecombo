<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NButton, NInput } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import type { ConflictHunk } from '../../api/domains/git'

/**
 * 逐块冲突解决列表（P-20261003-59）：每个冲突块独立三选——取我方 / 取他方 /
 * 手动编辑（解决态打勾），全部解决后由父组件合成写回（emit apply 携带合成内容）。
 * 选择态只在组件内暂存，写回仍走既有 resolve-content 保存链（审计/广播同路）。
 */
const props = defineProps<{
  hunks: ConflictHunk[]
  /** 工作区原始内容（含冲突标记），是合成写回的底稿——块行号对齐它 */
  rawContent: string
  /** 父组件写回请求进行中（按钮 loading，防重复提交） */
  resolving: boolean
}>()

const emit = defineEmits<{
  (e: 'apply', content: string): void
}>()

const { t } = useI18n()

type HunkChoice = 'ours' | 'theirs' | 'manual'
const choices = ref<Array<{ choice: HunkChoice | null; manual: string }>>([])

// diff3/zdiff3 基线段（P-20261004-28）的展开态，与 hunks 一一对应。基线是参考
// 信息不是候选答案——默认折叠弱化展示，展开是主动查看；hunks 替换时随选择态一并重置
const baseExpanded = ref<boolean[]>([])

// hunks 数组引用随换文件/刷新整体替换——解决态一并重置（块内容已变，旧选择失效）
watch(() => props.hunks, () => {
  choices.value = props.hunks.map(() => ({ choice: null, manual: '' }))
  baseExpanded.value = props.hunks.map(() => false)
}, { immediate: true })

function toggleBase(index: number) {
  baseExpanded.value[index] = !baseExpanded.value[index]
}

const resolvedCount = computed(() => choices.value.filter((c) => c.choice !== null).length)
const allResolved = computed(() => props.hunks.length > 0 && resolvedCount.value === props.hunks.length)

// 再点已选中的键取消选择回到待解决（误触可恢复）；手动编辑首切预填我方内容——
// 通常以一侧为底微调，比空白稿少一遍抄写
function pick(index: number, choice: HunkChoice) {
  const st = choices.value[index]
  if (!st) return
  if (choice === 'manual' && st.manual === '') {
    st.manual = props.hunks[index]?.ours ?? ''
  }
  st.choice = st.choice === choice ? null : choice
}

function onManualInput(index: number, value: string) {
  const st = choices.value[index]
  if (!st) return
  st.manual = value
  st.choice = 'manual'
}

// 合成写回内容：按块行区间从后往前替换（倒序使前面的区间下标不受 splice 影响），
// 区间 [startLine, endLine] 含两端标记行整体剔除，替换为所选侧正文
function synthesized(): string {
  const lines = props.rawContent.split('\n')
  for (let i = props.hunks.length - 1; i >= 0; i--) {
    const h = props.hunks[i]
    const st = choices.value[i]
    if (!h || !st?.choice) continue
    const rep = st.choice === 'ours' ? h.ours : st.choice === 'theirs' ? h.theirs : st.manual
    const repLines = rep.length ? rep.split('\n') : []
    lines.splice(h.startLine - 1, h.endLine - h.startLine + 1, ...repLines)
  }
  return lines.join('\n')
}

function apply() {
  if (!allResolved.value || props.resolving) return
  emit('apply', synthesized())
}
</script>

<template>
  <div style="flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 10px">
    <div style="display: flex; align-items: center; gap: 8px">
      <span style="font-size: 12px; color: var(--text-dim)">
        {{ t('git.conflict.hunk.progress', { done: resolvedCount, total: hunks.length }) }}
      </span>
      <div style="flex: 1" />
      <n-button
        data-test="conflict-hunk-apply"
        size="tiny"
        type="primary"
        :disabled="!allResolved"
        :loading="resolving"
        @click="apply"
      >
        {{ t('git.conflict.hunk.apply') }}
      </n-button>
    </div>

    <div
      v-for="(h, i) in hunks"
      :key="i"
      data-test="conflict-hunk-block"
      style="border: 1px solid var(--border-default); border-radius: 4px; overflow: hidden; flex-shrink: 0"
    >
      <div style="display: flex; align-items: center; gap: 8px; padding: 4px 10px; background: var(--bg-panel); border-bottom: 1px solid var(--border-default)">
        <span style="font-size: 12px; color: var(--text-body); font-weight: 500">{{ t('git.conflict.hunk.block', { n: i + 1 }) }}</span>
        <span style="font-size: 11px; color: var(--text-dim)">{{ t('git.conflict.hunk.lines', { start: h.startLine, end: h.endLine }) }}</span>
        <div style="flex: 1" />
        <span
          v-if="choices[i]?.choice"
          data-test="conflict-hunk-resolved"
          style="font-size: 11px; color: var(--accent-green)"
        >✓ {{ t('git.conflict.hunk.resolved') }}</span>
      </div>

      <!-- diff3/zdiff3 基线段（P-20261004-28）：默认折叠弱化展示，可展开查看 -->
      <div
        v-if="h.base"
        data-test="conflict-hunk-base"
        style="padding: 6px 10px 0"
      >
        <button
          data-test="conflict-hunk-base-toggle"
          :aria-expanded="baseExpanded[i] ? 'true' : 'false'"
          style="background: none; border: none; padding: 0; font-size: 11px; color: var(--text-dim); cursor: pointer; display: inline-flex; align-items: center; gap: 4px"
          @click="toggleBase(i)"
        >{{ baseExpanded[i] ? '▾' : '▸' }} {{ t('git.conflict.hunk.base') }}</button>
        <pre
          v-show="baseExpanded[i]"
          data-test="conflict-hunk-base-text"
          style="margin: 4px 0 0; padding: 6px 8px; font-family: var(--font-mono); font-size: 11px; white-space: pre-wrap; word-break: break-all; max-height: 100px; overflow-y: auto; border: 1px dashed var(--border-subtle); border-radius: 3px; color: var(--text-dim); background: var(--bg-primary)"
        >{{ h.base }}</pre>
      </div>

      <div style="display: flex; gap: 8px; padding: 8px 10px 4px">
        <pre
          style="flex: 1; margin: 0; padding: 6px 8px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto; border: 1px solid var(--border-subtle); border-radius: 3px; color: var(--accent-blue-light); background: var(--bg-primary)"
          :style="choices[i]?.choice === 'ours' ? { borderColor: 'var(--accent-blue-light)' } : {}"
        >{{ h.ours || t('git.conflict.hunk.emptySide') }}</pre>
        <pre
          style="flex: 1; margin: 0; padding: 6px 8px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; word-break: break-all; max-height: 120px; overflow-y: auto; border: 1px solid var(--border-subtle); border-radius: 3px; color: var(--accent-purple); background: var(--bg-primary)"
          :style="choices[i]?.choice === 'theirs' ? { borderColor: 'var(--accent-purple)' } : {}"
        >{{ h.theirs || t('git.conflict.hunk.emptySide') }}</pre>
      </div>

      <div style="display: flex; gap: 6px; padding: 4px 10px 8px; align-items: flex-start">
        <n-button
          data-test="conflict-hunk-ours"
          size="tiny"
          :type="choices[i]?.choice === 'ours' ? 'primary' : 'default'"
          @click="pick(i, 'ours')"
        >
          {{ t('git.conflict.hunk.takeOurs') }}
        </n-button>
        <n-button
          data-test="conflict-hunk-theirs"
          size="tiny"
          :type="choices[i]?.choice === 'theirs' ? 'primary' : 'default'"
          @click="pick(i, 'theirs')"
        >
          {{ t('git.conflict.hunk.takeTheirs') }}
        </n-button>
        <n-button
          data-test="conflict-hunk-manual"
          size="tiny"
          :type="choices[i]?.choice === 'manual' ? 'primary' : 'default'"
          @click="pick(i, 'manual')"
        >
          {{ t('git.conflict.hunk.manual') }}
        </n-button>
      </div>

      <div
        v-if="choices[i]?.choice === 'manual'"
        style="padding: 0 10px 8px"
      >
        <n-input
          :value="choices[i]!.manual"
          type="textarea"
          data-test="conflict-hunk-manual-input"
          :placeholder="t('git.conflict.hunk.manualPlaceholder')"
          :autosize="{ minRows: 2, maxRows: 8 }"
          @update:value="(v: string) => onManualInput(i, v)"
        />
      </div>
    </div>
  </div>
</template>
