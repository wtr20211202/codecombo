<script setup lang="ts">
// 端口占用一览浮层（P-20261003-293）：命令面板「端口占用一览」入口呼出。
// - 服务端 GET /api/terminals/ports：端口注册表登记面（dev 端口探测 + agent
//   上报两路信号的「端口→会话」沉淀），列表按端口升序返回
// - 只读浮层：端口/会话/来源/首见时刻，行点选走 useApprovalActions
//   jumpToSession 既有 activate-terminal 链路直达占用方终端，端口一键复制
// - 诚实边界（注记行）：登记面=探测/上报面，未被探测到的监听不在列；
//   注册表内存态，服务重启后清空
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NIcon, NEmpty, NSpin, useMessage } from 'naive-ui'
import { RefreshOutline, CloseOutline, CopyOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { copyText } from '../../utils/clipboard'
import { terminalApi, type TerminalPortEntry } from '../../api/domains/terminal'

const props = defineProps<{
  show: boolean
}>()

const emit = defineEmits<{
  (e: 'update:show', v: boolean): void
  /** 点选条目：宿主经 jumpToSession 既有链路激活该会话 */
  (e: 'jump', sessionId: string): void
}>()

const { t } = useI18n()
const message = useMessage()

const entries = ref<TerminalPortEntry[]>([])
const loading = ref(false)
const loaded = ref(false)

/** 打开即拉取当前登记面（只读快照，不轮询——冲突归因走通知中心实时推送） */
async function fetchEntries() {
  loading.value = true
  try {
    const res = await terminalApi.listPorts() as unknown as { data?: TerminalPortEntry[] }
    entries.value = res.data || []
    loaded.value = true
  } catch { /* silent：已知错误由拦截器统一提示 */ }
  finally { loading.value = false }
}

watch(() => props.show, (show) => {
  if (!show) return
  void fetchEntries()
})

function close() {
  emit('update:show', false)
}

async function jumpEntry(entry: TerminalPortEntry) {
  emit('jump', entry.sessionId)
  close()
}

async function copyPort(entry: TerminalPortEntry) {
  const ok = await copyText(String(entry.port))
  if (ok) message.success(t('terminal.portRegistry.copied'))
  else message.error(t('terminal.history.copyFailed'))
}

// 来源徽标语义：detected=服务端输出探测 / reported=agent 主动上报
//（与 preview.port 广播 payload 的 source 词表一致）；未知值原样展示不崩
function sourceText(source: string): string {
  if (source === 'detected') return t('terminal.portRegistry.sourceDetected')
  if (source === 'reported') return t('terminal.portRegistry.sourceReported')
  return source
}

function formatTime(ts: string): string {
  try { return new Date(ts).toLocaleString() } catch { return ts }
}

// ── 键盘导航（TerminalOutputSearchPopover 同惯例）：↑↓ 环绕移动，Enter 跳转，Esc 关闭 ──
const activeIdx = ref(-1)

watch([() => props.show, entries], ([show]) => {
  activeIdx.value = show && entries.value.length > 0 ? 0 : -1
})

function moveActive(delta: number) {
  const n = entries.value.length
  if (n === 0) return
  activeIdx.value = ((activeIdx.value + delta) % n + n) % n
  void nextTick(() => {
    document.querySelector('.tports-item.is-active')?.scrollIntoView({ block: 'nearest' })
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
  if (e.key === 'Enter' && activeIdx.value >= 0 && entries.value[activeIdx.value]) {
    e.preventDefault()
    void jumpEntry(entries.value[activeIdx.value]!)
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
</script>

<template>
  <transition name="tports-fade">
    <div
      v-if="props.show"
      class="tports-mask"
      @click.self="close"
    >
      <div
        class="tports-card glass-panel"
        data-testid="terminal-ports"
      >
        <div class="tports-header">
          <n-icon
            size="13"
            class="tports-icon"
          >
            <RefreshOutline />
          </n-icon>
          <span class="tports-title">{{ t('terminal.portRegistry.title') }}</span>
          <button
            class="tports-close"
            :title="t('commandPalette.close')"
            @click="close"
          >
            <n-icon size="12">
              <CloseOutline />
            </n-icon>
          </button>
        </div>
        <n-spin
          :show="loading"
          size="small"
          class="spin-fill"
        >
          <div class="tports-list">
            <n-empty
              v-if="loaded && entries.length === 0"
              size="small"
              :description="t('terminal.portRegistry.empty')"
              class="tports-empty"
            />
            <template v-else>
              <div
                v-for="(entry, idx) in entries"
                :key="entry.port"
                class="tports-item"
                :class="{ 'is-active': idx === activeIdx }"
                :data-testid="`terminal-ports-row-${idx}`"
                :title="t('terminal.portRegistry.jumpHint')"
                @click="jumpEntry(entry)"
                @mousemove="activeIdx = idx"
              >
                <span class="tports-port">:{{ entry.port }}</span>
                <span class="tports-session">{{ entry.sessionName || entry.sessionId }}</span>
                <span
                  v-if="entry.label"
                  class="tports-label"
                >{{ entry.label }}</span>
                <span class="tports-meta">
                  <span class="tports-source">{{ sourceText(entry.source) }}</span>
                  <span class="tports-time">{{ formatTime(entry.firstSeen) }}</span>
                </span>
                <button
                  class="tports-copy"
                  :title="t('terminal.portRegistry.copy')"
                  :data-testid="`terminal-ports-copy-${idx}`"
                  @click.stop="copyPort(entry)"
                >
                  <n-icon size="12">
                    <CopyOutline />
                  </n-icon>
                </button>
              </div>
            </template>
          </div>
        </n-spin>
        <div class="tports-footnote">
          {{ t('terminal.portRegistry.footnote') }}
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.tports-mask {
  position: fixed;
  inset: 0;
  z-index: 1000;
}
.tports-card {
  position: absolute;
  top: 80px;
  right: 16px;
  width: 480px;
  max-height: 70vh;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--shadow-strong);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.tports-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border-default);
  background: linear-gradient(to bottom, var(--bg-elevated), var(--bg-surface));
}
.tports-icon { color: var(--accent-orange); }
.tports-title { font-size: 12px; font-weight: 600; color: var(--text-primary); }
.tports-close {
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
.tports-close:hover { color: var(--text-primary); background: var(--bg-hover); }
.tports-list { flex: 1; overflow-y: auto; padding: 4px 0; }
.tports-empty { padding: 24px 16px; }
.tports-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px 6px 12px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition: background var(--motion-fast);
}
.tports-item:hover { background: var(--bg-hover); }
.tports-item.is-active,
.tports-item.is-active:hover { background: var(--bg-active); }
.tports-port {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  flex-shrink: 0;
}
.tports-session {
  font-size: 11px;
  color: var(--text-secondary);
  background: var(--bg-panel);
  border-radius: 6px;
  padding: 0 6px;
  max-width: 34%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}
.tports-label {
  font-size: 10px;
  color: var(--text-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tports-meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.tports-source {
  font-size: 10px;
  color: var(--text-dim);
  border: 1px solid var(--border-subtle);
  border-radius: 6px;
  padding: 0 5px;
  white-space: nowrap;
}
.tports-time {
  font-size: 10px;
  color: var(--text-dim);
  font-family: var(--font-mono);
  white-space: nowrap;
}
.tports-copy {
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.tports-copy:hover { color: var(--text-primary); background: var(--bg-hover); }
.tports-footnote {
  padding: 5px 10px;
  font-size: 10px;
  color: var(--text-dim);
  border-top: 1px solid var(--border-subtle);
  flex-shrink: 0;
}
.tports-fade-enter-active,
.tports-fade-leave-active { transition: opacity var(--motion-base); }
.tports-fade-enter-active .tports-card,
.tports-fade-leave-active .tports-card { transition: transform var(--motion-base), opacity var(--motion-base); }
.tports-fade-enter-from,
.tports-fade-leave-to { opacity: 0; }
.tports-fade-enter-from .tports-card,
.tports-fade-leave-to .tports-card { transform: translateY(-8px) scale(0.98); opacity: 0; }
</style>
