import { ref } from 'vue'

/**
 * 终端会话的运行态域（OSC 133 宿主写入，自 terminal-sessions store 拆出，纯
 * 搬运零逻辑改动）：会话粒度运行状态（C/D）、最近活动时间戳（排序依据，E 高频
 * 批量合并）、最近命令面（P-20261004-37 分诊数据面）。浏览器内存态——跨标签页
 * 无此数据（P-63 服务端运行态双轨的同款诚实边界）。由 store setup 调用一次，
 * 返回的 refs 并入 store state。
 */
export function useTerminalRuntimeState() {
  /** 会话粒度运行态（OSC 133 驱动；session 缺 key = 未知/未连接） */
  const runningMap = ref<Record<string, boolean>>({})
  /** 会话最近活动时间戳（OSC 133 任意事件驱动，ms epoch；缺 key = 无活动记录） */
  const activityMap = ref<Record<string, number>>({})
  /**
   * 会话最近命令面（P-20261004-37 分诊数据面）：E 事件记命令文本（「正在跑
   * 什么」），D 事件覆盖为 命令文本+退出码（「最后跑完什么、结果如何」）。
   * 与 runningMap/activityMap 同源同生命周期（OSC 133 事件、浏览器内存态）——
   * 分诊卡缺 key 时以「—」占位不虚构。只留最近一条（分诊只关心「最后在干
   * 什么」，不做历史——历史面是命令历史 API 的职责）
   */
  const lastCmdMap = ref<Record<string, { command?: string; exitCode?: number; at: number }>>({})

  const pendingActivity = new Map<string, number>()
  let activityFlushTimer: ReturnType<typeof setTimeout> | null = null
  function flushActivity() {
    activityFlushTimer = null
    if (pendingActivity.size === 0) return
    const merged = { ...activityMap.value }
    pendingActivity.forEach((ts, id) => { merged[id] = ts })
    pendingActivity.clear()
    activityMap.value = merged
  }

  // ============== 运行态 / 活动时间戳 / 最近命令（OSC 133 宿主写入） ==============
  /** OSC 133 事件上报：C=命令开始（运行点亮）、D=结束（熄灭）、E=命令文本
   *  （不影响运行态——E 在 C 与 D 之间到达，若据此熄灭会把运行点闪灭）。
   *  任意事件都刷新活动时间戳（「最近活动」排序依据）。
   *  活动时间戳写入分两档：C/D 是低频命令边界，即时写；E 随输出高频到达，
   *  批量合并（500ms 尾随刷写）限制排序/tooltip 的重算频率。
   *  detail（P-20261004-37 可选）：D 携 command+exitCode（最近命令+结果）、
   *  E 携 command（正在跑什么）——写 lastCmdMap 供停滞分诊卡装配现场。
   *  E 的到达频率 = 命令频率（一次命令至多一帧），直写无节流必要 */
  function reportOsc(id: string, type: 'C' | 'D' | 'E', detail?: { command?: string; exitCode?: number }) {
    if (type === 'C' || type === 'D') {
      runningMap.value = { ...runningMap.value, [id]: type === 'C' }
      pendingActivity.delete(id) // 即时写优先，避免批内旧值落盘覆盖
      activityMap.value = { ...activityMap.value, [id]: Date.now() }
      if (type === 'D') {
        lastCmdMap.value = {
          ...lastCmdMap.value,
          [id]: { command: detail?.command, exitCode: detail?.exitCode ?? 0, at: Date.now() },
        }
      }
      return
    }
    if (detail?.command) {
      lastCmdMap.value = { ...lastCmdMap.value, [id]: { command: detail.command, at: Date.now() } }
    }
    pendingActivity.set(id, Date.now())
    if (activityFlushTimer === null) {
      activityFlushTimer = setTimeout(flushActivity, 500)
    }
  }

  /** 会话消亡的本地清理（removeLocal 调用）：三张内存态表摘除该会话条目 */
  function clearSessionRuntimeState(id: string): void {
    delete runningMap.value[id]
    delete activityMap.value[id]
    delete lastCmdMap.value[id]
  }

  /** 对账剪枝（applySnapshot 调用）：存活集之外的孤儿条目清理（会话已不存在
   *  的运行态/活动/最近命令不再保留） */
  function pruneRuntimeState(alive: Set<string>): void {
    for (const id of Object.keys(runningMap.value)) {
      if (!alive.has(id)) delete runningMap.value[id]
    }
    for (const id of Object.keys(activityMap.value)) {
      if (!alive.has(id)) delete activityMap.value[id]
    }
    for (const id of Object.keys(lastCmdMap.value)) {
      if (!alive.has(id)) delete lastCmdMap.value[id]
    }
  }

  /** 仅供测试使用：清空运行态（含在途批量合并缓冲与定时器，用例隔离） */
  function resetRuntimeStateForTest(): void {
    runningMap.value = {}
    pendingActivity.clear()
    if (activityFlushTimer !== null) {
      clearTimeout(activityFlushTimer)
      activityFlushTimer = null
    }
    activityMap.value = {}
    lastCmdMap.value = {}
  }

  return {
    runningMap,
    activityMap,
    lastCmdMap,
    reportOsc,
    clearSessionRuntimeState,
    pruneRuntimeState,
    resetRuntimeStateForTest,
  }
}
