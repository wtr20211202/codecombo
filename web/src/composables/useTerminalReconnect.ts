import { watch } from 'vue'
import type { Ref } from 'vue'
import type { TermTab } from './useTerminalTabs'
import { recallActiveTab } from '../utils/terminalActiveTab'

/**
 * 终端会话恢复：重连既有 PTY 会话（onMounted / 实例切换 / 解锁时复用）。
 * —— 新 tab：TerminalPane 随 tabs 渲染挂载并自行连接；
 *    既有 tab：WS 非开放态时经 paneRef 重建连接（原 useTerminalWs.reconnectExistingSessions）。
 * 同时接管三类联动 watch：通知中心跳转、实例切换断开+恢复、解锁兜底重连。
 * 从 TerminalView.vue 抽出（债项拆分）。
 */
export function useTerminalReconnect(options: {
  tabs: Ref<TermTab[]>
  activeTabId: Ref<string>
  /** TerminalPane 组件实例表（reconnect/disconnect 经此下发） */
  paneRefs: Map<string, { reconnect(): void; disconnect(): void }>
  currentProjectId: () => string | null
  terminalApiList: () => Promise<Array<{ id: string; name?: string; projectId?: string; running?: boolean }>>
  pendingSwitch: Ref<string | null>
  consumePendingSwitch: () => void
  instanceId: Ref<string>
  isLocked: Ref<boolean>
  selectTab: (id: string) => void
}) {
  const { tabs, activeTabId, paneRefs, currentProjectId, selectTab } = options

  /** 重连已有终端会话的统一入口（onMounted / 实例切换 / 解锁时复用） */
  async function reconnectSessions() {
    try {
      const sessions = await options.terminalApiList()
      for (const s of sessions) {
        // running 为服务端前台探测事实源（字段缺省 = 后端无法判定，保持
        // 既有状态）：刷新/重连后据此立即恢复"运行中/空闲"
        const knownRunning = typeof s.running === 'boolean'
        const existing = tabs.value.find((t) => t.id === s.id)
        if (existing) {
          if (knownRunning) existing.running = !!s.running
          // tab 已存在（pane 仍挂载），WS 需要时经 pane 重连
          paneRefs.get(s.id)?.reconnect()
          continue
        }
        const tab: TermTab = {
          id: s.id,
          name: s.name || 'Terminal',
          projectId: s.projectId || '',
        }
        if (knownRunning) tab.running = !!s.running
        tabs.value.push(tab)
      }
      // 激活当前项目的标签：优先恢复记忆的激活 tab（刷新重连/实例切换/
      // 解锁都走这里，不能总是拽到最后一个）；记忆已失效（tab 被关）回退最后
      const pid = currentProjectId()
      if (pid) {
        const pt = tabs.value.filter((t) => t.projectId === pid)
        if (pt.length > 0) {
          const saved = recallActiveTab(pid)
          activeTabId.value = pt.some((t) => t.id === saved) ? saved : pt[pt.length - 1]!.id
        }
      }
    } catch {
      // 静默失败
    }
  }

  // 通知中心跳转：切到对应 tab + focus（等待目标 tab 存在，跨项目跳转时项目可能仍在加载）。
  // immediate 必须开启：跳转方（悬浮列表/管理页/通知中心）先 requestSwitch 再路由挂载本视图，
  // 注册时值已就位——非 immediate 的 watcher 永远等不到变化，症状是跳到项目后底部终端不打开
  watch(() => options.pendingSwitch.value, (sessionId) => {
    if (!sessionId) return
    const trySelect = (attempts = 0) => {
      // 意图可能已被更新/清除：以注册读取时的最新值为准
      if (options.pendingSwitch.value !== sessionId) return
      const tab = tabs.value.find((t) => t.id === sessionId)
      if (tab) {
        selectTab(sessionId)
        options.consumePendingSwitch()
      } else if (attempts < 30) {
        // 最多等 3 秒（30 * 100ms）
        setTimeout(() => trySelect(attempts + 1), 100)
      } else {
        options.consumePendingSwitch()
      }
    }
    trySelect()
  }, { immediate: true })

  // 实例切换时断开旧终端、恢复新实例终端
  watch(() => options.instanceId.value, () => {
    paneRefs.forEach((pane) => pane.disconnect())
    void reconnectSessions()
  })

  // 锁定/解锁不再断开终端 WS：后端 HandleTerminalWS 不注册 lock closer，
  // 终端在锁定期间持续接收 shell 输出，解锁后用户能直接看到全部历史。
  // 仅锁定状态下阻止自动重连（避免 handshake 被中间件拒绝陷入死循环），
  // 解锁后若个别 WS 已断（如网络问题）则由 reconnectSessions 兜底恢复
  watch(() => options.isLocked.value, (locked) => {
    if (!locked) void reconnectSessions()
  })

  return { reconnectSessions }
}
