<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { NButton, NIcon, NModal } from 'naive-ui'
import { RefreshOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { instanceFetchRaw } from '../../api/instanceFetch'

/**
 * 远程/本机会话只读输出查看器（多实例总览「查看输出」）：
 * 轮询 scrollback 端点（本机同源 /api，远程回环代理 /proxy/<id>/api，端点
 * 服务端已存在——GET /terminals/:id/scrollback，octet-stream 文本），以
 * content-visibility 无关的纯文本 <pre> 渲染并自动滚底。
 * 只读、零副作用：不 attach、不抢独占挂接，关闭即停轮询。
 */
const props = defineProps<{
  show: boolean
  instanceId: string
  sessionId: string
  sessionName: string
}>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const { t } = useI18n()

const text = ref('')
const preRef = ref<HTMLElement | null>(null)
const loading = ref(false)
const ended = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

/** 剥离 ANSI 转义序列：scrollback 是原始 PTY 字节流文本，颜色/光标控制码
 *  在纯文本 <pre> 里会以乱码方块显示（∅[1m∅[32m…）。标准 ansi-regex 模式
 *  （CSI/OSC/单字符 ESC 全形），正文里的普通文本不受影响 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-ntqry=><~]))/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

async function fetchOnce(): Promise<void> {
  if (!props.sessionId) return
  loading.value = true
  try {
    const res = await instanceFetchRaw(props.instanceId, 'GET', `/terminals/${props.sessionId}/scrollback`)
    if (res.status === 404) {
      ended.value = true
      stopPoll()
      return
    }
    if (!res.ok) throw new Error(String(res.status))
    ended.value = false
    const next = stripAnsi(await res.text())
    if (next !== text.value) text.value = next
    scrollToBottom()
  } catch {
    ended.value = true // 不可达视同结束，停轮询
    stopPoll()
  } finally {
    loading.value = false
  }
}

function scrollToBottom(): void {
  const el = preRef.value
  if (el) el.scrollTop = el.scrollHeight
}

function startPoll(): void {
  stopPoll()
  void fetchOnce()
  pollTimer = setInterval(() => { void fetchOnce() }, 3000)
}
function stopPoll(): void {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
}

watch(() => props.show, (v) => {
  text.value = ''
  ended.value = false
  if (v) startPoll()
  else stopPoll()
}, { immediate: true }) // v-if 挂载时 show 已为 true：immediate 才会启动首轮轮询
// 会话切换（同一弹层复用）时立即重拉
watch(() => props.sessionId, () => {
  if (props.show) startPoll()
})
onBeforeUnmount(stopPoll)
</script>

<template>
  <n-modal
    :show="props.show"
    preset="card"
    style="width: var(--modal-w-lg); max-width: 94vw"
    :title="`${t('instanceSessions.viewOutput')} — ${props.sessionName}`"
    :bordered="false"
    @update:show="(v: boolean) => emit('update:show', v)"
  >
    <div class="iso-out-toolbar">
      <span class="iso-out-hint">{{ ended ? t('instanceSessions.sessionEnded') : t('instanceSessions.outputHint') }}</span>
      <n-button
        size="tiny"
        quaternary
        :disabled="ended"
        @click="fetchOnce"
      >
        <template #icon>
          <n-icon size="12">
            <RefreshOutline />
          </n-icon>
        </template>
        {{ t('instanceSessions.refresh') }}
      </n-button>
    </div>
    <pre
      v-if="text"
      ref="preRef"
      class="iso-out-pre"
    >{{ text }}</pre>
    <div
      v-else-if="ended"
      class="iso-out-empty"
    >
      {{ t('instanceSessions.sessionEnded') }}
    </div>
    <div
      v-else
      class="iso-out-empty"
    >
      {{ t('instanceSessions.outputEmpty') }}
    </div>
  </n-modal>
</template>

<style scoped>
.iso-out-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 8px;
}
.iso-out-hint {
  flex: 1;
  font-size: 12px;
  color: var(--text-tertiary);
}
.iso-out-pre {
  margin: 0;
  padding: 10px 12px;
  max-height: 56vh;
  overflow-y: auto;
  background: var(--bg-canvas);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-body);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.iso-out-empty {
  padding: 24px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-tertiary);
}
</style>
