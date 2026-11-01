<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NCheckbox, NIcon, NInput, NSpin, NModal, useMessage } from 'naive-ui'
import { CloudUploadOutline, ContractOutline, ExpandOutline, LockClosedOutline, LockOpenOutline, RefreshOutline, SearchOutline, TrashOutline } from '@vicons/ionicons5'
import { useFontStore } from '../../stores/font'
import { useKeymapStore } from '../../stores/keymap'
import { useTerminalThemeStore } from '../../stores/terminal-theme'
import { useTerminalSessionsStore } from '../../stores/terminal-sessions'
import { useI18n } from '../../composables/useI18n'
import { termInstances, safeFit } from '../../composables/useTerminalInstances'
import { terminalLru } from '../../composables/terminalLru'
import { useTerminalClipboard, writeClipboard, isCopyOnSelectEnabled } from '../../composables/useTerminalClipboard'
import { useTerminalSearch } from '../../composables/useTerminalSearch'
import { useTerminalDnd } from '../../composables/useTerminalDnd'
import { useTerminalSession, terminalHasReceivedOutput, type OscEvent } from '../../composables/useTerminalSession'
import {
  bindDangerGateUi, confirmDangerGate, cancelDangerGate,
  interceptTerminalInput, dangerCard, type DangerGateCardState,
} from '../../composables/useTerminalDangerGate'
import { impactOf } from '../../utils/commandRisk'
import { terminalApi, type TerminalRiskMatch } from '../../api/domains/terminal'
import { forceTerminalScrollResync } from '../../utils/terminalScrollResync'
import { hasBlockingOverlay } from '../../utils/overlayGuard'
import { flattenSelectionForPaste } from '../../utils/selectionDrag'
import './terminal-pane.css'

// 单个终端会话的渲染面板：xterm 实例 + WS 连接 + 搜索/剪贴板/拖拽接线。
// 从 TerminalView.vue 抽取——项目终端（TerminalView 多 tab 编排）与
// 远程控制台（Batch 2）共用；tab/split/AI 助手等宿主编排留在宿主组件。

const props = withDefaults(
  defineProps<{
    /**
     * 会话标识（同时是共享 termInstances Map 的 key）。
     * 实例级稳定假设：宿主须用 :key="sessionId" 保证组件随会话重建——
     * 运行期修改本 prop 不会触发断开重连
     */
    sessionId: string
    /** WS 地址构造：项目终端传 getTerminalWsUrl，远程终端传远程版 */
    wsUrlFactory: (sessionId: string) => string
    /**
     * 粘贴上传策略：返回贴入终端的路径文本；null=上传未成功。
     * kind=image 截图压缩链 / kind=file 白名单文件链（P-20261024-2）
     */
    uploadPaste?: (file: File, kind: 'image' | 'file') => Promise<string | null>
    /** OSC 133 事件外抛（C=命令开始 / D=命令结束带退出码时长；E 通道预留） */
    oscHook?: (event: OscEvent, sessionId: string) => void
    /**
     * PTY resize 上报：项目终端传 terminalApi.resize 等价实现，远程终端传各自实现。
     * 未传时终端仅本地重排（不同步 PTY 列宽）
     */
    resizeCall?: (id: string, rows: number, cols: number, silent?: boolean) => void
    /** 是否活跃 pane（split 模式驱动 is-active-pane 高亮） */
    active?: boolean
    /** scrollback 行数（宿主从 settings 读出后传入） */
    scrollbackLines?: number
    /** 宿主已判定会话终态（远程 tab ended 等）：隐藏 pane 级断开/失败浮层，由宿主渲染重开入口 */
    ended?: boolean
    /**
     * 显示失步权威重绘（tmux refresh-client，native 后端服务端 no-op）：
     * pane 重新可见 / 宿主显式 fit 后调用，以 tmux 网格为事实源重发整屏，
     * 治愈切换/最大化后的一过性错乱与滚轮失灵。未传 = 不重绘
     */
    redrawCall?: (id: string) => void
    /** pane 临时最大化可用（P-20261004-64）：宿主处于 split 双 pane 时为真，
     *  角部显示最大化 toggle 按钮（单 pane 最大化无意义不提供） */
    maximizable?: boolean
    /** 本 pane 是否处于临时最大化态（按钮切还原图标 + 根元素弱提示描边） */
    maximized?: boolean
    /**
     * 键盘切换 pane（P-20261004-111）：按键 pane 所在 tab 分屏双 pane 互切
     * （Ctrl+Alt+-，编辑器组 focusOtherGroup 对称）。函数 prop 而非 emit——
     * 键位拦截与否取决于宿主是否完成切换（单 pane 返回 false 放行 PTY），
     * 布尔回程走不了 emit 链；未传 = 键位放行（远程终端等无 split 宿主）
     */
    focusOtherPane?: (sessionId: string) => boolean
    /**
     * 输入域历史采集缝（P-20261005-188，可选）：onData 收口写入 WS 前截获
     * 按键流（observe-only）。仅远程终端宿主注入（无 shell integration 域的
     * 采集退路）；项目终端不传——走 OSC 133 输出侧精确域，零开销
     */
    inputTap?: (sessionId: string, data: string) => void
  }>(),
  { active: true, scrollbackLines: 20000, maximizable: false, maximized: false },
)

const emit = defineEmits<{
  /** 底层会话退出（重连预算耗尽）。宿主可选绑定，未绑定=旧行为（不关 tab） */
  (e: 'exit', sessionId: string): void
  (e: 'activate'): void
  /** bufferLine = 右键命中的缓冲行（P-20261004-16 标记此行的目标行），解析失败缺省 */
  (e: 'contextmenu', ev: MouseEvent, bufferLine?: number): void
  (e: 'split-horizontal'): void
  (e: 'split-vertical'): void
  (e: 'close-pane'): void
  /** pane 临时最大化 toggle（P-20261004-64）：状态在 usePanelLayout 模块单例
   *  （Esc 退栈链共用同源），宿主转调 toggleTerminalPaneMaximized */
  (e: 'toggle-maximize'): void
  (e: 'switch-tab', delta: number): void
  (e: 'switch-to-tab', index: number): void
}>()

const { t } = useI18n()
const fontStore = useFontStore()
// 终端域键位生效表（P-20261003-111）：xterm 拦截链按键现场读取，改绑即时生效
const keymapStore = useKeymapStore()
const terminalThemeStore = useTerminalThemeStore()
const message = useMessage()

// ============== 终端主题 effects（驱动根元素 data-effects-* 属性） ==============
// 把 effects 字段一次性摊平为 v-bind 对象（从 TerminalView 移入）
const termPaneEffects = computed<Record<string, string>>(() => {
  const fx = terminalThemeStore.currentThemeDef.effects ?? {}
  return {
    'data-effects-scanline': fx.scanline ?? 'none',
    'data-effects-text-glow': fx.textGlow ?? 'none',
    'data-effects-cursor-glow': fx.cursorGlow ?? 'none',
    'data-effects-corner': fx.cornerBrackets ? 'true' : 'false',
    'data-effects-vignette': fx.vignette ? 'true' : 'false',
    'data-effects-starfield': fx.starfield ? 'true' : 'false',
    'data-effects-ambient': fx.ambientGlow ? 'true' : 'false',
    '--term-ambient': typeof fx.ambientGlow === 'string' ? fx.ambientGlow : 'transparent',
  }
})

// 容器背景跟随终端主题背景色：xterm-viewport 透明化后（见 terminal-pane.css），
// fit 行取整的底部零头高度由容器兜底，主题切换瞬间同色不露黑边
const themeBackground = computed(() => terminalThemeStore.currentThemeDef.colors.background)

// ============== 面板内 UI composable（以本 pane 的 sessionId 为目标） ==============
const getSelfId = () => props.sessionId

const clipApi = useTerminalClipboard({
  termInstances,
  // 粘贴上传策略注入（项目终端由 TerminalView 传项目版实现）
  uploadPaste: (file, kind) =>
    props.uploadPaste ? props.uploadPaste(file, kind) : Promise.resolve(null),
})

// ============== 窗格只读观察锁（P-20261003-91） ==============
// 旁观/演示场景防误触：锁定时键盘与粘贴输入不写 WS（PTY 无回滚，误键入直接污染
// agent 输入流）。会话内 transient 状态——不持久化、默认关，pane 卸载（会话关闭/
// 页面刷新）即复位。输出方向与选区/复制完全不受影响（只锁输入不锁选择）
// 默认态按会话来源分流（P-20261005-189）：外部接管会话默认锁定——服务器遗留
// 会话常挂着重任务（构建/训练），误键入直接打进运行中的进程；用户主动解锁才
// 可写（默认只读接管）。transient 语义不变：解锁后刷新复位回按来源的默认态
const sessionsStore = useTerminalSessionsStore()
const inputLocked = ref(
  sessionsStore.sessions.find(s => s.id === props.sessionId)?.origin === 'external',
)
// 服务端只读闸同步面（P-20261008-17）：接管会话（origin=external）的锁不只
// 是 pane UI——服务端有同语义闸（Session.serverReadOnly，WS 写链入口拒绝），
// 锁/解锁动作须同步翻转，否则「前端已解锁、服务端逐键拒绝」或「前端锁了、
// agent 直调 WS 照写」。自建会话闸不存在（锁者即会话主人，纯防误触 UI），
// 不调端点
const isExternalSession = computed(
  () => sessionsStore.sessions.find(s => s.id === props.sessionId)?.origin === 'external',
)
// 同步失败告警去重：连点/多 pane 同会话不刷屏（4s 一条）
let lastLockSyncWarnAt = 0
async function toggleInputLock(): Promise<void> {
  const next = !inputLocked.value
  if (!isExternalSession.value) {
    inputLocked.value = next
    return
  }
  if (next) {
    // 加锁方向：本地先落地（用户保护即时生效），服务端异步跟随——失败降级
    // 为旧的「仅前端锁」形态并告警，不回滚（回滚等于把刚锁上的用户重新暴露）
    inputLocked.value = true
    try {
      await terminalApi.setInputLock(props.sessionId, true)
    } catch {
      const now = Date.now()
      if (now - lastLockSyncWarnAt > 4000) {
        lastLockSyncWarnAt = now
        message.warning(t('terminal.inputLock.syncFailed'))
      }
    }
    return
  }
  // 解锁方向：服务端闸先翻转成功才放开本地输入（服务端先行消除时序窗口——
  // 若本地先解锁，窗口期键入会被服务端 readonly_external 逐键拒绝）；失败
  // 回滚保持锁定，用户重试即可
  try {
    await terminalApi.setInputLock(props.sessionId, false)
    inputLocked.value = false
  } catch {
    message.error(t('terminal.inputLock.syncFailed'))
  }
}
// 粘贴入口守卫（Ctrl/Cmd+Shift+V 与右键粘贴共用）：锁定时明确告知而非静默无效；
// 底层硬闸在 useTerminalSession 的 onData 收口（键盘/拖拽/图片粘贴路径全被吞）
function guardedPasteFromClipboard(sessionId: string): void {
  if (inputLocked.value) {
    message.warning(t('terminal.inputLock.blockedPaste'))
    return
  }
  void clipApi.pasteFromClipboard(sessionId)
}

// ============== 高危命令影响面闸门（P-20261005-191） ==============
// UI 绑定（toast/i18n 模块单例消费）+ onData 收口的预检注入 + 确认卡渲染。
// 卡片状态模块共享：show 只在 state.sessionId 归属的 pane 上为真，多 pane
// 共享一张卡。danger 命中走 error 档红色、warning 走 warning 档
bindDangerGateUi({ message, t })
// v-model:show 可写计算属性：X/ESC 等旁路关闭统一落地为取消（confirm 先行
// 消费过裁决时 cardResolve 已空，二次 cancel 是 no-op——双路安全）
const gateVisible = computed<boolean>({
  get: () => (dangerCard as DangerGateCardState).show && dangerCard.sessionId === props.sessionId,
  set: (v: boolean) => {
    if (!v) cancelDangerGate()
  },
})
// 影响面行文案（params 可缺席，t 的重载要求第二参必传——在此收口）
function impactText(m: TerminalRiskMatch): string {
  const d = impactOf(m)
  return d.params ? t(d.key, d.params) : t(d.key)
}
function sendRawToSession(sessionId: string, raw: string): void {
  const inst = termInstances.get(sessionId)
  if (inst && inst.ws.readyState === WebSocket.OPEN) inst.ws.send(raw)
}

const searchApi = useTerminalSearch({
  termInstances,
  getActiveTabId: getSelfId,
})

const dndApi = useTerminalDnd({
  termInstances,
  getActiveTabId: getSelfId,
})

// ============== 会话连接生命周期 ==============
const containerRef = ref<HTMLElement | null>(null)
// v-show 重显自愈观察器（挂载时创建，卸载时断开）
let visibilityHealer: IntersectionObserver | null = null
// pane 可见性（P-20261004-46）：宿主全部用 v-show 保活 tab（切走不卸载），隐藏
// pane 的输出帧在写入路径入有界延迟队列，重见时立即重放。IO 首次回调前按可见
// 处理（fail-open = 旧直写行为）；IO 只在阈值跨越时 fire，v-show display 切换
// 必触发（含底部面板折叠 / 浏览器窗口最小化等祖先级隐藏）
const paneVisible = ref(true)

const session = useTerminalSession({
  sessionId: props.sessionId,
  wsUrlFactory: (id) => props.wsUrlFactory(id),
  getFontSize: () => fontStore.terminalFontSize,
  getScrollbackLines: () => props.scrollbackLines,
  oscHook: (event, id) => props.oscHook?.(event, id),
  onExit: (id) => emit('exit', id),
  onSearchOpen: searchApi.openSearch,
  onCopySelection: clipApi.copySelectionToClipboard,
  onPaste: guardedPasteFromClipboard,
  onContextMenu: (_id, e, bufferLine) => emit('contextmenu', e, bufferLine),
  // tab 编排快捷键透传给宿主（未绑定时不拦截）
  onSplitHorizontal: () => emit('split-horizontal'),
  onSplitVertical: () => emit('split-vertical'),
  onClosePane: () => emit('close-pane'),
  onSwitchTab: (delta) => emit('switch-tab', delta),
  onSwitchToTab: (index) => emit('switch-to-tab', index),
  // pane 焦点切换（P-20261004-111）：宿主函数 prop 裁决（true=已切换拦截键位，
  // false/未传=放行 PTY）
  onFocusOtherPane: (id) => props.focusOtherPane?.(id) ?? false,
  // 终端域键位生效值（P-20261003-111）：按键现场读 keymap store，改绑即时生效
  comboOf: (action) => keymapStore.combos[action],
  attachNativePaste: clipApi.attachNativePaste,
  // resize 上报注入（未传 prop 时为 no-op：仅本地重排）
  resizeCall: (id, rows, cols, silent) => props.resizeCall?.(id, rows, cols, silent),
  // 只读观察锁（P-20261003-91）：onData 硬闸现场读取，切换即时生效
  isInputLocked: () => inputLocked.value,
  // 写链路背压风暴落定自愈的权威重绘（P-20261004-47）：与可见性自愈同一条
  // redrawCall——tmux 会话 refresh-client 重发整屏，native 服务端 no-op
  redrawCall: (id) => props.redrawCall?.(id),
  // 隐藏 pane 写入延迟（P-20261004-46）：现场读 IO 跟踪的可见性，切换即时生效
  isVisible: () => paneVisible.value,
  // 高危命令粘贴预检（P-20261005-191）：onData 收口处命中预筛的 chunk 由闸门
  // 接管（确认卡裁决后才发送），未命中走既有直发
  inputGate: (id, data) => interceptTerminalInput(id, data, (raw) => sendRawToSession(id, raw)),
  // 输入域历史采集（P-20261005-188）：远程宿主注入，写入 WS 前截获按键流
  inputTap: (id, data) => props.inputTap?.(id, data),
})

onMounted(() => {
  if (containerRef.value) session.connect(containerRef.value)
  attachCopyOnSelect()
  // 自愈（xterm v6 滚动区同步）：keep-alive pane 被 v-show 重新显示时容器尺寸
  // 不变、ResizeObserver 不触发，滚动区与重放 buffer 失同步（滚轮上翻失灵，
  // 任意按键后自愈）。IntersectionObserver 感知可见性变化，双 RAF 等 layout
  // 稳定后 fit + refresh + 行数抖动强制滚动区重同步——通用自愈点，覆盖底部
  // 面板/管理页/远程控制台所有宿主
  visibilityHealer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      // 可见性先记账再自愈：翻转瞬间起写入路径即按新状态分流
      paneVisible.value = entry.isIntersecting
      // LRU 记账（P-20261007-21）：可见=激活（刷新最近使用并执行预算，可能
      // 驱逐其他最久未用的隐藏实例）；隐藏=成为可驱逐候选（预算在挂载期
      // fail-open 可见窗错过收敛的在此补齐）
      terminalLru.setVisible(props.sessionId, entry.isIntersecting)
      if (!entry.isIntersecting) continue
      // LRU 驱逐恢复（P-20261007-21）：重见时实例不在场（已被预算释放），
      // 走 connect 重建——makeTerminalWs + 服务端 scrollback 重放，与网络
      // 断线重连同码路径；重放期短暂空白 + connecting spinner 既有语义
      if (containerRef.value && !termInstances.get(props.sessionId)) {
        session.connect(containerRef.value)
      }
      // 隐藏期间积压的输出帧先重放落屏（P-20261004-46）：挂写链尾与在途消息
      // 串行，随后的 fit/refresh/权威重绘自愈链照常——重放字节经 xterm 自身
      // 渲染管线出画，与自愈无竞态
      session.flushPendingWrites()
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const inst = termInstances.get(props.sessionId)
          if (!inst || !containerRef.value) return
          safeFit(inst.fit, containerRef.value)
          try {
            inst.term.refresh(0, Math.max(inst.term.rows - 1, 0))
          } catch { /* ignore */ }
          // 滚动区重同步：可见性恢复不会触发尺寸重算（FitAddon 同尺寸空转、
          // refresh 只重绘行），抖动 resize 是与窗口 resize 等效的编程自愈
          forceTerminalScrollResync(inst.term)
          // 权威重绘收尾：本地 buffer refresh 只能修渲染层失步，tmux 会话的
          // 服务端网格才是事实源——隐藏期间的会话输出、历史 resize 竞态残留
          // 都由 refresh-client 重发整屏治愈（native 后端服务端 no-op）
          props.redrawCall?.(props.sessionId)
        })
      })
    }
  }, { threshold: 0.01 })
  if (containerRef.value) visibilityHealer.observe(containerRef.value)
})

onBeforeUnmount(() => {
  session.dispose()
  visibilityHealer?.disconnect()
  visibilityHealer = null
  if (containerRef.value) containerRef.value.removeEventListener('mouseup', onPaneMouseUp)
})

// ============== 选中即复制（copy-on-select，全终端宿主统一） ==============
// 左键松开且存在选区时静默写入剪贴板：不清选区（保留高亮）、不弹 toast（连选会刷屏）。
// claude code 等开启鼠标上报的 TUI 里 xterm 不产生选区（鼠标事件转发给应用），
// hasSelection 恒为 false，天然不干扰应用自身的选中/复制能力。
// 开关每次 mouseup 现读（isCopyOnSelectEnabled），设置页切换后所有 pane 即时生效
function onPaneMouseUp(e: MouseEvent): void {
  if (e.button !== 0) return
  if (!isCopyOnSelectEnabled()) return
  const sid = props.sessionId
  // xterm v6 在 document 级监听 mouseup(拖选出界也能收尾),选区定稿晚于容器
  // 冒泡——当场查 hasSelection 恒为假,选中即复制从未触发。延后一拍等 xterm
  // 收尾完成再读选区(macrotask 晚于同一次事件派发内的所有监听器)
  window.setTimeout(() => {
    const inst = termInstances.get(sid)
    if (!inst || !inst.term.hasSelection()) return
    void writeClipboard(inst.term.getSelection())
  }, 0)
}
function attachCopyOnSelect(): void {
  if (!containerRef.value) return
  containerRef.value.addEventListener('mouseup', onPaneMouseUp)
}

// ============== Ctrl/Cmd+滚轮 字号手势（对标编辑器 Monaco 的缩放手感） ==============
// 经 fontStore.stepTerminalSize 改全局终端字号（与设置页滑条/字号快捷键同源联动），
// 随动 fit 由本组件与 useTerminalInstances 的字号 watch 天然承接。
// capture 相位先于 xterm 的 wheel 处理器截胡：preventDefault 抑制浏览器页面缩放，
// stopPropagation 让 xterm 不在缩放时连带滚动缓冲区；无修饰滚轮直接放行
// （原生滚动/鼠标上报不动）；触控板双指捏合（浏览器合成 ctrlKey wheel）自然同路。
function onPaneWheelZoom(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  e.stopPropagation()
  fontStore.stepTerminalSize(e.deltaY < 0 ? 1 : -1)
}

// ============== 字号 / 主题同步（本 pane 自治，脱离 TerminalView 也可用） ==============
// 注：TerminalView 的 useTerminalInstances 也有同名 watch（遍历全 Map），
// 双写同值幂等无副作用——保留两处是为让 Pane 单独复用时行为完整
watch(
  () => fontStore.terminalFontSize,
  (size) => {
    const inst = termInstances.get(props.sessionId)
    if (!inst) return
    inst.term.options.fontSize = size
    // 字号变化 = 字形度量变化：随动 fit 重算列行数（与字族切换同语义）
    if (containerRef.value) safeFit(inst.fit, containerRef.value)
  },
)
watch(
  () => terminalThemeStore.currentThemeName,
  () => {
    const inst = termInstances.get(props.sessionId)
    if (inst) inst.term.options.theme = terminalThemeStore.currentThemeDef.colors
  },
)
// 字体切换（与 useTerminalInstances 的全实例 watch 双写同值幂等）：随动 fit。
// 监听 currentFontStack（P-20261005-227 同全局 watch 改源）：自定义等宽字体名
// 前插段变化不经 currentFont 枚举，监听栈本身才随动
watch(
  () => terminalThemeStore.currentFontStack,
  () => {
    const inst = termInstances.get(props.sessionId)
    if (!inst || !containerRef.value) return
    inst.term.options.fontFamily = terminalThemeStore.currentFontStack
    safeFit(inst.fit, containerRef.value)
  },
)
// 光标偏好（P-20261005-212，与 useTerminalInstances 的全实例 watch 双写同值幂等）：
// 运行中会话即时生效；不改字形度量，无需随动 fit
watch(
  () => [fontStore.cursorStyle, fontStore.cursorBlink] as const,
  ([style, blink]) => {
    const inst = termInstances.get(props.sessionId)
    if (!inst) return
    inst.term.options.cursorStyle = style
    inst.term.options.cursorBlink = blink
  },
)

// ============== 对宿主暴露的方法（defineExpose 契约） ==============

/** 向终端发送一段原始输入（WS 已连接才发送，返回是否成功）——AI 助手插入命令等场景 */
function writeInput(data: string): boolean {
  const inst = termInstances.get(props.sessionId)
  if (inst && inst.ws.readyState === WebSocket.OPEN) {
    inst.ws.send(data)
    return true
  }
  return false
}

/**
 * 把一段文本追加到会话输入行（P-20261003-162 选区拖拽落点）——语义 = 粘贴，
 * **不发 Enter**（不自动发送）。多行文本走 xterm 的括号粘贴（DEC 2004，
 * agent TUI/readline 常态开启）：换行只留在编辑缓冲里。会话未启用括号粘贴时
 * PTY 会把换行当提交立即执行，故降级为单行（utils/selectionDrag
 * flattenSelectionForPaste）——宁可牺牲排版也不打破「只追加不发送」承诺。
 * 返回 multi=多行原文写入 / single=已压单行 / null=终端实例未就绪。
 */
function insertText(text: string): 'multi' | 'single' | null {
  const inst = termInstances.get(props.sessionId)
  if (!inst) return null
  const bracketed = inst.term.modes.bracketedPasteMode
  const payload = bracketed ? text : flattenSelectionForPaste(text)
  if (!payload) return null
  inst.term.paste(payload)
  inst.term.focus()
  return bracketed ? 'multi' : 'single'
}

/** fit + 聚焦（selectTab / setActivePane / 刷新显示的同款语义） */
function focus(): void {
  const inst = termInstances.get(props.sessionId)
  if (!inst || !containerRef.value) return
  safeFit(inst.fit, containerRef.value)
  inst.term.focus()
}

/** 清屏 + 聚焦（工具栏「清空」） */
function clear(): void {
  const inst = termInstances.get(props.sessionId)
  if (!inst) return
  inst.term.clear()
  inst.term.focus()
}

/** fit（split divider 拖拽 / 最大化切换 / 面板重新可见后由宿主编排调用；
 *  deep=true 为深度刷新：右键「刷新」/重绘按钮/visibility 自愈等用户意图的
 *  治愈时刻，额外强制滚动区重同步）。
 *  fit 后强制 refresh：面板隐藏期间（v-show display:none）连接的会话重放
 *  scrollback 时 xterm v6 滚动条尺寸不同步，重开面板后滚轮失灵——refresh
 *  触发渲染管线重绘行。
 *  但 refresh 只重绘行、不重算滚动区尺寸（v6 Viewport._sync 只由真实 resize/
 *  buffer 激活/新输出驱动），所以治愈滚轮上翻失效靠 deep 的行数抖动 resize：
 *  与拖窗口/F12 走完全相同的重算链路，详见 forceTerminalScrollResync。
 *  可见时随后触发权威重绘（tmux refresh-client）：最大化/还原尺寸抖动期间
 *  的失步由服务端网格重发整屏统一治愈 */
function fit(deep = false): void {
  const inst = termInstances.get(props.sessionId)
  if (!inst || !containerRef.value) return
  safeFit(inst.fit, containerRef.value)
  try {
    inst.term.refresh(0, Math.max(inst.term.rows - 1, 0))
  } catch { /* ignore */ }
  if (deep) forceTerminalScrollResync(inst.term)
  const r = containerRef.value.getBoundingClientRect()
  if (r.width > 0 && r.height > 0) props.redrawCall?.(props.sessionId)
}

/** 导出 buffer 纯文本（复制全部 / 导出文件用） */
function exportBuffer(): string {
  return clipApi.extractBufferText(props.sessionId)
}

/** 复制选区到剪贴板（右键菜单） */
function copySelection(): void {
  void clipApi.copySelectionToClipboard(props.sessionId)
}

/** 复制全部 scrollback（工具栏 / 右键菜单） */
function copyAll(): void {
  void clipApi.copyAllToClipboard(props.sessionId)
}

/** 复制上一条命令输出（右键菜单）：OSC 133 C/D 行号记账区间提取 */
function copyLastOutput(): void {
  void clipApi.copyLastCommandOutputToClipboard(props.sessionId)
}

/** 复制选区为代码块（右键菜单，P-20261003-270）：```bash 围栏 + 命令行头 */
function copyAsCodeBlock(): void {
  void clipApi.copySelectionAsCodeBlock(props.sessionId)
}

/** 从剪贴板粘贴（图片优先 + 多行警告管线，右键菜单）：只读锁定期拦截并提示 */
function pasteFromClipboard(): void {
  guardedPasteFromClipboard(props.sessionId)
}

/** 导出为 .txt 下载（工具栏 / 右键菜单） */
function exportAsText(name: string): void {
  clipApi.exportAsText(props.sessionId, name)
}

/** 选区长度（右键菜单「复制」按钮 enable/disable 依据） */
function getSelectionLength(): number {
  const inst = termInstances.get(props.sessionId)
  if (!inst) return 0
  const sel = inst.term.getSelection()
  return sel ? sel.length : 0
}

defineExpose({
  writeInput,
  // 选区拖拽追加（P-20261003-162）：语义=粘贴不回车，见函数头注
  insertText,
  focus,
  clear,
  fit,
  exportBuffer,
  exportAsText,
  copySelection,
  copyAsCodeBlock,
  copyAll,
  copyLastOutput,
  pasteFromClipboard,
  getSelectionLength,
  // 该会话是否收到过服务端输出（远程控制台「SFTP 无 shell」延迟提示的判定依据）
  hasReceivedOutput: () => terminalHasReceivedOutput(props.sessionId),
  disconnect: session.disconnect,
  reconnect: session.reconnect,
})

// ============== 模板直用解构 ==============
const {
  showSearch, searchQuery, searchCaseSensitive, searchRegex, searchInputRef,
  searchResultCount, searchNoResult,
  runSearch, closeSearch, toggleSearchOption, onQueryInput,
  historyVisible, historyItems, historyAllFilteredOut,
  onSearchInputFocus, onSearchInputBlur, closeHistoryDropdown, onClearHistory,
  applyHistory, onSearchEscape, commitSearch,
} = searchApi

// 搜索条开着的窗级 Esc 兜底（捕获相位）：焦点在搜索输入框时由 @keyup.escape
// 分层收口；焦点漂出输入框（点选历史项后 headless 指针焦点链漂移 body / 点击
// 面板其他区域）时 Esc 会落 body 被布局级退链吃掉——底部面板连搜索条一起收掉。
// 仅「条开着 + 焦点不在任何输入框」时接管：输入框聚焦（搜索框/命令面板等其它
// 输入面）完全让位，naive 弹层在场同样让位（hasBlockingOverlay 既有守卫）；
// 分层语义与输入框链同款：下拉开着先收下拉，再按才关条。非活跃 pane 不接管
// （活跃 pane 的搜索条优先，其余 pane 的条留待下一次 Esc）
function onWindowEscKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.defaultPrevented) return
  if (!props.active) return
  const tag = (e.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (hasBlockingOverlay()) return
  e.preventDefault()
  e.stopPropagation()
  if (historyVisible.value) closeHistoryDropdown()
  else closeSearch()
}
watch(showSearch, (open) => {
  if (open) window.addEventListener('keydown', onWindowEscKeydown, true)
  else window.removeEventListener('keydown', onWindowEscKeydown, true)
})
onBeforeUnmount(() => window.removeEventListener('keydown', onWindowEscKeydown, true))

const {
  pasteMultilineNoWarn, showPasteWarn,
  pendingPasteLarge, pendingPasteKb,
  pastePreviewLines, pastePreviewLineCount,
  confirmPasteMultiline, cancelPasteMultiline,
} = clipApi

const {
  dragOverActive, dragOverFileCount, dragOverIsPath,
  onTerminalDragOver, onTerminalDragLeave, onTerminalDrop,
} = dndApi
</script>

<template>
  <div
    ref="containerRef"
    class="term-container term-pane"
    :class="{ 'is-active-pane': props.active, 'is-input-locked': inputLocked, 'is-pane-maximized': props.maximized }"
    :style="{ background: themeBackground }"
    v-bind="termPaneEffects"
    @click="emit('activate')"
    @wheel.capture="onPaneWheelZoom"
    @dragover.prevent="onTerminalDragOver"
    @dragleave.prevent="onTerminalDragLeave"
    @drop.prevent="onTerminalDrop"
  >
    <!-- pane 临时最大化 toggle（P-20261004-64，锁按钮左侧同行）：split 双 pane
         对照时暂占全幅看一侧（兄弟 pane v-show 隐藏、会话不断），再点/Esc 还原。
         最大化态常显（搜索框打开时让位规则对还原入口豁免——还原路径不可断） -->
    <button
      v-if="props.maximizable && (!showSearch || props.maximized)"
      class="term-pane-maximize"
      :title="props.maximized ? t('terminal.restorePane') : t('terminal.maximizePane')"
      :aria-pressed="props.maximized"
      data-testid="term-pane-maximize"
      @click.stop.prevent="emit('toggle-maximize')"
    >
      <n-icon size="13">
        <ContractOutline v-if="props.maximized" />
        <ExpandOutline v-else />
      </n-icon>
    </button>
    <!-- 窗格只读观察锁（P-20261003-91）：pane 右上角角标，锁定时键盘/粘贴输入
         不写 WS（旁观/演示防误触），复制/选择不受影响。锁定态常显警示色 + 容器
         描边提示；搜索框打开时锁定态仍保留角标（状态不可见即失效），未锁定则让位 -->
    <button
      v-if="!showSearch || inputLocked"
      class="term-pane-lock"
      :class="{ 'is-locked': inputLocked }"
      :title="inputLocked ? t('terminal.inputLock.on') : t('terminal.inputLock.off')"
      :aria-pressed="inputLocked"
      data-testid="term-pane-input-lock"
      @click.stop.prevent="toggleInputLock"
    >
      <n-icon size="13">
        <LockClosedOutline v-if="inputLocked" />
        <LockOpenOutline v-else />
      </n-icon>
    </button>
    <!-- 按当前窗口尺寸重绘（右上角小按钮，全终端宿主通用——项目终端/会话管理页
         悬浮窗/远程终端同源复用本组件自动获得）：fit(true) 深度刷新 = fit 重算行列
         + xterm 滚动区 refresh + 行数抖动强制滚动区重同步 + tmux 权威重绘，
         滚轮上翻失灵/显示错乱的一键自愈入口。搜索框打开时让位（同占右上角） -->
    <button
      v-if="!showSearch"
      class="term-pane-refresh"
      :title="t('terminal.redraw')"
      @click.stop.prevent="fit(true)"
    >
      <n-icon size="13">
        <RefreshOutline />
      </n-icon>
    </button>
    <div
      v-if="session.connecting.value"
      class="term-pane-loading"
    >
      <n-spin size="small" />
    </div>
    <!-- 后端不可用提示：WS 重连超限时显示，点击重试 -->
    <div
      v-if="session.failed.value && !props.ended"
      class="term-pane-error"
    >
      <div class="term-pane-error-icon">
        ⚠
      </div>
      <div class="term-pane-error-text">
        {{ t('terminal.backendUnavailable') }}
      </div>
      <n-button
        size="small"
        type="primary"
        @click.stop="session.retry"
      >
        {{ t('terminal.retry') }}
      </n-button>
    </div>
    <!-- 连接断开（自动重连退避期）：提供「立即重连」手动按钮，不必等退避倒计时 -->
    <div
      v-if="!props.ended && session.disconnected.value && !session.failed.value"
      class="term-pane-error"
    >
      <div class="term-pane-error-icon">
        ⚠
      </div>
      <div class="term-pane-error-text">
        {{ t('terminal.disconnectedRetry') }}
      </div>
      <n-button
        size="small"
        type="primary"
        @click.stop="session.retry"
      >
        {{ t('terminal.reconnectNow') }}
      </n-button>
    </div>
    <!-- 拖拽悬浮提示 -->
    <div
      v-if="dragOverActive"
      class="term-drop-overlay"
    >
      <div class="term-drop-hint">
        <n-icon
          size="48"
          :component="CloudUploadOutline"
        />
        <div class="term-drop-text">
          {{
            dragOverIsPath
              ? t('terminal.dropPathHint')
              : t('terminal.dropFilesHint', { n: dragOverFileCount })
          }}
        </div>
      </div>
    </div>
    <!-- 终端搜索框：Ctrl+F 触发，作用于本 pane -->
    <div
      v-if="showSearch"
      class="term-search-bar"
    >
      <n-input
        ref="searchInputRef"
        v-model:value="searchQuery"
        size="tiny"
        :placeholder="t('terminal.searchPlaceholder')"
        :class="{ 'term-search-input-noresult': searchNoResult }"
        style="width: 180px"
        @update:value="() => { onQueryInput(); searchQuery && runSearch('next') }"
        @focus="onSearchInputFocus"
        @click="onSearchInputFocus"
        @blur="onSearchInputBlur"
        @keyup.enter="commitSearch('next')"
        @keyup.shift.enter="commitSearch('previous')"
        @keyup.escape="onSearchEscape"
      />
      <!-- 查询历史下拉（P-20261004-109）：mousedown.prevent 保输入框焦点（点击不先触发 blur） -->
      <div
        v-if="historyVisible"
        class="term-search-history"
        data-testid="term-search-history"
        @mousedown.prevent
      >
        <div
          v-if="historyAllFilteredOut"
          class="term-search-history-empty"
          data-testid="term-search-history-empty"
        >
          {{ t('terminal.searchHistory.empty') }}
        </div>
        <div
          v-else
          class="term-search-history-list"
        >
          <button
            v-for="(h, hi) in historyItems"
            :key="h"
            class="term-search-history-item"
            :data-testid="`term-search-history-item-${hi}`"
            :title="h"
            @click="applyHistory(h)"
          >
            <n-icon
              size="12"
              class="term-search-history-item-icon"
            >
              <SearchOutline />
            </n-icon>
            <span class="term-search-history-item-text">{{ h }}</span>
          </button>
        </div>
        <button
          class="term-search-history-clear"
          data-testid="term-search-history-clear"
          @click="onClearHistory"
        >
          <n-icon size="12">
            <TrashOutline />
          </n-icon>
          <span>{{ t('terminal.searchHistory.clear') }}</span>
        </button>
      </div>
      <!-- 结果计数：未搜索时不显示，0 显示 not found，N>0 显示计数 -->
      <span
        v-if="searchResultCount !== null"
        class="term-search-counter"
        :class="{ 'is-no-result': searchNoResult }"
      >
        {{ searchNoResult ? t('terminal.searchNotFound') : `${searchResultCount}` }}
      </span>
      <button
        class="term-search-nav-btn"
        :title="t('terminal.searchPrevious')"
        @click="commitSearch('previous')"
      >
        &uarr;
      </button>
      <button
        class="term-search-nav-btn"
        :title="t('terminal.searchNext')"
        @click="commitSearch('next')"
      >
        &darr;
      </button>
      <n-checkbox
        :checked="searchCaseSensitive"
        size="small"
        :title="t('terminal.searchCaseSensitive')"
        @update:checked="(v: boolean) => toggleSearchOption('caseSensitive', v)"
      >
        <span class="term-search-opt-icon">Aa</span>
      </n-checkbox>
      <n-checkbox
        :checked="searchRegex"
        size="small"
        :title="t('terminal.searchRegex')"
        @update:checked="(v: boolean) => toggleSearchOption('regex', v)"
      >
        <span class="term-search-opt-icon">.*</span>
      </n-checkbox>
      <button
        class="term-search-close-btn"
        :title="t('terminal.searchClose')"
        @click="closeSearch"
      >
        &times;
      </button>
    </div>

    <!-- 底部状态条插槽：宿主（TerminalView）渲染失败命令 AI 分析提示条等，
         absolute 定位覆盖在终端底部，不挤压 xterm 布局 -->
    <slot name="statusbar" />

    <!-- 多行/大文本粘贴警告：多行（存量）或超 64KB（P-20261002-136 体积感知版：
         标题/文案换大文本版、「不再提示」隐藏——常量阈值无设置项）时弹窗确认 -->
    <n-modal
      v-model:show="showPasteWarn"
      preset="dialog"
      :title="t(pendingPasteLarge ? 'terminal.pasteLargeTitle' : 'terminal.pasteMultilineTitle')"
      type="warning"
      :mask-closable="true"
      :positive-text="t('terminal.pasteAnyway')"
      :negative-text="t('common.cancel')"
      @positive-click="confirmPasteMultiline"
      @negative-click="cancelPasteMultiline"
      @close="cancelPasteMultiline"
    >
      <div style="color: var(--text-body); font-size: 13px; line-height: 1.6">
        <p style="margin: 0 0 10px">
          {{
            pendingPasteLarge
              ? t('terminal.pasteLargeWarn', { kb: pendingPasteKb, n: pastePreviewLineCount })
              : t('terminal.pasteMultilineWarn', { n: pastePreviewLineCount })
          }}
        </p>
        <div style="margin: 0 0 10px">
          <div style="color: var(--text-dim); font-size: 11px; margin-bottom: 4px">
            {{ t('terminal.pasteMultilinePreview', { n: pastePreviewLines.length }) }}
          </div>
          <pre class="paste-preview">{{ pastePreviewLines.join('\n') }}</pre>
        </div>
        <n-checkbox
          v-if="!pendingPasteLarge"
          v-model:checked="pasteMultilineNoWarn"
        >
          {{ t('terminal.closeConfirmNoPrompt') }}
        </n-checkbox>
      </div>
    </n-modal>

    <!-- 高危命令影响面确认卡（P-20261005-191）：粘贴链/palette 直达插入链命中
         高危模式时先弹影响面（模式 + 动态计数 + 受影响路径摘要），「仍要粘贴/
         插入」才落 PTY，取消即丢弃。全零影响不弹卡（灰提示降级见 gate 模块），
         预览失败静态降级卡照弹（信息缺席恰是弹卡的理由） -->
    <n-modal
      v-model:show="gateVisible"
      preset="dialog"
      :title="t('terminal.cmdPreview.title')"
      :type="dangerCard.result?.level === 'danger' ? 'error' : 'warning'"
      :mask-closable="false"
      :positive-text="t('terminal.cmdPreview.pasteAnyway')"
      :negative-text="t('common.cancel')"
      data-testid="terminal-cmd-preview-card"
      @positive-click="confirmDangerGate"
      @negative-click="cancelDangerGate"
      @close="cancelDangerGate"
    >
      <div
        class="cmd-preview-body"
        data-testid="terminal-cmd-preview-body"
      >
        <p class="cmd-preview-lead">
          {{ t('terminal.cmdPreview.lead') }}
        </p>
        <div
          v-for="(m, idx) in dangerCard.result?.matches || []"
          :key="`${m.id}-${idx}`"
          class="cmd-preview-match"
          :data-testid="`cmd-preview-match-${m.id}`"
        >
          <div class="cmd-preview-kind">
            {{ t(`terminal.cmdPreview.kind.${m.kind}`) }}
          </div>
          <pre class="cmd-preview-seg">{{ m.segment }}</pre>
          <div
            class="cmd-preview-impact"
            :class="{ 'is-zero': impactOf(m).tone === 'zero' }"
          >
            {{ impactText(m) }}
          </div>
          <ul
            v-if="(m.dynamic?.paths || []).length"
            class="cmd-preview-paths"
          >
            <li
              v-for="p in m.dynamic?.paths"
              :key="p"
            >
              {{ p }}
            </li>
          </ul>
        </div>
        <p
          v-if="dangerCard.previewFailed"
          class="cmd-preview-static"
        >
          {{ t('terminal.cmdPreview.staticFallback') }}
        </p>
        <p class="cmd-preview-hint">
          {{ t('terminal.cmdPreview.whitelistHint') }}
        </p>
      </div>
    </n-modal>
  </div>
</template>
