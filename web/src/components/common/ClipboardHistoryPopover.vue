<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NModal, NEmpty } from 'naive-ui'
import { useI18n } from '../../composables/useI18n'
import { useClipboardHistoryStore, type ClipboardHistoryEntry } from '../../stores/clipboardHistory'
import { maskApprovalSecrets } from '../../utils/sensitiveMask'

/**
 * 多剪贴板粘贴选择弹层（P-20261002-149，JetBrains paste from history 同 UI 形态）：
 * 环形历史列表（MRU 在前）+ 条目内联预览（首行作标题、后续行折叠预览），点选经
 * pick 事件上抛——写回系统剪贴板与光标插入在宿主（useLayoutShell）闭环，
 * 本组件只管选条目。
 *
 * 敏感项遮蔽（P-20261005-14，遮蔽家族第三面）：剪贴板常含密码/token（store 头注
 * 自认「仅内存不落盘」设防），值班共屏/肩窥下弹层裸显即泄露——命中 sensitiveMask
 * 模式集的条目显示面默认打码 + 弱边框提示，逐条「显示」钮揭示（会话级不持久，
 * 弹层重开回打码）；遮蔽只挡眼睛不挡数据流——入史不拦（拦了破坏「顺序抓录」
 * 主用途），pick 恒上抛原文（Ctrl+Alt+V 取用语义不变）。
 */
const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  (e: 'pick', text: string): void
}>()

const { t } = useI18n()
const store = useClipboardHistoryStore()

// 列表行标题（首行；长行截断防撑宽）与预览（其余行合并，至多 3 行）
const TITLE_MAX = 120
const PREVIEW_LINES = 3

function firstLineOf(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX)}…` : line
}

function previewOf(text: string): string {
  const rest = text.split('\n').slice(1).join('\n').trimEnd()
  if (!rest) return ''
  const lines = rest.split('\n')
  const head = lines.slice(0, PREVIEW_LINES).join('\n')
  return lines.length > PREVIEW_LINES ? `${head}\n…` : head
}

// ============== 敏感项遮蔽（P-20261005-14） ==============

// 打码判定与打码文按条目对象弱引用缓存：条目一经入史 text 不可变（store record
// 只新建或挪位），WeakMap 键随条目跌出环形一起回收——长会话反复复制不积累无界
// 内存。量级考量：每条至多一次 maskApprovalSecrets（5 趟正则 × ≤100KB 上限），
// 揭示翻牌/重开弹层/条目挪位全部零重算
const maskCache = new WeakMap<ClipboardHistoryEntry, { sensitive: boolean, masked: string }>()

function maskOf(e: ClipboardHistoryEntry): { sensitive: boolean, masked: string } {
  let hit = maskCache.get(e)
  if (!hit) {
    const masked = maskApprovalSecrets(e.text)
    hit = { sensitive: masked !== e.text, masked }
    maskCache.set(e, hit)
  }
  return hit
}

// 揭示态按条目 id 记账（会话级组件内态，不持久），弹层每次打开整体重置——
// 重开回打码是提案明确的会话边界
const revealedIds = ref(new Set<number>())
watch(show, (v) => {
  if (v) revealedIds.value = new Set()
})

function toggleReveal(id: number) {
  const next = new Set(revealedIds.value)
  if (!next.delete(id)) next.add(id)
  revealedIds.value = next
}

// 显示行 = 揭示 ? 原文 : 打码文；遮蔽先行再切首行/预览（遮蔽模式集不跨行，
// 行结构不变）。检测用差分判定（打码后 ≠ 原文 ⇔ 命中），与 useSensitiveMarkHint
// 同款无双实现
const rows = computed(() => store.entries.map((e) => {
  const mask = maskOf(e)
  const revealed = revealedIds.value.has(e.id)
  return {
    id: e.id,
    text: e.text,
    sensitive: mask.sensitive,
    revealed,
    shown: revealed ? e.text : mask.masked,
  }
}))

function pick(text: string) {
  show.value = false
  emit('pick', text)
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    class="clip-history-modal"
    :title="t('clip.history.title')"
    :bordered="false"
    size="small"
    data-testid="clip-history-modal"
  >
    <n-empty
      v-if="store.entries.length === 0"
      :description="t('clip.history.empty')"
      size="small"
      class="clip-history-empty"
      data-testid="clip-history-empty"
    />
    <div
      v-else
      class="clip-history-list"
    >
      <div
        v-for="row in rows"
        :key="row.id"
        class="clip-history-item"
        :class="{ 'clip-history-item-sensitive': row.sensitive }"
        data-testid="clip-history-item"
        @click="pick(row.text)"
      >
        <div class="clip-history-item-texts">
          <div
            class="clip-history-item-title"
            :title="firstLineOf(row.shown)"
          >
            {{ firstLineOf(row.shown) }}
          </div>
          <div
            v-if="previewOf(row.shown)"
            class="clip-history-item-preview"
          >
            {{ previewOf(row.shown) }}
          </div>
        </div>
        <button
          v-if="row.sensitive"
          type="button"
          class="clip-history-reveal"
          data-testid="clip-history-reveal"
          @click.stop="toggleReveal(row.id)"
        >
          {{ row.revealed ? t('clip.history.maskHide') : t('clip.history.maskShow') }}
        </button>
      </div>
    </div>
  </n-modal>
</template>

<style scoped>
.clip-history-empty { margin: 28px 0; }
.clip-history-list {
  max-height: 400px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.clip-history-item {
  padding: 7px 8px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  cursor: pointer;
  display: flex;
  align-items: flex-start;
  gap: 8px;
}
.clip-history-item:hover { background: var(--bg-hover); }
/* 敏感条目弱边框提示（P-20261005-14）：橙色 45% 混入底色作「内有敏感串」信号，
   揭示后保留（敏感性不因揭示消失），color-mix 不新增主题 token */
.clip-history-item-sensitive {
  border-color: color-mix(in srgb, var(--accent-orange) 45%, var(--border-default));
}
.clip-history-item-texts { flex: 1; min-width: 0; }
.clip-history-reveal {
  flex-shrink: 0;
  padding: 1px 8px;
  font-size: 10px;
  font-family: inherit;
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  cursor: pointer;
}
.clip-history-reveal:hover {
  color: var(--text-primary);
  border-color: var(--border-strong);
}
.clip-history-item-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clip-history-item-preview {
  margin-top: 4px;
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-all;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
</style>
