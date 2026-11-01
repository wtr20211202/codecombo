import { computed, reactive, ref } from 'vue'
import { createDiscreteApi, type DiscreteApi } from 'naive-ui'
import { connectCloneWS, CLONE_WS_MAX_RETRIES, CLONE_WS_RETRY_DELAY } from './useCloneWebSocket'
import { LOCK_REJECTED_CLOSE_CODE } from '../stores/lock'
import { useProjectStore } from '../stores/project'
import { useThemeStore } from '../stores/theme'
import i18n from '@/i18n'
import type { CloneResult, CloneStartPayload, CloneStatus } from './useCloneProgress'

/**
 * 克隆任务常驻跟踪器（P-20261003-58）：进行中克隆任务的全会话注册表。
 *
 * 动机：克隆体验锁在弹窗里——关掉对话框后长仓克隆「还在跑吗」不可见。本模块以
 * 模块级单例（useAgentTerminal 同款）为每个已启动任务持独立进度 WS：
 * - 弹窗关闭 / 路由切换 / 组件卸载都不中断跟踪，首页 CloneStatusBar 据此常驻展示；
 * - CloneProgressWS 快照补发保证重连无损，重连策略复用 useCloneWebSocket 常量；
 * - 服务端无任务清单端点，注册表只覆盖本客户端启动的任务（纯前端语义）。
 *
 * 完成提示归属：启动弹窗存活时其回调负责 toast（回调先行 settleLocal 摘条目，
 * 关而不卸的弹窗照常触发）；启动弹窗已卸载/运行中被重置（orphan）时由本模块
 * 兜底同文案 toast + 刷新项目列表，保证「关闭后完成」不静默。条目完成即移除，
 * 不新增重复通知。并发量级：服务端克隆槽位上限 4，注册表天然有界。
 */

/** 指示条消费的任务摘要（不暴露 ws/重试等内部状态） */
export interface CloneTaskBrief {
  taskId: string
  name: string
  stage: string
  progress: number
}

interface TrackedTask extends CloneTaskBrief {
  orphaned: boolean
  attempts: number
  retryTimer: ReturnType<typeof setTimeout> | null
  ws: WebSocket | null
}

// 模块级单例状态：跨路由（首页 ↔ 项目页）共享，路由组件卸载不影响
const tasks = ref<TrackedTask[]>([])

const briefs = computed<CloneTaskBrief[]>(() =>
  tasks.value.map(({ taskId, name, stage, progress }) => ({ taskId, name, stage, progress })),
)

// 显示名：显式名 > 目标目录尾段 > URL 尾段（双分隔符归一，win/linux 服务端通用）
function displayName(payload: CloneStartPayload): string {
  const name = payload.name?.trim()
  if (name) return name
  const dirParts = payload.dir.replace(/\\/g, '/').split('/').filter(Boolean)
  const dirTail = dirParts[dirParts.length - 1]
  if (dirTail) return dirTail
  const urlSegs = payload.url.replace(/\.git$/, '').split(/[/:]/).filter(Boolean)
  return urlSegs[urlSegs.length - 1] || payload.url || payload.dir
}

// 孤儿兜底 toast：与 CloneModal 同款离散 message（主题跟随），懒创建——
// 本模块在非组件上下文使用，首次兜底时才建
let discreteMessage: DiscreteApi<'message'>['message'] | null = null
function orphanToast() {
  if (!discreteMessage) {
    const themeStore = useThemeStore()
    discreteMessage = createDiscreteApi(['message'], {
      configProviderProps: computed(() => ({
        theme: themeStore.naiveTheme,
        themeOverrides: themeStore.naiveOverrides,
      })),
    }).message
  }
  return discreteMessage
}

function removeTask(t: TrackedTask) {
  const idx = tasks.value.indexOf(t)
  if (idx !== -1) tasks.value.splice(idx, 1)
}

function detach(t: TrackedTask) {
  if (t.retryTimer) {
    clearTimeout(t.retryTimer)
    t.retryTimer = null
  }
  if (t.ws) {
    t.ws.onmessage = null
    t.ws.onerror = null
    t.ws.onclose = null
    t.ws.close()
    t.ws = null
  }
}

// 任务到达终态：摘条目（完成即移除）；孤儿时兜底提示（与启动弹窗回调同文案）
function finish(t: TrackedTask, s: CloneStatus, r: CloneResult | null) {
  const orphaned = t.orphaned
  detach(t)
  removeTask(t)
  if (!orphaned) return
  const message = orphanToast()
  if (s === 'success') {
    message.success(i18n.global.t('layout.cloneSuccess'))
    // 孤儿成功无人刷新列表：兜底拉一次项目清单（启动弹窗成功回调的同款联动）
    useProjectStore().fetchProjects().catch(() => { /* silent */ })
  } else if (s === 'canceled') {
    message.info(i18n.global.t('layout.cloneCanceled'))
  } else {
    message.error(r?.error ? `${i18n.global.t('layout.cloneFail')}: ${r.error}` : i18n.global.t('layout.cloneFail'))
  }
}

// attach 连接任务进度 WS；断线自动重连（服务端补发全量快照，stage/progress
// 重放后自然追上最新），重试上限/间隔与弹窗侧 useCloneProgress 同源
function attach(t: TrackedTask) {
  t.ws = connectCloneWS(t.taskId, {
    onProgress: (line, percent) => {
      t.stage = line
      if (percent !== null) t.progress = percent
    },
    onDone: (s, r) => finish(t, s, r),
  })
  t.ws.onclose = (ev) => {
    // 已结束/已移除：detach 清掉了 onclose，此处只在跟踪中触达
    if (tasks.value.indexOf(t) === -1) return
    if (ev.code === LOCK_REJECTED_CLOSE_CODE) {
      // 锁定拒绝：切锁定屏由弹窗侧 WS 负责；此处静默摘条目（解锁后重开弹窗可续看）
      detach(t)
      removeTask(t)
      return
    }
    if (++t.attempts > CLONE_WS_MAX_RETRIES) {
      // 重试耗尽（典型：服务端重启丢任务）：任务已不存在、无完成可报，静默摘条目
      detach(t)
      removeTask(t)
      return
    }
    t.retryTimer = setTimeout(() => attach(t), CLONE_WS_RETRY_DELAY)
  }
}

/**
 * 克隆任务常驻跟踪器（模块级单例）。调用方：
 * - useCloneProgress.startClone：启动即 track + 回调包装 settleLocal；
 * - useCloneProgress.reset/onUnmounted：运行中放弃跟进转 orphan；
 * - CloneStatusBar：只读 items 渲染指示条。
 */
export function useCloneTracker() {
  // 登记并开始跟踪一个任务；同 taskId 幂等（重复 start 响应不重复连）。
  // 任务对象必须是 reactive 代理：attach/onProgress 等闭包捕获的是同一引用，
  // 经代理写 stage/progress 才能触发 briefs 重算（裸对象写入不建响应）
  function track(taskId: string, payload: CloneStartPayload) {
    if (tasks.value.some(t => t.taskId === taskId)) return
    const t = reactive({
      taskId,
      name: displayName(payload),
      stage: '',
      progress: 0,
      orphaned: false,
      attempts: 0,
      retryTimer: null,
      ws: null,
    }) as TrackedTask
    tasks.value.push(t)
    attach(t)
  }

  // 启动实例放弃跟进（组件卸载 / 运行中被 reset）：任务仍在服务端跑，
  // 保留条目，完成时由本模块兜底提示
  function orphan(taskId: string) {
    const t = tasks.value.find(x => x.taskId === taskId)
    if (t) t.orphaned = true
  }

  // 启动实例的完成回调在场（弹窗关而不卸也照常触发）：提示归回调，
  // 此处只摘条目且不再兜底
  function settleLocal(taskId: string) {
    const t = tasks.value.find(x => x.taskId === taskId)
    if (!t) return
    detach(t)
    removeTask(t)
  }

  return { items: briefs, track, orphan, settleLocal }
}
