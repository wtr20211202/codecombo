<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { NButton, NIcon, NInput, NModal, NEmpty, NSpin, NTag } from 'naive-ui'
import { SearchOutline, CloseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { snippetApi, isCodeSnippet, type Snippet } from '../../api/client'

/**
 * 编辑器代码片段选择器（P-20261002-44）：Monaco 右键「插入片段」与命令面板
 * 「插入片段」共用的列表弹窗。按当前文件语言过滤 code 片段（language 为空的
 * 片段视为任意语言可用），点选后经 pick 事件上抛文本——插入位置与 executeEdits
 * 在宿主（MonacoEditor），本组件只管选片段。
 */
const props = defineProps<{
  /** 当前文件语言（monaco language id；空 = 不过滤语言） */
  language?: string
}>()

const show = defineModel<boolean>('show', { required: true })

const emit = defineEmits<{
  (e: 'pick', text: string): void
}>()

const { t } = useI18n()

const snippets = ref<Snippet[]>([])
const query = ref('')
const loading = ref(false)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return snippets.value.filter((s) => {
    if (q && !s.title.toLowerCase().includes(q)) return false
    // 语言过滤：片段 language 为空 = 任意语言可用；非空则须与当前文件语言一致
    if (s.language && props.language && s.language !== props.language) return false
    return true
  })
})

async function fetchSnippets() {
  loading.value = true
  try {
    const res = await snippetApi.list({ silent: true })
    snippets.value = (res.data || []).filter(isCodeSnippet)
  } catch { /* silent：保留上次结果 */ } finally {
    loading.value = false
  }
}

watch(show, (v) => {
  if (!v) return
  query.value = ''
  void fetchSnippets()
})

/** 点选后先关弹窗、退场完成（after-leave）再上抛：n-modal 卸载时的焦点归还会
 *  晚于宿主插入后的 editor.focus()，同步 emit 会把键盘焦点抢回弹窗残留焦点位
 *  （P-20261006-1 编辑器 e2e 实测：插入后直接打字断焦不落地）——退场完再插入，
 *  焦点稳定落在编辑器（$0 终位后可直接续打） */
const pendingPick = ref<Snippet | null>(null)

function pick(s: Snippet) {
  pendingPick.value = s
  show.value = false
}

function onAfterLeave() {
  const s = pendingPick.value
  pendingPick.value = null
  if (s) emit('pick', s.command)
}
</script>

<template>
  <n-modal
    v-model:show="show"
    preset="card"
    class="scsnip-pick-modal"
    :title="t('snippet.code.pickTitle')"
    :bordered="false"
    size="small"
    data-testid="snippet-insert-modal"
    @after-leave="onAfterLeave"
  >
    <div class="scsnip-pick-body">
      <n-input
        v-model:value="query"
        size="small"
        :placeholder="t('snippet.code.searchPlaceholder')"
        clearable
        data-testid="snippet-insert-search"
      >
        <template #prefix>
          <n-icon :component="SearchOutline" />
        </template>
      </n-input>
      <n-spin
        :show="loading"
        size="small"
        class="scsnip-pick-spin"
      >
        <n-empty
          v-if="filtered.length === 0"
          :description="t('snippet.code.empty')"
          size="small"
          class="scsnip-pick-empty"
          data-testid="snippet-insert-empty"
        />
        <div
          v-for="s in filtered"
          :key="s.id"
          class="scsnip-pick-item"
          data-testid="snippet-insert-item"
          @click="pick(s)"
        >
          <div class="scsnip-pick-top">
            <span
              class="scsnip-pick-title"
              :title="s.title"
            >{{ s.title }}</span>
            <n-tag
              v-if="s.language"
              size="small"
              :bordered="false"
            >
              {{ s.language }}
            </n-tag>
          </div>
          <div
            v-if="s.description"
            class="scsnip-pick-desc"
            :title="s.description"
          >{{ s.description }}</div>
        </div>
      </n-spin>
    </div>
    <template #footer>
      <div class="scsnip-pick-footer">
        <n-button
          size="tiny"
          quaternary
          @click="show = false"
        >
          <template #icon>
            <n-icon size="13">
              <CloseOutline />
            </n-icon>
          </template>
          {{ t('common.close') }}
        </n-button>
      </div>
    </template>
  </n-modal>
</template>

<style scoped>
.scsnip-pick-body { display: flex; flex-direction: column; gap: 8px; }
.scsnip-pick-spin { min-height: 120px; max-height: 320px; overflow-y: auto; }
.scsnip-pick-empty { margin: 28px 0; }
.scsnip-pick-item {
  padding: 7px 8px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  cursor: pointer;
  margin-top: 6px;
}
.scsnip-pick-item:hover { background: var(--bg-hover); }
.scsnip-pick-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.scsnip-pick-title {
  flex: 1; min-width: 0;
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.scsnip-pick-desc {
  margin-top: 4px;
  font-size: 10px; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.scsnip-pick-footer { display: flex; justify-content: flex-end; }
</style>
