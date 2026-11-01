import type { Ref } from 'vue'
import type { TermTab } from './useTerminalTabs'
import type { OscEvent } from './useTerminalSession'
import { terminalApi } from '../api/client'
import { useI18n } from '../composables/useI18n'
import { useNotificationStore } from '../stores/notification'

// 双挂接去重表（模块级：每个 TerminalView 各持一份 bridge 实例，双挂接时
// 同一 D 事件经两条 WS 各到达一次，实例级 map 无法互相看见）。同一会话被
// 底部面板与管理页同时渲染时，同一 D 事件实测间隔 ~4ms 且 durationMs 逐
// 毫秒一致——以 会话+命令+退出码+时长 做指纹 1s 窗口去重；人类重复执行同
// 一命令时 durationMs 几乎不可能完全相同，误伤概率可忽略。条目上限防长会
// 话无界增长
const dFingerprints = new Map<string, number>()
const FP_WINDOW_MS = 1000
const FP_MAX = 1000
function seenDRecently(key: string): boolean {
  const now = Date.now()
  const prev = dFingerprints.get(key)
  if (prev !== undefined && now - prev < FP_WINDOW_MS) return true
  dFingerprints.set(key, now)
  if (dFingerprints.size > FP_MAX) {
    const first = dFingerprints.keys().next()
    if (!first.done) dFingerprints.delete(first.value)
  }
  return false
}

/**
 * OSC 133（shell integration）事件桥（自 TerminalView.vue 抽出）：
 * - C/D 事件维护 tab 运行状态点（running / lastExitCode）
 * - D 事件驱动会话总览最近命令记录、命令历史上报（fire-and-forget）、
 *   长任务通知（超阈值推送通知中心，支持跳转回终端）
 */
export function useTerminalOscBridge(options: {
  tabs: Ref<TermTab[]>
  currentProjectId: () => string | null
  projectName: () => string | undefined
  historyEnabled: Ref<boolean>
  longTaskThresholdMs: () => number
  recordLastCommand: (sessionId: string, command: string) => void
}) {
  const { tabs, recordLastCommand } = options
  const { t } = useI18n()
  const notificationStore = useNotificationStore()

  function onOscEvent(ev: OscEvent, sessionId: string): void {
    const tab = tabs.value.find((t) => t.id === sessionId)
    if (ev.type === 'C') {
      // 命令开始：tab 显示运行中状态点（黄色 pulse）
      if (tab) tab.running = true
    } else if (ev.type === 'D') {
      const exitCode = ev.exitCode ?? 0
      const durationMs = ev.durationMs ?? 0
      // 命令结束：清除 running，写入 exit code 供 tab 显示状态点
      if (tab) {
        tab.running = false
        tab.lastExitCode = exitCode
      }
      // 会话总览：记录最近命令（E 事件解码文本，供总览条目展示进度上下文）
      if (ev.command) recordLastCommand(sessionId, ev.command)
      // 附着重放段里的 D（133;R 哨兵之前解析到的事件）只用于恢复状态展示——
      // 记账语义（长任务通知 / 命令历史）必须跳过，否则每次附着都重复记账
      if (ev.replayed) return
      // 双挂接去重：同一 D 事件经两条 WS 到达时只记账一次
      const fp = `${sessionId}|${ev.command ?? ''}|${exitCode}|${durationMs}`
      if (seenDRecently(fp)) return
      onCommandFinish(sessionId, exitCode, durationMs)
      recordCommandHistory(tab, sessionId, ev.command, exitCode, durationMs)
    }
  }

  // 命令历史上报：D 事件附带命令文本（E 事件解码）时 fire-and-forget 记录。
  // 失败仅 console.debug——不能阻塞终端交互，也不做重试。
  // terminalId = 会话 id（CC_TERMINAL_ID 同源，P-20261004-35）：会话粒度行为
  // 账本的归属锚点，收工卡/历史面板按会话过滤都消费它
  function recordCommandHistory(
    tab: TermTab | undefined,
    sessionId: string,
    command: string | undefined,
    exitCode: number,
    durationMs: number,
  ): void {
    if (!command || !options.historyEnabled.value) return
    const projectId = tab?.projectId || options.currentProjectId() || ''
    if (!projectId) return
    terminalApi.recordHistory(projectId, { command, exitCode, durationMs, terminalId: sessionId }).catch((err: unknown) => {
      console.debug('record terminal history failed', err)
    })
  }

  // 命令完成处理：时长超阈值则推送通知（原 useTerminalWs.onCommandFinish 移入）
  function onCommandFinish(sessionId: string, exitCode: number, durationMs: number): void {
    const threshold = options.longTaskThresholdMs()
    if (durationMs < threshold) return // 短命令不通知

    const tab = tabs.value.find((t) => t.id === sessionId)
    const projectId = tab?.projectId || options.currentProjectId() || ''
    const projectName = options.projectName()

    notificationStore.add({
      type: exitCode === 0 ? 'success' : 'error',
      category: 'task',
      title:
        exitCode === 0
          ? `${t('notification.event.longTaskSuccess')}（${(durationMs / 1000).toFixed(1)}s）`
          : `${t('notification.event.longTaskFailed')}（${t('notification.event.taskDuration', {
              n: (durationMs / 1000).toFixed(1),
            })}，exit ${exitCode}）`,
      body: tab?.name || sessionId,
      projectId,
      projectName,
      action: 'terminal',
      actionPayload: sessionId,
    })
  }

  return { onOscEvent }
}
