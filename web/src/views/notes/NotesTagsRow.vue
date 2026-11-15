<script setup lang="ts">
// 笔记标签行（P-20261112-7 S2）：编辑区上方（np-tabs 与编辑器之间）的当前篇
// 标签编辑面——已有标签呈 chips（点 x 删除，chip title 提示全名），尾部「+」
// 内联输入（回车/失焦确认，Esc 取消；自动补全候选 = 全库既有标签去重集合，
// 排除本篇已有，contains 匹配截前 8 条防长下拉）。
//
// S3 起点击 chip 本体（x 之外）= 按该标签过滤侧栏清单（emit filter 给宿主转
// 引擎 setTagFilter——与侧栏徽记同链，与标题搜索 AND 叠加）。
//
// 零标签时仅显「+」轻量占位不占行高（容器零 padding 由内容撑高）。达单篇
// 上限（NOTE_TAGS_MAX=8）后 + 转禁用并提示上限。增删都 emit 给宿主（面板），
// 由面板调引擎 editTags 进防抖保存链——本组件纯呈现，不持保存态。
import { computed, nextTick, ref } from 'vue'
import { NAutoComplete, NIcon } from 'naive-ui'
import { CloseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { NOTE_TAGS_MAX } from '../../utils/noteTags'

const props = defineProps<{
  /** 当前篇编辑面标签（全量编辑面——增删后宿主回写） */
  tags: string[]
  /** 全库既有标签去重集合（自动补全候选全集） */
  allTags: string[]
}>()

const emit = defineEmits<{
  (e: 'add', tag: string): void
  (e: 'remove', tag: string): void
  (e: 'filter', tag: string): void
}>()

const { t } = useI18n()

// 内联输入态（点 + 展开，确认/取消回 +——轻量占位不常驻一条输入框）
const inputing = ref(false)
const draft = ref('')
const inputRef = ref<InstanceType<typeof NAutoComplete> | null>(null)

const atLimit = computed(() => props.tags.length >= NOTE_TAGS_MAX)

/** 补全候选：全库标签 - 本篇已有 - contains 输入匹配（大小写不敏感；截前
 *  NOTE_TAGS_MAX 条——全库标签量级 8×100 上界，无过滤防长下拉） */
const options = computed(() => {
  const q = draft.value.trim().toLowerCase()
  const own = new Set(props.tags)
  return props.allTags
    .filter(tag => !own.has(tag) && (q === '' || tag.toLowerCase().includes(q)))
    .slice(0, NOTE_TAGS_MAX)
    .map(tag => ({ label: tag, value: tag }))
})

async function openInput(): Promise<void> {
  inputing.value = true
  draft.value = ''
  await nextTick()
  inputRef.value?.focus()
}

/** 确认收口（三入口共用）：空串=取消，非空=emit add；确认后收回「+」（连续
 *  加签再点，保持标签行的轻量形态）。重复值由引擎 editTags 归一化去重短路，
 *  无须本组件预判 */
function commitNow(v: string): void {
  if (!inputing.value) return
  const tag = v.trim()
  inputing.value = false
  draft.value = ''
  if (tag !== '') emit('add', tag)
}

/** 回车/失焦确认：用输入框现值 */
function commit(): void {
  if (!inputing.value) return
  commitNow(draft.value)
}

/** 失焦确认延迟一拍：候选点选的事件序是 mousedown（input blur）→ mouseup →
 *  click（select），同步 commit 会把输入框半截值（如「alp」）抢先入列、候选
 *  完整值反而落空——延到任务队列尾让 select 先到（onPick 已关输入态，本回调
 *  空转），真实失焦（无 select）下一拍照常用现值确认 */
function onBlur(): void {
  setTimeout(commit, 0)
}

/** 候选点选：用候选完整值（优于输入框现值） */
function onPick(value: string): void {
  commitNow(value)
}

function cancel(): void {
  inputing.value = false
  draft.value = ''
}
</script>

<template>
  <div
    class="np-tags"
    :class="{ 'np-tags-empty': tags.length === 0 }"
    data-testid="notes-tags"
  >
    <span
      v-for="tag in tags"
      :key="tag"
      class="np-tag"
      data-testid="notes-tag"
      :title="tag"
      :aria-label="t('notes.panel.tagFilterAria', { tag })"
      @click="emit('filter', tag)"
    >
      <span class="np-tag-name">{{ tag }}</span>
      <NIcon
        class="np-tag-x"
        size="11"
        :component="CloseOutline"
        :aria-label="t('notes.panel.tagsRemove')"
        @click.stop="emit('remove', tag)"
      />
    </span>
    <NAutoComplete
      v-if="inputing"
      ref="inputRef"
      v-model:value="draft"
      class="np-tag-input"
      size="small"
      :options="options"
      :placeholder="t('notes.panel.tagsInputPlaceholder')"
      :clearable="false"
      data-testid="notes-tag-input"
      :get-show="() => true"
      @select="onPick"
      @keyup.enter="commit"
      @blur="onBlur"
      @keydown.esc.stop.prevent="cancel"
    />
    <button
      v-else
      class="np-tag-add"
      data-testid="notes-tag-add"
      :disabled="atLimit"
      :title="atLimit ? t('notes.panel.tagsLimit') : t('notes.panel.tagsAdd')"
      :aria-label="atLimit ? t('notes.panel.tagsLimit') : t('notes.panel.tagsAdd')"
      @click="openInput"
    >
      +
    </button>
  </div>
</template>

<style scoped>
/* 标签行：随内容撑高（零标签时只有一枚小「+」，不占整行行高） */
.np-tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  padding: 4px 18px 0;
  flex-shrink: 0;
  min-width: 0;
}
.np-tags-empty {
  padding: 3px 18px 0;
}
.np-tag {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 220px;
  padding: 1px 4px 1px 8px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-secondary);
  background: var(--bg-hover);
  border: 1px solid var(--border-default);
  border-radius: 9px;
  white-space: nowrap;
  /* S3：chip 本体可点（按该标签过滤侧栏清单），x 删除 @click.stop 分层不波及 */
  cursor: pointer;
}
.np-tag-name {
  overflow: hidden;
  text-overflow: ellipsis;
}
.np-tag-x {
  border-radius: 50%;
  opacity: 0.4;
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity var(--motion-fast) var(--ease-standard);
}
.np-tag-x:hover {
  opacity: 1;
}
.np-tag-add {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  font-size: 13px;
  line-height: 1;
  color: var(--text-secondary);
  background: transparent;
  border: 1px dashed var(--border-default);
  border-radius: 50%;
  cursor: pointer;
  transition:
    color var(--motion-fast) var(--ease-standard),
    border-color var(--motion-fast) var(--ease-standard),
    background-color var(--motion-fast) var(--ease-standard);
}
.np-tag-add:hover:not(:disabled) {
  color: var(--text-primary);
  border-color: var(--text-secondary);
  background: var(--bg-hover);
}
.np-tag-add:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
/* 内联输入与「+」同档（tiny 高度走 naive 主题默认），宽度收窄不挤 chips；
   颜色零硬编码走 CSS 变量（主题适配纪律），naive 组件外观不另做组件内覆盖 */
.np-tag-input {
  width: 140px;
}
</style>
