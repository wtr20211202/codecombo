<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { NButton, NInputNumber, NTag, NIcon, NEmpty, NSpin } from 'naive-ui'
import { RefreshOutline, OpenOutline, AlertCircleOutline, CloseOutline } from '@vicons/ionicons5'
import { useI18n } from '../../composables/useI18n'
import { safeStorage } from '../../utils/storage'
import { usePreviewPortStore } from '../../stores/previewPort'
import { previewCompatMode, ensurePreviewCompatLoaded } from '../../composables/usePreviewSandbox'

// 端口预览面板：本机回环端口（dev server 等）经服务端 /preview/:port 回环反代
// 在 iframe 内查看——服务跑在远程 Linux、浏览器在任意设备形态下，
// 「终端里起了 npm run dev → 面板里直接看」的最后一块拼图
const { t } = useI18n()

// 沙箱最小授权（P-20261019-1）：allow-scripts（SPA/模块脚本必需）+ allow-forms
// + allow-popups + allow-modals；刻意不含 allow-same-origin——iframe 文档保持
// 不透明源，被预览 dev server 的任意 JS（不受信项目依赖链的现实攻击面）读不到
// 父页 localStorage（解锁令牌）与非 HttpOnly 锁 cookie，也无法同源携带凭据调
// /api/*（与 P-20261020-4 分享脚本隔离同一红线）。网络与 HMR WebSocket 不受
// sandbox 限制；个别 dev app 依赖同源存储时经设置「预览兼容模式」显式回落同源
const SANDBOX_TOKEN = 'allow-scripts allow-forms allow-popups allow-modals'
// 兼容模式 = 移除 sandbox 属性（undefined 使 Vue 不渲染该属性，同源直挂回落）
const sandboxAttr = computed(() => (previewCompatMode.value ? undefined : SANDBOX_TOKEN))

// 最近端口记忆（localStorage；屏蔽存储的隐私模式下经 safeStorage 降级为会话内生效）
const RECENT_KEY = 'sc.previewPorts'
const MAX_RECENT = 5

function loadRecents(): number[] {
  try {
    const raw = safeStorage.getItem(RECENT_KEY)
    const arr: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr.filter((n): n is number => typeof n === 'number') : []
  } catch {
    return []
  }
}

const portInput = ref<number | null>(null)
const activePort = ref<number | null>(null)
// SSH 隧道徽标（P-20261004-5）：当前预览端口来自隧道映射时展示
// 「remote:N → local:M」——用户输的/直达的远端口 ≠ iframe 实打的隧道口
const activeTunnel = ref<{ remote: number; local: number } | null>(null)
// 手动刷新/切换端口时递增，强制 iframe 重载（切 tab 离开即销毁，回来经
// onMounted 会话恢复自动装载上次端口）
const iframeKey = ref(0)
const recents = ref<number[]>(loadRecents())

function rememberPort(p: number) {
  recents.value = [p, ...recents.value.filter(x => x !== p)].slice(0, MAX_RECENT)
  safeStorage.setItem(RECENT_KEY, JSON.stringify(recents.value))
}

const previewUrl = computed(() =>
  activePort.value === null ? '' : `/preview/${activePort.value}/`,
)

const portInvalid = computed(() =>
  portInput.value !== null && (portInput.value < 1024 || portInput.value > 65535),
)

// 加载态状态机：iframe 自身无加载反馈——dev server 冷启动十几秒纯白、端口未监听
// 时 iframe 里是代理层 502 裸错误，用户分不清「在启动」还是「没起对」。
// load 事件 + 超时双判据：
//   loading --(load 且非代理错误页)--> ok（摘除遮罩）
//   loading --(15s 超时，dev 冷启动宽容)--> unreachable（错误卡：重试/新窗口兜底）
// 切换端口/手动刷新/重试都回 loading 重新判定（两态重置）
const LOAD_TIMEOUT_MS = 15_000
type PreviewState = 'idle' | 'loading' | 'ok' | 'unreachable'
const state = ref<PreviewState>('idle')
const frameRef = ref<HTMLIFrameElement | null>(null)
let loadTimer: number | null = null

function disarmLoadTimer() {
  if (loadTimer !== null) {
    window.clearTimeout(loadTimer)
    loadTimer = null
  }
}

function startLoading() {
  state.value = 'loading'
  // 探活上报随页面重建重新收集：上一轮的受限提示不跨轮残留
  sandboxLimited.value = false
  disarmLoadTimer()
  loadTimer = window.setTimeout(() => {
    loadTimer = null
    // 仅加载态判超时：ok/unreachable 不回跳
    if (state.value === 'loading') state.value = 'unreachable'
  }, LOAD_TIMEOUT_MS)
}

// 代理层 502 落地页判定（双路径按沙箱姿态分流）：
//   兼容模式（同源直挂）：读 iframe contentDocument 找服务端 ErrorHandler 固定
//   文案（server/preview/preview.go ErrorHandler）——既有判定原样保留；
//   沙箱态（不透明源）：contentDocument 恒为 null（跨源不可读），改由父页面对
//   同一代理 URL 发起 fetch 探测——502 即「端口暂无响应」。读到 502 不算加载
//   成功，保持加载态继续等（冷启动宽容），直到超时转不可达
async function isProxyErrorPage(): Promise<boolean> {
  if (!previewCompatMode.value) {
    try {
      const res = await fetch(previewUrl.value, { cache: 'no-store' })
      // 只看状态码不消费体：立即释放连接，不给上游留半开读
      void res.body?.cancel()
      return res.status === 502
    } catch {
      return false // 网络层失败按非错误页处理，交由超时判不可达
    }
  }
  const frame = frameRef.value
  if (frame === null) return false
  let doc: Document | null
  try {
    doc = frame.contentDocument
  } catch {
    return false // 跨域文档（目标自行跳外域等）：必非代理错误页
  }
  if (doc === null || doc.URL === 'about:blank') return false
  const marker = `preview upstream 127.0.0.1:${activePort.value ?? ''} unreachable`
  return doc.documentElement?.textContent?.includes(marker) ?? false
}

async function frameLoaded() {
  if (state.value !== 'loading') return
  // 记住本轮代次：探测在途期间用户可能已切端口/刷新（iframeKey++），陈旧
  // 判定不得翻转新一轮加载的状态
  const gen = iframeKey.value
  if (await isProxyErrorPage()) return
  if (state.value !== 'loading' || gen !== iframeKey.value) return
  state.value = 'ok'
  disarmLoadTimer()
}

function open() {
  const p = portInput.value
  if (p === null || p < 1024 || p > 65535) return
  activePort.value = p
  // 手动输入/最近标签打开的都是本机端口：清掉上一条隧道徽标
  //（直达链随后按需重挂，见下方 watch）
  activeTunnel.value = null
  iframeKey.value++
  rememberPort(p)
  startLoading()
}

function openRecent(p: number) {
  portInput.value = p
  open()
}

function refresh() {
  if (activePort.value !== null) {
    iframeKey.value++
    startLoading()
  }
}

// 错误卡重试：同端口强制重载（服务可能此刻已就绪）
function retry() {
  if (activePort.value === null) return
  iframeKey.value++
  startLoading()
}

// 新窗口兜底：目标应用自带 CSP 等强约束时 iframe 可能仍拒绝渲染
function openNewWindow() {
  if (previewUrl.value) window.open(previewUrl.value, '_blank', 'noopener')
}

// ============== 沙箱态探活上报（P-20261019-1 ③） ==============
// 被预览页可经 postMessage 上报其在沙箱下的可用性（sc-preview-probe 协议：
// { type, ok }，ok=false = 页面自检到受限，如读不到同源存储）。收到失败上报
// 时挂非阻断提示条引导切兼容模式——普通 dev app 不实现该协议 = 无上报 = 零
// 打扰；实现了的页面（自检脚本/e2e 探针页）白屏前就有明确出路
const sandboxLimited = ref(false)

function onFrameMessage(e: MessageEvent) {
  // 只认当前 iframe 窗口发来的消息（任意子页面可 postMessage，source 核验防冒）
  if (e.source !== frameRef.value?.contentWindow) return
  const data = e.data as { type?: unknown; ok?: unknown } | null
  if (data === null || typeof data !== 'object' || data.type !== 'sc-preview-probe') return
  sandboxLimited.value = data.ok === false
}

onMounted(() => {
  window.addEventListener('message', onFrameMessage)
  // 沙箱姿态先于会话恢复装载就位（一次低频 GET）：避免兼容档用户的首轮
  // iframe 以沙箱姿态载入后再翻档重载（同源依赖型应用会闪一次失败面）
  void ensurePreviewCompatLoaded().then(() => {
    // 会话恢复：自动装载上次预览的端口——打开面板即见应用，免重复输入。
    // 同样走加载态：恢复的目标也可能是冷启动中的服务
    const last = recents.value[0]
    if (last !== undefined) {
      portInput.value = last
      activePort.value = last
      startLoading()
    }
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('message', onFrameMessage)
  disarmLoadTimer()
})

// 沙箱姿态翻转（设置页保存 / 他端 / agent 改档经 settings.changed 广播到达，
// usePreviewSandbox 镜像更新）：源语义切换必须整页重建——沙箱态载入的页面不
// 会因仅摘属性而获得同源权限，反之亦然
watch(previewCompatMode, () => {
  if (activePort.value !== null) {
    iframeKey.value++
    startLoading()
  }
})

// 预览端口直达（P-20261002-70）：agent 上报 / 悬浮球按钮 / 通知动作都经
// previewPort store 的 openPort 请求到达这里——复用 openRecent 既有输入链路
// （填输入框 → open() → activePort/iframeKey/最近端口记忆）。immediate 兜住
// 「面板尚未挂载时请求已到」的时序（tab 切换先挂载本组件再触发 watch）；
// 消费即清位，同端口的再次直达（服务重启重报跳过去重后/手动再点）可重触发
const previewPortStore = usePreviewPortStore()
watch(() => previewPortStore.openPort, (p) => {
  if (p === null) return
  openRecent(p)
  // 隧道直达（P-20261004-5）：交付载荷携带映射时挂徽标（iframe 打的
  // localPort，徽标回显用户口径的远端口）
  activeTunnel.value = previewPortStore.openTunnel
    ? { ...previewPortStore.openTunnel }
    : null
  previewPortStore.consumeOpen()
}, { immediate: true })
</script>

<template>
  <div class="preview-panel">
    <div class="preview-toolbar">
      <NInputNumber
        v-model:value="portInput"
        class="preview-port-input"
        size="tiny"
        :min="1024"
        :max="65535"
        :show-button="false"
        :placeholder="t('previewPanel.portPlaceholder')"
        :status="portInvalid ? 'error' : undefined"
        @keyup.enter="open"
      />
      <NButton
        size="tiny"
        type="primary"
        :disabled="portInvalid || portInput === null"
        @click="open"
      >
        {{ t('previewPanel.open') }}
      </NButton>
      <NButton
        size="tiny"
        quaternary
        :disabled="activePort === null"
        :title="t('previewPanel.refresh')"
        @click="refresh"
      >
        <template #icon>
          <NIcon><RefreshOutline /></NIcon>
        </template>
      </NButton>
      <NButton
        size="tiny"
        quaternary
        :disabled="activePort === null"
        :title="t('previewPanel.openNewWindow')"
        @click="openNewWindow"
      >
        <template #icon>
          <NIcon><OpenOutline /></NIcon>
        </template>
      </NButton>
      <span
        v-if="recents.length"
        class="preview-recent"
      >
        <span class="preview-recent-label">{{ t('previewPanel.recent') }}</span>
        <NTag
          v-for="p in recents"
          :key="p"
          size="small"
          round
          :type="p === activePort ? 'primary' : 'default'"
          :class="['preview-recent-tag', { 'preview-recent-tag--active': p === activePort }]"
          @click="openRecent(p)"
        >
          {{ p }}
        </NTag>
      </span>
      <!-- SSH 隧道徽标（P-20261004-5）：iframe 实打隧道口，回显用户口径的远端口 -->
      <NTag
        v-if="activeTunnel"
        size="small"
        round
        type="info"
        class="preview-tunnel-badge"
        :title="t('previewPanel.tunnelBadgeTip')"
      >
        {{ t('previewPanel.tunnelBadge', { remote: activeTunnel.remote, local: activeTunnel.local }) }}
      </NTag>
    </div>
    <div class="preview-body">
      <!-- 沙箱受限提示条（P-20261019-1 ③）：被预览页经 sc-preview-probe 上报
           ok=false 时挂出——引导切兼容模式，而非让用户对着白屏猜原因 -->
      <div
        v-if="sandboxLimited"
        class="preview-sandbox-hint"
        data-testid="preview-sandbox-hint"
      >
        <NIcon
          size="14"
          class="preview-sandbox-hint-icon"
        >
          <AlertCircleOutline />
        </NIcon>
        <span class="preview-sandbox-hint-text">{{ t('previewPanel.sandboxLimitedHint') }}</span>
        <button
          class="preview-sandbox-hint-close"
          :title="t('common.close')"
          :aria-label="t('common.close')"
          data-testid="preview-sandbox-hint-close"
          @click="sandboxLimited = false"
        >
          <NIcon size="12">
            <CloseOutline />
          </NIcon>
        </button>
      </div>
      <div class="preview-frame-area">
        <iframe
          v-if="previewUrl"
          ref="frameRef"
          :key="iframeKey"
          :src="previewUrl"
          :sandbox="sandboxAttr"
          class="preview-frame"
          :title="t('bottomPanel.preview')"
          @load="frameLoaded"
        />
        <NEmpty
          v-else
          class="preview-empty"
          :description="t('previewPanel.empty')"
        />
        <!-- 加载中：spinner 遮罩（盖住可能已落地的代理 502 裸错误，冷启动期间无白板） -->
        <div
          v-if="state === 'loading'"
          class="preview-state preview-state--loading"
        >
          <NSpin size="small" />
          <span class="preview-state-text">{{ t('preview.state.waiting', { port: activePort }) }}</span>
        </div>
        <!-- 不可达：错误卡（重试复用 iframeKey 强制重载 + 新窗口兜底前置露出） -->
        <div
          v-else-if="state === 'unreachable'"
          class="preview-state preview-state--error"
        >
          <NIcon
            size="30"
            class="preview-state-icon"
          >
            <AlertCircleOutline />
          </NIcon>
          <span class="preview-state-title">{{ t('preview.state.unreachable', { port: activePort }) }}</span>
          <span class="preview-state-hint">{{ t('preview.state.hint') }}</span>
          <div class="preview-state-actions">
            <NButton
              size="tiny"
              type="primary"
              @click="retry"
            >
              {{ t('preview.state.retry') }}
            </NButton>
            <NButton
              size="tiny"
              quaternary
              @click="openNewWindow"
            >
              {{ t('previewPanel.openNewWindow') }}
            </NButton>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.preview-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--bg-border);
  flex-shrink: 0;
}
.preview-port-input {
  width: 150px;
}
.preview-recent {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: 8px;
  overflow: hidden;
}
.preview-recent-label {
  font-size: 11px;
  color: var(--text-secondary);
  flex-shrink: 0;
}
.preview-recent-tag {
  cursor: pointer;
  flex-shrink: 0;
}
.preview-tunnel-badge {
  flex-shrink: 0;
}
.preview-body {
  flex: 1;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
/* iframe 装载区：提示条挂出时占其下剩余高度（遮罩层的定位宿主随行内移） */
.preview-frame-area {
  flex: 1;
  overflow: hidden;
  display: flex;
  position: relative;
}
.preview-sandbox-hint {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  font-size: 12px;
  border-bottom: 1px solid var(--bg-border);
  background: var(--bg-panel);
}
.preview-sandbox-hint-icon {
  color: var(--accent-orange);
  flex-shrink: 0;
}
.preview-sandbox-hint-text {
  color: var(--text-secondary);
  min-width: 0;
}
.preview-sandbox-hint-close {
  margin-left: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
}
.preview-sandbox-hint-close:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}
.preview-frame {
  flex: 1;
  border: 0;
  /* iframe 加载/透明页衬底随主题（原 #fff 在深色主题下白闪） */
  background: var(--bg-primary);
}
.preview-empty {
  margin: auto;
}
/* 两态遮罩：不透明面板底色（盖住 iframe 里的代理 502 裸错误/白板），居中卡片式 */
.preview-state {
  position: absolute;
  inset: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  background: var(--bg-panel);
}
.preview-state-text {
  font-size: 12px;
  color: var(--text-secondary);
}
.preview-state--error .preview-state-title {
  font-size: 13px;
  color: var(--text-primary);
}
.preview-state--error .preview-state-hint {
  font-size: 12px;
  color: var(--text-secondary);
}
.preview-state-icon {
  color: var(--text-muted);
}
.preview-state-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
</style>
