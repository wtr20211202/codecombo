<script setup lang="ts">
// 跨项目命令历史检索浮层（P-20261004-2）：命令面板「搜索命令历史」入口呼出。
// - 全项目聚合查询（服务端 /api/terminal-history/search），q≥2 字符防全量扫
// - 列表：项目名 + 命令 + 退出码徽标 + 时间 → 点击插入当前终端（不执行），
//   悬停复制按钮仅复制（无活跃终端时宿主降级为复制并提示）
// - 远程条目（P-20261005-188）：source=input 带主机徽标、退出码位显示「—」
//   （输入域无此数据）；点选分流为复制（远程命令落进本地输入行等着回车是
//   「重跑必挂」误导，与 HistoryPanel 同一规则）
// - 与单项目 HistoryPanel（components/terminal/HistoryPanel.vue）不同域：
//   那是项目内排障面板，这里是跨项目「上次在哪跑的」检索面
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NIcon, NInput, NEmpty, NSpin, useMessage } from 'naive-ui'
import {
  TerminalOutline, CloseOutline, CopyOutline,
  CheckmarkCircleOutline, CloseCircleOutline,
} from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { copyText } from '../../utils/clipboard'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { terminalApi, type TerminalHistorySearchHit } from '../../api/client'
import { useRemoteHostStore } from '../../stores/remoteHost'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  /** 点选命中项：插入当前终端（宿主 sendToTerminal 链路，无终端降级复制） */
  (e: 'insert', command: string): void
}>()

const { t } = useI18n()
const message = useMessage()
// 远程主机名解读（P-20261005-188 主机徽标）：打开时惰性拉一次，失败静默回落主机 id
const hostStore = useRemoteHostStore()

// 查询词下限与后端 terminalHistorySearchMinRunes 对齐（客户端先挡，省一次 400）
const MIN_CHARS = 2

const query = ref('')
const hits = ref<TerminalHistorySearchHit[]>([])
const loading = ref(false)
const searched = ref(false)
const inputRef = ref<InstanceType<typeof NInput> | null>(null)

/** 输入域命中（P-20261005-188）：source=input 的「提交的输入行」 */
function isInputHit(hit: TerminalHistorySearchHit): boolean {
  return hit.source === 'input'
}

function hostLabel(hit: TerminalHistorySearchHit): string {
  if (!hit.host) return ''
  return hostStore.hosts.find(h => h.id === hit.host)?.name || hit.host
}

watch(() => props.show, (show) => {
  if (!show) return
  // 打开即全新检索意图：清空上轮查询与结果，焦点落搜索框
  query.value = ''
  hits.value = []
  searched.value = false
  if (hostStore.hosts.length === 0) void hostStore.fetch().catch(() => {})
  void nextTick(() => inputRef.value?.focus())
})

async function fetchHits() {
  const q = query.value.trim()
  if (q.length < MIN_CHARS) {
    hits.value = []
    searched.value = false
    return
  }
  loading.value = true
  try {
    const res = await terminalApi.searchHistoryAll(q) as unknown as { data?: TerminalHistorySearchHit[] }
    // 竞态守卫：仅采纳最后一次查询的结果（快速连打时旧响应后到会覆盖新词）
    if (query.value.trim() === q) {
      hits.value = res.data || []
      searched.value = true
    }
  } catch { /* silent：保留上次结果（已知错误由拦截器统一提示） */ }
  finally { loading.value = false }
}

// 搜索防抖 300ms（HistoryPanel 同参）
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(fetchHits, 300)
})

function close() {
  emit('update:show', false)
}

// 点选落位（P-20261005-188 分流）：输入域条目只给复制不给直插——落位目标
// 是本地终端，远程命令等被回车即误导；提示语点明缘由
async function insertHit(hit: TerminalHistorySearchHit) {
  if (isInputHit(hit)) {
    const ok = await copyText(hit.command)
    if (ok) message.info(t('terminal.history.remoteCopyOnly'))
    else message.error(t('terminal.history.copyFailed'))
    close()
    return
  }
  emit('insert', hit.command)
  close()
}

async function copyHit(hit: TerminalHistorySearchHit) {
  const ok = await copyText(hit.command)
  if (ok) message.success(t('terminal.history.copied'))
  else message.error(t('terminal.history.copyFailed'))
}

// ── 键盘导航（BookmarkListPopover 同惯例）：↑↓ 环绕移动，Enter 插入，Esc 关闭 ──
const activeIdx = ref(-1)

watch([() => props.show, hits], ([show]) => {
  activeIdx.value = show && hits.value.length > 0 ? 0 : -1
})

function moveActive(delta: number) {
  const n = hits.value.length
  if (n === 0) return
  activeIdx.value = ((activeIdx.value + delta) % n + n) % n
  void nextTick(() => {
    document.querySelector('.thsearch-item.is-active')?.scrollIntoView({ block: 'nearest' })
  })
}

function onWindowKeydown(e: KeyboardEvent) {
  if (!props.show) return
  if (e.defaultPrevented) return // Layout 级已消费的 Esc（如退出最大化）不重复处理
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveActive(1)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveActive(-1)
    return
  }
  if (e.key === 'Enter' && activeIdx.value >= 0 && hits.value[activeIdx.value]) {
    e.preventDefault()
    insertHit(hits.value[activeIdx.value]!)
    return
  }
  if (e.key === 'Escape') {
    if (hasBlockingOverlay()) return
    e.preventDefault()
    close()
  }
}
onMounted(() => window.addEventListener('keydown', onWindowKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowKeydown))

function formatTime(ts: string): string {
  try { return new Date(ts).toLocaleString() } catch { return ts }
}
</script>

<template>
  <transition name="thsearch-fade">
    <div
      v-if="props.show"
      class="thsearch-mask"
      @click.self="close"
    >
      <div
        class="thsearch-card glass-panel"
        data-testid="terminal-history-search"
      >
        <div class="thsearch-header">
          <n-icon
            size="13"
            class="thsearch-icon"
          >
            <TerminalOutline />
          </n-icon>
          <span class="thsearch-title">{{ t('terminal.history.globalTitle') }}</span>
          <button
            class="thsearch-close"
            :title="t('commandPalette.close')"
            @click="close"
          >
            <n-icon size="12">
              <CloseOutline />
            </n-icon>
          </button>
        </div>
        <div class="thsearch-input">
          <n-input
            ref="inputRef"
            v-model:value="query"
            size="small"
            clearable
            :placeholder="t('terminal.history.globalSearchPlaceholder')"
            :data-testid="'terminal-history-search-input'"
          />
        </div>
        <n-spin
          :show="loading"
          size="small"
          class="spin-fill"
        >
          <div class="thsearch-list">
            <div
              v-if="query.trim().length < MIN_CHARS"
              class="thsearch-hint"
            >
              {{ t('terminal.history.minCharsHint') }}
            </div>
            <n-empty
              v-else-if="searched && hits.length === 0"
              size="small"
              :description="t('terminal.history.empty')"
              class="thsearch-empty"
            />
            <template v-else>
              <button
                v-for="(hit, idx) in hits"
                :key="hit.projectId + hit.ts + idx"
                class="thsearch-item"
                :class="{ 'is-active': idx === activeIdx }"
                :data-testid="`terminal-history-hit-${idx}`"
                :title="hit.command"
                @click="insertHit(hit)"
              >
                <div class="thsearch-item-main">
                  <div class="thsearch-item-cmd">
                    {{ hit.command }}
                  </div>
                  <div class="thsearch-item-meta">
                    <span class="thsearch-item-proj">{{ hit.projectName }}</span>
                    <!-- 远程输入域命中（P-20261005-188）：主机徽标 + 退出码位「—」 -->
                    <template v-if="isInputHit(hit)">
                      <span
                        class="thsearch-item-host"
                        :title="t('terminal.history.inputDomainTip', { host: hostLabel(hit) })"
                      >{{ hostLabel(hit) }}</span>
                      <span class="thsearch-item-na">—</span>
                    </template>
                    <template v-else>
                      <span
                        class="thsearch-item-exit"
                        :class="hit.exitCode === 0 ? 'is-ok' : 'is-fail'"
                      >
                        <n-icon size="10">
                          <CheckmarkCircleOutline v-if="hit.exitCode === 0" />
                          <CloseCircleOutline v-else />
                        </n-icon>
                        <!-- 成功只留 ✓（"0" 是噪音）；失败显示具体退出码（排障溯源） -->
                        <template v-if="hit.exitCode !== 0">{{ hit.exitCode }}</template>
                      </span>
                    </template>
                    <span class="thsearch-item-time">{{ formatTime(hit.ts) }}</span>
                  </div>
                </div>
                <span
                  class="thsearch-item-copy"
                  :title="t('terminal.history.copy')"
                  @click.stop="copyHit(hit)"
                >
                  <n-icon size="12"><CopyOutline /></n-icon>
                </span>
              </button>
            </template>
          </div>
        </n-spin>
        <div class="thsearch-footnote">
          {{ t('terminal.history.globalFootnote') }}
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.thsearch-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
.thsearch-card {
  position: absolute;
  top: 80px;
  right: 16px;
  width: 420px;
  max-height: 70vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.thsearch-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface));
}
.thsearch-icon { color: var(--accent-orange); }
.thsearch-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.thsearch-close {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.thsearch-close:hover { color: var(--text-primary); background: var(--bg-hover); }
.thsearch-input {
  padding: 8px 10px;
  border-bottom: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.thsearch-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.thsearch-hint, .thsearch-empty { padding: 24px 16px; text-align: center; font-size: 11px; color: var(--text-muted); }
.thsearch-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 10px 5px 8px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast);
}
.thsearch-item:hover { background: var(--bg-hover); }
.thsearch-item.is-active,
.thsearch-item.is-active:hover { background: var(--bg-active); }
.thsearch-item-main { flex: 1; min-width: 0; }
.thsearch-item-cmd {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-body);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thsearch-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 2px;
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
}
.thsearch-item-proj {
  color: var(--text-secondary);
  background: var(--bg-panel);
  border-radius: 6px;
  padding: 0 6px;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thsearch-item-exit { display: inline-flex; align-items: center; gap: 2px; font-weight: 600; }
.thsearch-item-exit.is-ok { color: var(--accent-green); }
.thsearch-item-exit.is-fail { color: var(--accent-red); }
/* 远程输入域命中（P-20261005-188）：主机徽标与项目名同款胶囊，「—」弱灰占位 */
.thsearch-item-host {
  color: var(--text-secondary);
  background: var(--bg-panel);
  border-radius: 6px;
  padding: 0 6px;
  max-width: 30%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.thsearch-item-na { color: var(--text-dim); }
.thsearch-item-time { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.thsearch-item-copy {
  display: inline-flex;
  align-items: center;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-dim);
  padding: 2px 4px;
  border-radius: 3px;
  opacity: 0;
  transition: opacity var(--motion-base);
  flex-shrink: 0;
}
.thsearch-item:hover .thsearch-item-copy { opacity: 1; }
.thsearch-item-copy:hover { background: var(--bg-hover); color: var(--text-primary); }
.thsearch-footnote {
  padding: 5px 10px;
  font-size: 10px;
  color: var(--text-dim);
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.thsearch-fade-enter-active,
.thsearch-fade-leave-active { transition: opacity var(--motion-base); }
.thsearch-fade-enter-active .thsearch-card,
.thsearch-fade-leave-active .thsearch-card { transition: transform var(--motion-base), opacity var(--motion-base); }
.thsearch-fade-enter-from,
.thsearch-fade-leave-to { opacity: 0; }
.thsearch-fade-enter-from .thsearch-card,
.thsearch-fade-leave-to .thsearch-card { transform: translateY(-8px) scale(0.98); opacity: 0; }
</style>
