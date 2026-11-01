<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { NButton, NIcon, NInput, NEmpty, NSpin, NTag, useMessage } from 'naive-ui'
import { CloseOutline, SettingsOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { snippetApi, isCodeSnippet, type Snippet } from '../../api/client'
import { extractTemplateParams, interpolateTemplate } from '../../utils/textTemplate'
import { expandSnippetVars, referencesClipboard } from '../../utils/snippetVars'
import { readClipboardText } from '../../utils/clipboard'
import { loadSnippetParamHistory, rememberSnippetParamValues } from '../../utils/snippetParamHistory'

/**
 * 命令片段快速选择器（C2）：侧板挂在终端区内。
 * - global 片段处处可用；点击片段 → 有 {参数} 占位符时展开内联参数输入区，
 *   填完插值后插入终端；各占位符的上次填写值经 safeStorage 记忆并预填
 *   （P-20261002-123，语法见 utils/textTemplate）
 * - 插入时变量替换（P-20261006-1）：模板级 ${CLIPBOARD}/${DATE}/${TIME} 先展开
 *   再填 {参数}（用户填写的参数值是字面量不参与展开）；终端域无光标概念，$0
 *   原样保留；剪贴板读取失败/为空降级为变量原样并弱提示
 * - sendMode（远程控制台用）：点击片段直接发送执行（XShell 发送语义，宿主决定
 *   如何执行）；非 sendMode 为"插入不执行"（本机终端防误执行）
 * - 管理入口 → 设置 → 终端 → 命令片段区块
 * - 只列命令片段（P-20261002-44）：code 片段是编辑器域的，不进终端插入面
 */
const props = defineProps<{
  /** 发送模式：点击片段直接发送执行（而非插入草稿） */
  sendMode?: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'insert', command: string): void
}>()

const { t } = useI18n()
const message = useMessage()

/** 插入时变量替换（P-20261006-1）：模板级 ${CLIPBOARD}/${DATE}/${TIME} 先展开再填
 *  {参数}（用户填写的参数值是字面量不参与展开）；终端域 $0 原样保留；剪贴板不可用
 *  时变量原样降级并弱提示（插入仍继续，sendMode 直发前尤须知情） */
async function expandForInsert(template: string, values: Record<string, string>): Promise<string> {
  // 剪贴板按需读（referencesClipboard 门卫）：无变量插入不触碰权限/焦点面
  const clip = referencesClipboard(template) ? await readClipboardText() : undefined
  const v = expandSnippetVars(template, { clipboardText: clip ?? undefined, keepFinalTabstop: true })
  if (v.clipboardMissing) message.warning(t('terminal.snippet.clipboardUnavailable'), { duration: 3500 })
  return interpolateTemplate(v.text, values)
}

const snippets = ref<Snippet[]>([])
const query = ref('')
const loading = ref(false)

// 内联参数展开：当前展开参数输入区的片段 + 各参数的填写值
const expanded = ref<Snippet | null>(null)
const paramValues = ref<Record<string, string>>({})

const expandedParams = computed(() =>
  expanded.value ? extractTemplateParams(expanded.value.command) : [],
)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return snippets.value
  return snippets.value.filter(s =>
    s.title.toLowerCase().includes(q) ||
    s.command.toLowerCase().includes(q) ||
    (s.tags || []).some(tag => tag.toLowerCase().includes(q)),
  )
})

async function fetchSnippets() {
  loading.value = true
  try {
    const res = await snippetApi.list({ silent: true })
    // code 片段（编辑器域）不进终端：旧数据无 kind 缺省 command，照常可见
    snippets.value = (res.data || []).filter(s => !isCodeSnippet(s))
  } catch { /* silent：保留上次结果 */ } finally {
    loading.value = false
  }
}

async function pick(s: Snippet) {
  const params = extractTemplateParams(s.command)
  if (params.length === 0) {
    // 无占位符：仍过一遍插值把 {{ 转义归一成字面 {（纯命令为恒等）——
    // 插入的永远是渲染后文本，与带参路径一致
    emit('insert', await expandForInsert(s.command, {}))
    return
  }
  // 带参数：展开内联输入区，历史值预填（P-20261002-123：只带出本片段占位符
  // 名对应的上次填写值，空白不入史）
  expanded.value = s
  const hist = loadSnippetParamHistory()[s.id] || {}
  const pre: Record<string, string> = {}
  for (const p of params) {
    if (hist[p]) pre[p] = hist[p]
  }
  paramValues.value = pre
}

async function insertExpanded() {
  if (!expanded.value) return
  rememberSnippetParamValues(expanded.value.id, paramValues.value)
  emit('insert', await expandForInsert(expanded.value.command, paramValues.value))
  expanded.value = null
  paramValues.value = {}
}

const insertLabel = computed(() =>
  props.sendMode ? t('terminal.snippet.sendNow') : t('terminal.snippet.insertWithParams'),
)


function goManage() {
  window.dispatchEvent(new CustomEvent('sc-open-settings', { detail: 'terminal' }))
}

onMounted(fetchSnippets)
defineExpose({ refresh: fetchSnippets })
</script>

<template>
  <aside class="snippet-panel">
    <div class="snippet-header">
      <span class="snippet-title">{{ t('terminal.snippet.title') }}</span>
      <div class="snippet-header-actions">
        <n-button
          size="tiny"
          quaternary
          :title="t('terminal.snippet.manage')"
          @click="goManage"
        >
          <template #icon>
            <n-icon size="13">
              <SettingsOutline />
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

    <div class="snippet-filters">
      <n-input
        v-model:value="query"
        size="small"
        :placeholder="t('terminal.snippet.searchPlaceholder')"
        clearable
      />
    </div>

    <n-spin
      :show="loading"
      size="small"
      class="spin-fill"
    >
      <div class="snippet-list">
        <n-empty
          v-if="filtered.length === 0"
          :description="t('terminal.snippet.empty')"
          size="small"
          class="snippet-empty"
        />
        <template
          v-for="s in filtered"
          :key="s.id"
        >
          <div
            class="snippet-item"
            @click="pick(s)"
          >
            <div class="snippet-item-top">
              <span
                class="snippet-item-title"
                :title="s.title"
              >{{ s.title }}</span>
              <n-tag
                v-if="s.isSystem"
                size="small"
                :bordered="false"
              >
                {{ t('terminal.snippet.systemTag') }}
              </n-tag>
            </div>
            <div
              class="snippet-item-cmd"
              :title="s.command"
            >
              {{ s.command }}
            </div>
            <div
              v-if="s.description"
              class="snippet-item-desc"
              :title="s.description"
            >
              {{ s.description }}
            </div>
          </div>
          <!-- 带参片段的内联参数输入区（不弹新窗） -->
          <div
            v-if="expanded && expanded.id === s.id"
            class="snippet-params"
            @click.stop
          >
            <div
              v-for="p in expandedParams"
              :key="p"
              class="snippet-param-row"
            >
              <label class="snippet-param-label">{{ p }}</label>
              <n-input
                v-model:value="paramValues[p]"
                size="small"
                :placeholder="p"
              />
            </div>
            <div class="snippet-param-actions">
              <n-button
                size="tiny"
                @click="expanded = null"
              >
                {{ t('common.cancel') }}
              </n-button>
              <n-button
                size="tiny"
                type="primary"
                @click="insertExpanded"
              >
                {{ insertLabel }}
              </n-button>
            </div>
          </div>
        </template>
      </div>
    </n-spin>
  </aside>
</template>

<style scoped>
.snippet-panel {
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
.snippet-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}
.snippet-title { font-size: 13px; font-weight: 600; color: var(--text-primary); }
.snippet-header-actions { display: flex; gap: 2px; }
.snippet-filters { padding: 8px 10px; border-bottom: 1px solid var(--border-subtle); flex-shrink: 0; }
.snippet-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.snippet-empty { margin-top: 40px; }
.snippet-item { padding: 7px 10px; cursor: pointer; }
.snippet-item:hover { background: var(--bg-hover); }
.snippet-item-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.snippet-item-title {
  flex: 1; min-width: 0;
  font-size: 12px; font-weight: 600; color: var(--text-primary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.snippet-item-cmd {
  margin-top: 2px;
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-body);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.snippet-item-desc {
  margin-top: 2px;
  font-size: 10px; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.snippet-params {
  margin: 2px 10px 8px;
  padding: 8px;
  border: 1px solid var(--border-default);
  border-radius: 6px;
  background: var(--bg-elevated);
}
.snippet-param-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.snippet-param-label {
  width: 90px; flex-shrink: 0;
  font-family: var(--font-mono, monospace);
  font-size: 11px; color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-align: right;
}
.snippet-param-actions { display: flex; justify-content: flex-end; gap: 6px; margin-bottom: 0; }
.snippet-copy-hint {
  border: none; background: none; color: var(--text-dim);
  align-self: flex-end; padding: 4px 8px; cursor: pointer; flex-shrink: 0;
}
</style>
