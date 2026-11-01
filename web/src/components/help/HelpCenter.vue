<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NDrawer, NDrawerContent, NIcon, NInput, NSpin } from 'naive-ui'
import { ChatbubblesOutline, SearchOutline } from '@vicons/ionicons5'
import { marked } from 'marked'
import { useI18n } from '../../composables/useI18n'
import { helpApi, type HelpCategory, type HelpEntry } from '../../api/domains/system'
import { fuzzyScoreWeighted } from '../../utils/fuzzy'
import { OPEN_HELP_EVENT } from '../../utils/openHelp'

// 帮助中心抽屉（业界主流形态：右侧抽屉 + 搜索 + 分类折叠问答）。
// 内容与智能体共用同一数据源（GET /api/help）：界面看到的答案即智能体
// 可查到的答案；末尾提示用户也可以直接在智能体中提问。
const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()
const { t, locale } = useI18n()

const loading = ref(false)
const loaded = ref(false)
const failed = ref(false)
const categories = ref<HelpCategory[]>([])
const entries = ref<HelpEntry[]>([])
const keyword = ref('')
const expanded = ref(new Set<string>())

const isEn = computed(() => String(locale.value || '').startsWith('en'))

// 失败时全局拦截器已 toast，这里只落失败态供重试；不 catch 会让 rejection
// 逃逸成未处理异常，且正文落到「无结果」误导用户
async function load(): Promise<void> {
  if (loading.value) return
  loading.value = true
  failed.value = false
  try {
    const res = await helpApi.get() as unknown as { data?: { categories?: HelpCategory[]; entries?: HelpEntry[] } }
    categories.value = res?.data?.categories ?? []
    entries.value = res?.data?.entries ?? []
    loaded.value = true
    await revealAnchor()
  } catch {
    failed.value = true
  } finally {
    loading.value = false
  }
}
watch(() => props.show, (v) => { if (v) void load() })

// 锚定直达（sc-open-help 深链，如新建会话对话框的安装指引）：宿主只管置 show，
// 锚点条目由本组件监听同一事件自行消化——与 SettingsModal 监听 OPEN_SETTINGS_EVENT
// 自切分区的分工同款。事件可能先于/伴随 show 置位到达，先记账随 load 后消费
const pendingAnchor = ref('')
function onOpenHelpRequest(e: Event): void {
  pendingAnchor.value = (e as CustomEvent<string | undefined>).detail || ''
}
onMounted(() => window.addEventListener(OPEN_HELP_EVENT, onOpenHelpRequest))
onBeforeUnmount(() => window.removeEventListener(OPEN_HELP_EVENT, onOpenHelpRequest))

/** 消费锚定条目：清搜索词防被过滤，展开并滚动定位（rAF 等抽屉过渡一帧再滚）。
 *  条目不存在时静默跳过——旧入口指向已下线 FAQ 不误导 */
async function revealAnchor(): Promise<void> {
  const id = pendingAnchor.value
  pendingAnchor.value = ''
  if (!id || !entries.value.some((x) => x.id === id)) return
  keyword.value = ''
  const next = new Set(expanded.value)
  next.add(id)
  expanded.value = next
  await nextTick()
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-help-entry="${CSS.escape(id)}"]`)
    el?.scrollIntoView({ block: 'center' })
  })
}

/** 按语言取字段（en 缺失时回退中文） */
function pickText(e: HelpEntry, field: 'q' | 'a'): string {
  if (isEn.value) {
    const en = field === 'q' ? e.qEn : e.aEn
    if (en) return en
  }
  return e[field]
}

const filtered = computed(() => {
  const kw = keyword.value.trim()
  if (!kw) return entries.value
  // 模糊匹配（与命令面板同引擎）：子序列 + 多 token AND + 打分排序——
  // 问题标题为主字段（命中权重 ×2），答案/分类/标签为次字段；
  // 精确子串天然得高分，错序词/部分词也能命中
  const scored: Array<{ e: HelpEntry; s: number }> = []
  for (const e of entries.value) {
    const secondary = [e.a, e.qEn, e.aEn, e.category, ...(e.tags ?? [])].filter(Boolean).join(' ')
    const s = fuzzyScoreWeighted(kw, pickText(e, 'q'), secondary)
    if (s !== null) scored.push({ e, s })
  }
  scored.sort((x, y) => y.s - x.s)
  return scored.map((x) => x.e)
})

const groups = computed(() =>
  categories.value
    .map((c) => ({ ...c, items: filtered.value.filter((e) => e.category === c.id) }))
    .filter((g) => g.items.length > 0),
)

function toggleEntry(id: string): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/** 答案为受信静态内容（本系统后端下发），marked 渲染为 html */
function renderAnswer(md: string): string {
  return marked.parse(md, { async: false }) as string
}

function catTitle(c: HelpCategory): string {
  return isEn.value ? (c.titleEn || c.title) : c.title
}
</script>

<template>
  <NDrawer
    :show="props.show"
    :default-width="540"
    placement="right"
    @update:show="emit('update:show', $event)"
  >
    <NDrawerContent
      :title="t('help.title')"
      closable
      :native-scrollbar="true"
    >
      <NInput
        v-model:value="keyword"
        :placeholder="t('help.searchPlaceholder')"
        clearable
        size="small"
      >
        <template #prefix>
          <NIcon
            :component="SearchOutline"
            size="14"
          />
        </template>
      </NInput>

      <div class="help-agent-tip">
        <NIcon
          :component="ChatbubblesOutline"
          size="14"
        />
        <span>{{ t('help.agentTip') }}</span>
      </div>

      <NSpin :show="loading">
        <div class="help-body">
          <section
            v-for="g in groups"
            :key="g.id"
            class="help-group"
          >
            <div class="help-cat">
              {{ catTitle(g) }}
            </div>
            <div
              v-for="e in g.items"
              :key="e.id"
              class="help-entry"
            >
              <button
                class="help-q"
                :data-help-entry="e.id"
                @click="toggleEntry(e.id)"
              >
                <span>{{ pickText(e, 'q') }}</span>
                <span
                  class="help-chev"
                  :class="{ open: expanded.has(e.id) }"
                >›</span>
              </button>
              <!-- eslint-disable-next-line vue/no-v-html —— 内容为本系统后端下发的受信静态文档 -->
              <div
                v-if="expanded.has(e.id)"
                class="help-a"
                v-html="renderAnswer(pickText(e, 'a'))"
              />
            </div>
          </section>
          <div
            v-if="!loading && failed"
            class="help-empty"
          >
            {{ t('help.loadFailed') }}
            <button
              class="help-retry"
              @click="load()"
            >
              {{ t('help.retry') }}
            </button>
          </div>
          <div
            v-else-if="!loading && groups.length === 0"
            class="help-empty"
          >
            {{ t('help.noResults') }}
          </div>
        </div>
      </NSpin>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.help-agent-tip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 12px 0 4px;
  padding: 8px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.help-agent-tip :deep(.n-icon) { flex-shrink: 0; margin-top: 2px; }

.help-body { padding: 8px 2px 24px; }
.help-cat {
  margin: 14px 0 6px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.04em;
}
.help-entry {
  border: 1px solid var(--border-subtle);
  border-radius: 7px;
  margin-bottom: 6px;
  overflow: hidden;
  background: var(--bg-primary);
}
.help-q {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 9px 12px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.help-q:hover { background: var(--bg-hover); }
.help-chev {
  color: var(--text-muted);
  font-size: 16px;
  transition: transform var(--motion-base);
  flex-shrink: 0;
}
.help-chev.open { transform: rotate(90deg); }
.help-a {
  padding: 2px 12px 12px;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--text-secondary);
  border-top: 1px dashed var(--border-subtle);
  padding-top: 10px;
}
.help-a :deep(p) { margin: 0 0 8px; }
.help-a :deep(p:last-child) { margin-bottom: 0; }
.help-a :deep(code) {
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--bg-canvas);
  border: 1px solid var(--border-subtle);
}
.help-a :deep(ul), .help-a :deep(ol) { margin: 0 0 8px; padding-left: 18px; }
.help-empty {
  padding: 32px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 13px;
}
.help-retry {
  display: inline-block;
  margin-left: 10px;
  padding: 2px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  background: var(--bg-elevated);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}
.help-retry:hover { background: var(--bg-hover); }
</style>
