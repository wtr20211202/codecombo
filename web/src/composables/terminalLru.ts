// 终端 xterm 实例 LRU 释放记账（P-20261007-21）：每个终端会话持一个活 xterm
// 实例（行 buffer 拉满 ≈40MB/会话），重度多会话用户的后台 tab 是纯内存浪费——
// 服务端 ScrollbackBuffer 本就缓存全部历史（attach/重连重放基建在位），xterm
// 是可丢弃可恢复的渲染层缓存副本。本模块只做记账与驱逐决策（谁、何时），
// 释放动作由会话自持的 evict 回调执行（useTerminalSession：dispose 渲染层 +
// WS 换 headless 轻量管线），恢复走既有 connect()（makeTerminalWs + 服务端
// scrollback 重放，与网络断线重连同码路径）。
//
// 预算语义：至多保 TERMINAL_LRU_KEEP 个「最近使用」的实例；超额只从「当前
// 不可见」的会话里按最久未用驱逐——可见 pane（活跃 tab / split 双 pane /
// 浮动窗）是用户视线所在，永不驱逐。可见 pane 数超过预算时允许暂时超额
// （上界 = 可见面数，有界），不为省内存驱逐用户正看着的会话。
//
// 记账形态沿 createWriteStormTracker / createDeferredWriteQueue 惯例：
// 纯工厂（单测确定性构造）+ 模块级单例（termInstances 同款全宿主共享）。

/** 驻留实例数预算（K）：起步常量，暂不做设置项 */
export const TERMINAL_LRU_KEEP = 4

export interface TerminalLruStats {
  /** 当前登记的活实例数（已被驱逐、未重挂的会话不在册） */
  live: number
  /** 预算上限（观测面展示用） */
  keep: number
  /** 本窗口累计驱逐次数（重挂恢复不回退） */
  evicted: number
}

export interface TerminalLru {
  /** connect 时注册驱逐回调（entry ⇔ 活实例严格同生命周期）；重复注册（驱逐
   *  后重挂）幂等覆盖，回调以最新闭包为准 */
  register(sessionId: string, evict: () => void): void
  /** pane 卸载（会话关闭/宿主销毁）时摘账。带所有权比对（disposeInstance 的
   *  ownerTerm 守卫同哲学）：双挂接窗口期新 pane 已覆盖注册时，旧 pane 的
   *  卸载不得摘走接管者的条目（闭包不同 = 非登记者） */
  release(sessionId: string, evict: () => void): void
  /** 可见性记账（TerminalPane IntersectionObserver 现场回报）：可见=激活
   *  （刷新最近使用 + 执行预算），隐藏=成为可驱逐候选（执行预算——挂载期
   *  fail-open 可见窗错过驱逐的在这里收敛） */
  setVisible(sessionId: string, visible: boolean): void
  stats(): TerminalLruStats
}

export function createTerminalLru(): TerminalLru {
  const entries = new Map<string, { lastUsed: number; visible: boolean; evict: () => void }>()
  let evicted = 0

  // 预算执行：超额部分从不可见会话按最久未用驱逐。只在记账事件（注册/可见性
  // 翻转）后触发——这些都是实例分配/预算信息变化时刻，无需定时器
  function enforce(): void {
    const excess = entries.size - TERMINAL_LRU_KEEP
    if (excess <= 0) return
    const victims = [...entries.entries()]
      .filter(([, e]) => !e.visible)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    for (let i = 0; i < excess && i < victims.length; i++) {
      const [id, entry] = victims[i]!
      // 先摘账再驱逐：evict 内部可能同步触发重挂类记账路径，账先落地保证
      // entries 与活实例集始终一致（stats 不虚计已释放实例）
      entries.delete(id)
      evicted++
      entry.evict()
    }
  }

  return {
    register(sessionId, evict) {
      // fail-open 按可见登记（P-20261004-46 同款口径）：IO 首次回调前不可驱逐，
      // 防止挂载/连接中的 pane 被误逐；隐藏态由随后 setVisible(false) 修正
      entries.set(sessionId, { lastUsed: Date.now(), visible: true, evict })
      enforce()
    },
    release(sessionId, evict) {
      const entry = entries.get(sessionId)
      if (entry && entry.evict === evict) entries.delete(sessionId)
    },
    setVisible(sessionId, visible) {
      const entry = entries.get(sessionId)
      if (!entry) return
      entry.visible = visible
      if (visible) entry.lastUsed = Date.now()
      enforce()
    },
    stats() {
      return { live: entries.size, keep: TERMINAL_LRU_KEEP, evicted }
    },
  }
}

// 模块级单例：全部终端宿主（项目终端 / agent 会话 pane / 远程控制台——都经
// TerminalPane → useTerminalSession）共用一份预算
export const terminalLru = createTerminalLru()
