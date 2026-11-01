<template>
  <!-- 渲染兜底降级页（P-20261002-26）：熔断后整树替换为独立渲染的降级页
       （零依赖，不进 NConfigProvider 组件树） -->
  <CrashFallback
    v-if="crashActive"
    :title="t('app.crash.title')"
    :hint="t('app.crash.hint')"
    :summary="crashSummary"
    :detail="crashDetail"
    :copy-label="t('app.crash.copyDetail')"
    :copied-label="t('common.copied')"
    :reload-label="t('app.crash.reload')"
    :go-home-label="t('app.crash.goHome')"
    @go-home="onCrashGoHome"
  />
  <NConfigProvider
    v-else
    :theme="themeStore.naiveTheme"
    :theme-overrides="themeStore.naiveOverrides"
    :locale="naiveLocale"
    :date-locale="naiveDateLocale"
  >
    <NDialogProvider>
      <NMessageProvider>
        <OpsChannelBridge />
        <!-- agent↔用户 全局卡片栈：审批（可/否裁决）+ 提问（自由文本/选项）共锚点，
             单一 fixed 包装承载纵向堆叠，两类卡片同屏互不遮挡；栈内只剩被动的
             「最近裁决」触发条时降层（stackSubdued，P-20261003-226——触发条
             不得压住设置弹层等浮层的底部按钮）；项目页面板打开时抬升到面板
             上沿之上（stackPanelYield，run9——P-226 后触发条在有终态审批记录的
             实例近乎恒驻，固定锚点整幅压在底部面板右下内容区上挡点面板行）；
             分享管理器主区视图打开时整栈隐藏（stackHiddenForView——被动回看条
             压住管理器行操作列，「更多」钮实测点不到） -->
        <div
          v-show="!stackHiddenForView"
          class="agent-input-stack"
          :class="{ 'agent-input-stack--subdued': stackSubdued }"
          :style="stackPanelYield"
        >
          <ApprovalCards />
          <AskCards />
          <!-- 停滞分诊卡（P-20261004-37）：App 层单一实例，三宿主停滞强标点击经
               stallTriage store 打开（全局弹窗惯例，DiagnoseDialog 同款挂法） -->
          <StallTriageCard />
        </div>
        <!-- 全局放行常驻徽标（P-20261002-126）：独立 fixed 锚点（不入卡片堆——
             徽标层级须低于 modal，放行指示不得遮挡/挡点设置弹层等浮层；
             审批卡在场时徽标让位于更高层的卡片堆） -->
        <ApprovalModeBadge />
        <a
          href="#main-content"
          class="skip-link"
        >{{ t('common.skipToMain') }}</a>
        <!-- :key 实例切换机制：currentInstanceId 变化时当前视图整树 remount，
           组件作用域状态（openFiles/终端 tabs/面板状态）随之销毁重初始化 -->
        <RouterView :key="instanceStore.currentInstanceId" />
        <NotificationCenter />
        <!-- 失败会话复盘弹层（P-20261004-60）：App 层单一实例，入口两路
             （退出通知卡 postmortem 动作 / 会话行右键）经 postmortem store 共达
             （stallTriage/DiagnoseDialog 全局弹窗同款挂法） -->
        <PostmortemModal />
        <!-- 版本更新内容弹层（P-20261007-17）：App 层单一实例，升级后首启一次性
             轻弹（解锁后判定，delta 只显新版段落）；自含判定与已读记账 -->
        <WhatsNewPopup />
        <!-- 远程运维全局弹窗：挂在 App 层（RouterView 之外），
           首页/项目页/远程控制台页的入口都能弹出 -->
        <DiagnoseDialog
          :key="'diag-' + asyncRetryTick"
          v-model:show="remoteOps.showDiagnose"
          :host-id="remoteOps.diagHost.id"
          :host-name="remoteOps.diagHost.name"
          @retry="asyncRetryTick++"
        />
        <RemoteExecDialog
          :key="'rexec-' + asyncRetryTick"
          v-model:show="remoteOps.showExec"
          :host-id="remoteOps.execHost.id"
          :host-name="remoteOps.execHost.name"
          :initial-cmd="remoteOps.execInitialCmd"
          @retry="asyncRetryTick++"
        />
        <RemoteGitCompareDialog
          :key="'gcmp-' + asyncRetryTick"
          v-model:show="remoteOps.showGitCompare"
          :host-id="remoteOps.gitCompareHost.id"
          :host-name="remoteOps.gitCompareHost.name"
          @retry="asyncRetryTick++"
        />
        <!-- 多主机巡检对比（P-20261004-58）：机队级动作无单主机参数，
             主机勾选在弹窗内完成，打开即自动跑一轮 -->
        <RemoteDiagCompareDialog
          :key="'dcmp-' + asyncRetryTick"
          v-model:show="remoteOps.showDiagCompare"
          @retry="asyncRetryTick++"
        />
        <!-- 实例切换过渡遮罩 -->
        <InstanceSwitchOverlay />
        <!-- 全局锁定遮罩：覆盖在所有内容之上，store.isLocked 控制显隐 -->
        <LockScreenOverlay />
        <!-- 启动 loading 遮罩：checkStatus 首次探测完成前盖住应用，
           防止 isLocked=true 默认值导致刷新时闪现锁定页。
           :duration 显式钉离场时长（P-20261011-1 ①）：低帧率/事件节流环境
           （内嵌 webview / 远控串流）下 transitionend 会丢失，显式 duration
           强制 Vue 走 setTimeout 兜底 resolve，离场不再无限期挂起 -->
        <Transition
          name="boot-fade"
          :duration="200"
        >
          <div
            v-if="!lockStore.isReady"
            class="app-boot-loading"
          >
            <span class="app-boot-spinner" />
          </div>
        </Transition>
        <!-- 渲染兜底测试探针（?__crash=1，本机守卫）：置于分支末尾——重试期间
             其余组件先完成挂载，中断面最小；onMounted 武装保证初始化链完整 -->
        <CrashProbe
          v-if="crashProbeArmed"
          :key="crashProbeTick"
        />
      </NMessageProvider>
    </NDialogProvider>
  </NConfigProvider>
</template>

<script setup lang="ts">
import { RouterView, useRouter, useRoute } from 'vue-router'
import { computed, onMounted, onBeforeUnmount, ref, watch, onErrorCaptured } from 'vue'
import { NConfigProvider, NMessageProvider, NDialogProvider, zhCN, dateZhCN, enUS, dateEnUS } from 'naive-ui'
import { useThemeStore } from './stores/theme'
import { useLocaleStore } from './stores/locale'
import { useNotificationStore } from './stores/notification'
import { useLockStore } from './stores/lock'
import { useProjectStore } from './stores/project'
import { useApprovalsStore } from './stores/approvals'
import { useAsksStore } from './stores/asks'
import { useInstanceStore } from './stores/instance'
import { useRemoteOpsStore } from './stores/remoteOps'
import { useUpdateCheckStore } from './stores/updateCheck'
import { useErrorLogStore } from './stores/errorLog'
import { useI18n } from './composables/useI18n'
import { useTerminalTheme } from './composables/useTerminalTheme'
import { usePanelLayout } from './composables/usePanelLayout'
import { useUiZoomStore } from './stores/ui-zoom'
import { useUiDensityStore } from './stores/ui-density'
import { initOpsChannel } from './composables/useOpsChannel'
import { startFleetTaskBackflow, stopFleetTaskBackflow } from './composables/useFleetTaskBackflow'
import { startFleetBatchWatch, stopFleetBatchWatch } from './composables/useFleetBatchWatch'
import { updateFaviconBadge } from './utils/faviconBadge'
import { initSettingsSync } from './utils/settingsSync'
import { createCrashGuard, formatCrashDetail, truncateText, CRASH_SUMMARY_MAX } from './utils/crashGuard'
import type { CapturedError } from './utils/crashGuard'
import { FLICKER_DEBUG_QUERY_KEY, setFlickerDebug } from './utils/flickerDebug'
import NotificationCenter from './components/notifications/NotificationCenter.vue'
import PostmortemModal from './components/terminal/PostmortemModal.vue'
import WhatsNewPopup from './components/help/WhatsNewPopup.vue'
import LockScreenOverlay from './components/lock/LockScreenOverlay.vue'
import InstanceSwitchOverlay from './components/instance/InstanceSwitchOverlay.vue'
import OpsChannelBridge from './components/ai/OpsChannelBridge.vue'
import ApprovalCards from './components/agent/ApprovalCards.vue'
import ApprovalModeBadge from './components/agent/ApprovalModeBadge.vue'
import AskCards from './components/agent/AskCards.vue'
import StallTriageCard from './components/agent/StallTriageCard.vue'
import CrashFallback from './components/crash/CrashFallback.vue'
import CrashProbe from './components/crash/CrashProbe.vue'
// 远程运维弹窗懒加载：首屏不可见（v-model:show 默认 false），不必进首屏 JS
//（naive-ui vendor 全量并进首屏 preload 链的主因之一）；safeAsync 提供加载
// 失败重试态（弹窗打开瞬间 chunk 拉取失败不再静默无响应）
import { safeAsync } from './utils/async-component'
const asyncRetryTick = ref(0)
const DiagnoseDialog = safeAsync(() => import('./components/deploy/DiagnoseDialog.vue'))
const RemoteExecDialog = safeAsync(() => import('./components/deploy/RemoteExecDialog.vue'))
const RemoteGitCompareDialog = safeAsync(() => import('./components/remote/RemoteGitCompareDialog.vue'))
const RemoteDiagCompareDialog = safeAsync(() => import('./components/remote/RemoteDiagCompareDialog.vue'))

const themeStore = useThemeStore()
const localeStore = useLocaleStore()
const notificationStore = useNotificationStore()
const lockStore = useLockStore()

// 锁定期间收紧 toast 层级（main.css 的 .sc-locked 规则）：错误提示不浮在锁屏上
watch(() => lockStore.isLocked, (locked) => {
  document.body.classList.toggle('sc-locked', locked)
})

// 浏览器标签页 title 信息架构（VS Code「文件 — 工作区」同构）：
// - 前缀徽标 (n) = max(未读通知, 待审批)：agent 挂着等裁决的事不轻于未读通知，
//   两类待办合并为单数字（Gmail/Web IM 惯例；「审批 n·通知 m」双段更宽，取简），
//   归零恢复无徽标
// - 项目内（/project 路由且已选中项目）追加「 — {项目名}」；首页/监控页保持纯
//   品牌名——首页 fetchProjects 会自动预选首个项目，故按路由而非 currentProjectId
//   判定「在项目内」
// - 品牌名不随 locale 变化；document.title 赋值为 textContent 语义，项目名含
//   特殊字符无 XSS 面
const instanceStore = useInstanceStore()
const projectStore = useProjectStore()
const approvalsStore = useApprovalsStore()
const asksStore = useAsksStore()
const route = useRoute()
// 待办徽标 = max(未读通知, 待审批)——title 前缀（下方 documentTitle）与
// favicon 角标（P-20261003-65）共用同一事实源，两处展示永不漂移
const todoBadge = computed(() => Math.max(notificationStore.unreadCount, approvalsStore.pendingCount))
// 卡片栈降层（P-20261003-226）：栈内只剩被动的「最近裁决」触发条（无审批卡/
// 提问卡）时降到放行徽标层（1500，< modal ~2000）——设置弹层 footer 与右下
// 角同域，触发条留 3000 会挡住弹层保存钮（实测踩坑）；有裁决卡/提问卡在栈
// 时保持 3000（裁决面优先的既有语义不变）
const stackSubdued = computed(() => approvalsStore.pendingCount === 0 && asksStore.pendingCount === 0)

// 卡片栈底部面板让位（run9 e2e 实测真回归修正）：P-20261003-226 后「最近裁决」
// 触发条在有终态审批记录的实例上近乎恒驻（subdued 态唯一内容），而栈的固定锚点
// bottom:76px 落在底部面板（min-height 120px）右下内容区内——实测 1280×720、
// 面板 260px 时触发条 [616,644]×[944,1264] 整幅压住面板行，挡点历史/片段/运行
// 书/错误日志等面板内交互（用户同受其害）。项目页面板打开且非任何最大化态时，
// subdued 栈抬到面板上沿之上（状态栏 24px + 面板高 + 8px 间距；与
// ApprovalModeBadge liftAboveRecent 同款「常驻被动元素让位」先例）。
// 有裁决卡/提问卡在栈（裁决面优先）或非项目页（首页/监控页无面板；layout ref
// 跨路由残留，须按路由门控）时不让位，维持既有锚点。最大化态面板覆盖全屏，
// 抬升无意义，随默认锚点被面板覆盖（临时沉浸态，退出即恢复）
const { showBottomPanel, bottomPanelHeight, bottomPanelMaximized, bottomPanelEditorMaximized, terminalMaximized, showShareManager } = usePanelLayout()
// 主区视图让位（run24 实测）：分享管理器是主区整幅视图，行操作列贴右缘——
// 被动「最近裁决」触发条（subdued 态唯一内容）的固定右下锚点正压在其行尾
// 「更多」钮上，实测点击拦截（1280×720 + 底部面板抬起后 [944,1264]×[400,428]
// 盖住行按钮）。与 P-226 降层 / run9 面板上抬同族「被动元素让位可操作面」：
// 管理器打开且无待裁决卡时整栈隐藏（有待裁决卡时裁决面优先，照常显示）；
// 管理器关闭即恢复，回看入口不缩水
const stackHiddenForView = computed(() =>
  stackSubdued.value && route.path === '/project' && showShareManager.value)
const STATUS_BAR_H = 24 // StatusBar.vue .status-bar height
const stackPanelYield = computed<Record<string, string> | undefined>(() => {
  if (!stackSubdued.value) return undefined
  if (route.path !== '/project' || !showBottomPanel.value) return undefined
  if (bottomPanelMaximized.value || bottomPanelEditorMaximized.value || terminalMaximized.value) return undefined
  return { bottom: `${STATUS_BAR_H + bottomPanelHeight.value + 8}px` }
})
const documentTitle = computed(() => {
  const projectName = route.name === 'project' ? projectStore.currentProject?.name : ''
  const base = projectName ? `Codecombo — ${projectName}` : 'Codecombo'
  return todoBadge.value > 0 ? `(${todoBadge.value}) ${base}` : base
})
watch(documentTitle, (title) => { document.title = title }, { immediate: true })

// favicon 待办角标（P-20261003-65）：固定标签页（pinned tab）不显示 title、
// 只露 favicon——与上方 title 前缀徽标共用同一 todoBadge 源、同点位触发：
// >0 时 canvas 在原图标上叠角点数字（>9 显 9+）换 dataURL href，归零恢复
// 原图标；纯前端光栅合成（utils/faviconBadge.ts），失败静默保持原图标
watch(todoBadge, (n) => { void updateFaviconBadge(n) }, { immediate: true })
const remoteOps = useRemoteOpsStore()
const updateCheckStore = useUpdateCheckStore()
const { t } = useI18n()

// 终端主题 → document 副作用全局唯一应用点：body data-terminal-theme + CSS 变量
// + html 字体 class + noise。此前只在 TerminalView/RemoteConsoleView 挂载时应用，
// 导致全局终端（首页/未开底部终端）风格与项目终端不一致——终端风格设置必须对
// 系统内所有终端（项目/全局/远程/管理页）一致生效
useTerminalTheme()

// 界面缩放 → document 副作用应用点：store 首次激活即从 localStorage 恢复档位并
// 注入 --ui-zoom（setup 期早于任何视图挂载，刷新无缩放跳变）
useUiZoomStore()

// 界面密度（P-20261003-322）→ 行高 token 注入点：默认舒适档零注入（= 现状，
// 无首帧跳变）；服务端档位异步拉取后应用，settings.changed 广播经 OpsChannelBridge
// 重读多端跟随
void useUiDensityStore().load()

// 多标签本地设置实时同步（P-20261002-36）：storage 事件（浏览器语义仅他页写入
// 派发）按 key 分发各 store 静默重读——A 标签改主题/语言/字体/缩放，其余标签
// 不经刷新跟随。App 单例挂载点注册一次，卸载时摘除
const disposeSettingsSync = initSettingsSync()

// naive-ui 组件库内置文案（空输入框 placeholder「Please Input」、分页、日期选择等）
// 跟随应用 locale：zh-CN 显示「请输入」，en-US 显示「Please Input」
const naiveLocale = computed(() => (localeStore.currentLocale === 'zh-CN' ? zhCN : enUS))
const naiveDateLocale = computed(() => (localeStore.currentLocale === 'zh-CN' ? dateZhCN : dateEnUS))

// navigate 事件（含 P-20261005-223 四目标形态）消费已迁 OpsChannelBridge：
// {terminalId} 会话聚焦的 jumpToSession 依赖 useMessage，须在 NMessageProvider
// 树内消费（App 自身 setup 在 provider 之外）；本组件只保留 router 供降级页回首页
const router = useRouter()

// 闪烁自诊断（P-20261011-1 ④，?__debug-flicker=1）：冷启动从地址直读并即时
// 武装（router 首跳解析前 boot 遮罩已在场，晚挂会漏首次显隐事件）；运行期经
// ops navigate 携 query 跳转激活/关闭（route.query watch），远控现场一键取证
setFlickerDebug(new URLSearchParams(window.location.search).get(FLICKER_DEBUG_QUERY_KEY) === '1')
watch(() => route.query[FLICKER_DEBUG_QUERY_KEY], (v) => { setFlickerDebug(v === '1') })

// ---- 渲染错误兜底「白屏保险丝」（P-20261002-26）----
// 动机：更新走「中心分发、子实例自拉替换」，带渲染错误的坏构建推到远程
// 实例 = 白屏只能 SSH 回滚。连续渲染错误达阈值（默认 3 次/10s）切降级页。
// 入账分工：未达阈值的错误在此放行，由 main.ts 的 app.config.errorHandler
// 入账错误中心（此处不重复记录）；达阈值时 return false 阻断传播，
// errorHandler 收不到熔断错误，由 tripCrash 在此入账——两端互不重复
const crashGuard = createCrashGuard()
const errorLogStore = useErrorLogStore()
const crashActive = ref(false)
const crashSummary = ref('')
const crashDetail = ref('')

// ?__crash=1 测试钩子：仅本机主机名（localhost/127.0.0.1/[::1]）+ 显式参数
// 激活——e2e 走 go:embed 生产构建，无法用 import.meta.env.DEV 守卫；远端
// 实例经非本机地址访问时探针不激活，兜底本体全环境生效不受守卫影响
const crashProbeActive = ref(
  ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)
  && new URLSearchParams(window.location.search).get('__crash') === '1',
)
// 探针武装延迟到完全挂载后：初始挂载若被必抛组件中断，App 的 onMounted
// 初始化（通知/实例/锁探测）不会执行，回首页后应用壳会残缺
const crashProbeArmed = ref(false)
// 探针重挂载 tick：捕获探针错误后 bump :key 重新渲染必抛组件，确定性叠加
// 错误次数直至熔断——走与生产完全相同的 crashGuard 判定链路
const crashProbeTick = ref(0)

function crashMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toCapturedError(err: unknown, info: string): CapturedError {
  return {
    message: crashMessage(err),
    stack: err instanceof Error ? err.stack : undefined,
    info,
  }
}

// 熔断：入账错误中心 + 组装截断摘要/复制详情，整树切降级页
function tripCrash(error: CapturedError): void {
  crashSummary.value = truncateText(error.message, CRASH_SUMMARY_MAX)
  crashDetail.value = formatCrashDetail(error, {
    href: window.location.href,
    userAgent: window.navigator.userAgent,
  })
  errorLogStore.add({
    category: 'client',
    method: 'VUE',
    url: `vue:${error.info ?? 'unknown'}`,
    status: 0,
    rawMessage: error.message,
    userMessage: t('app.crash.logUserMessage'),
  })
  crashActive.value = true
}

// 根级捕获：只兜渲染层（组件渲染/setup/生命周期钩子经 Vue 错误链上报），
// Promise 异常不走此链（仍由 axios 拦截器体系处理，不重复入账）
onErrorCaptured((err, _instance, info) => {
  // 降级页已接管：吞掉后续一切组件错误，防降级页自身被再次熔断/错误刷屏
  if (crashActive.value) return false
  const error = toCapturedError(err, info)
  if (crashGuard.record(error)) {
    tripCrash(error)
    return false
  }
  // 未达阈值不接管 UI：放行给 errorHandler 入账；探针场景 bump :key
  // 促使必抛组件重渲染，确定性叠加至阈值
  if (crashProbeActive.value) crashProbeTick.value++
})

// 降级页「回首页」：复位保险丝与探针后路由跳转，应用壳正常重挂载
function onCrashGoHome(): void {
  crashGuard.reset()
  crashProbeActive.value = false
  crashProbeArmed.value = false
  crashActive.value = false
  void router.push('/')
}

// 启动全局通知中心：拉取历史 + 加载偏好 + 连接全局 WS
onMounted(() => {
  // 渲染兜底测试探针武装：完全挂载后才渲染必抛组件（见 crashProbeArmed 注释）
  if (crashProbeActive.value) crashProbeArmed.value = true
  notificationStore.init()
  // 实例列表属主在此初始加载（静默失败；锁定期间 423 由菜单/面板打开时兜底重拉）
  void instanceStore.fetchInstances()
  // 探测后端锁定状态：决定首屏是否显示锁定页
  lockStore.checkStatus()
  // 智能操作通道：订阅后端/外部 Agent 的前端联动指令
  initOpsChannel()
  // 更新可用性检查：启动延时静默首查 + 周期复查（GitHub 分发源 + 所属中心，
  // 结果驱动状态栏角标/实例面板提示；发现更新仅提示，由用户决定是否安装）
  updateCheckStore.startAutoCheck()
  // 联邦派发进度回流轮询（P-20261004-131）：中心对有派发记录的实例 15s 一轮
  // 拉对端任务进度映射 bySession（锁定态内部跳过；App 根生命周期即轮询生命周期）
  startFleetTaskBackflow()
  // 编队批级完成通知观察（P-20261005-145）：会话快照 fleetBatch + bySession
  // 终态聚合「全员终态」收敛沿，单条批级通知（零请求，纯 store watch）
  startFleetBatchWatch()
})
onBeforeUnmount(() => {
  disposeSettingsSync()
  stopFleetTaskBackflow()
  stopFleetBatchWatch()
})
</script>

<style>
/* 全局：agent↔用户 卡片栈（审批+提问）唯一锚点：右下角固定，内部两类
   卡片堆纵向流式堆叠（AskCards 在 ApprovalCards 之后自然排布不重叠） */
.agent-input-stack {
  position: fixed; right: 16px; bottom: 76px; z-index: 3000;
  display: flex; flex-direction: column; gap: 8px;
  /* 窄屏钳宽（P-20261003-104）：固定 320px 在窄视口（手机裁决场景/分屏半宽）
     会横向溢出被裁——钳到视口内（32px = 右侧锚定 16px + 对称左余量 16px），
     宽视口下 min 仍取 320px 呈现零变化；审批卡与提问卡共此锚点一并受益 */
  width: min(320px, calc(100vw - 32px));
}

/* 卡片栈降层（P-20261003-226）：栈内只剩被动「最近裁决」触发条（无审批卡/
   提问卡）时降到放行徽标层（1500，< modal ~2000）——触发条不得压住设置弹层
   等浮层的底部按钮（弹层 footer 与右下角同域，实测踩坑）；有卡在栈时保持
   3000（裁决面优先的既有语义不变，见上方 stackSubdued） */
.agent-input-stack--subdued { z-index: 1500; }

/* 全局：尊重用户偏好，关闭动效 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* 启动 loading 遮罩：z-index 高于 LockScreenOverlay（10000），
   纯色背景不透明，避免刷新时透出底下的锁定页 */
.app-boot-loading {
  position: fixed;
  inset: 0;
  z-index: 10001;
  display: flex;
  align-items: center;
  justify-content: center;
  /* 暗色主题兜底：early-init 失效或 CSS 变量缺失时仍不透明，
     防止透出下方的 LockScreenOverlay */
  background-color: #0d1117;
  background-color: var(--bg-primary, #0d1117);
}

/* 极简 spinner：纯 CSS，无外部依赖 */
.app-boot-spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid var(--bg-border);
  border-top-color: var(--accent-blue);
  animation: app-boot-spin 0.8s linear infinite;
}

@keyframes app-boot-spin {
  to { transform: rotate(360deg); }
}

/* 通用图标旋转（实例菜单/管理面板的刷新按钮等），配合上面的 keyframes 使用 */
.spinning {
  animation: app-boot-spin 0.8s linear infinite;
}

/* boot loading 淡出：isReady=true 时遮罩在 200ms 内淡出。
   pointer-events:none（P-20261011-1 ①）：离场只是视觉余韵，无理由继续拦截
   交互——低帧率/事件节流环境（内嵌 webview / 远控串流）下离场过渡可能长期
   挂起，残留的不透明遮罩会吞掉全页点击；豁免后即使残留也不再阻断可用性 */
.boot-fade-leave-active {
  transition: opacity 0.2s ease;
  pointer-events: none;
}
.boot-fade-leave-to {
  opacity: 0;
}

/* 串流/触屏环境过渡降级（P-20261011-1 ③）：coarse 指针（触屏为主指针的
   设备，手机经串流操作桌面浏览器即此形态）下非必要淡入淡出减半，降低低
   帧率环境的过渡堆积面；prefers-reduced-motion 由上方全局 0.01ms 规则直显，
   无需在此重复。本文件收 boot 遮罩与 naive 弹层（modal 系统一走
   fade-in-scale-up 过渡类，见 node_modules naive-ui modal/src/BodyWrapper），
   自绘遮罩各自的减半规则在组件 scoped 样式内（InstanceSwitchOverlay /
   LockScreenOverlay）。注意：显式 :duration 钉的是 Vue 兜底时长，CSS 减半后
   正常环境 transitionend 更早 resolve，事件丢失时仍由 :duration 兜底 */
@media (pointer: coarse) {
  .boot-fade-leave-active { transition-duration: 0.1s; }
  .fade-in-scale-up-transition-enter-active,
  .fade-in-scale-up-transition-leave-active {
    transition-duration: 0.1s !important;
  }
}
</style>
