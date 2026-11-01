import { defineStore } from 'pinia'
import { terminalApi } from '../api/domains/terminal'
import type { SessionQueueEntry } from '../api/domains/terminal'

/**
 * 运行中会话的指令队列（P-20261003-248，前端感知层）：
 * - 数据事实源在服务端（车道 1 kind agentsessionqueue + 回执触发引擎），本
 *   store 只做取数缓存与写口封装——自动发送由服务端完成回执驱动（浏览器关着
 *   照发），前端负责排队输入/编辑删除/降级注记/手动发送
 * - 批量读一次拉全量（GET /terminals/queues 只回存有排队指令的在册会话），
 *   侧栏徽标与面板共用同一份；完成回执到达时整表刷新（自动发送后队列变短
 *   的唯一感知通道——服务端无队列推送事件）
 * - 手动发送复用 broadcast-write 既有写入面（成功后整表替换摘除该条）：
 *   自动发送停摆（智能体对某条不上报终态）时的兜底出口
 */

/** 单条排队指令的视图形状（服务端 queuedAt ISO 串，前端只展示不解析） */
export interface AgentQueueItemView {
  text: string
  queuedAt: string
}

/** 单会话队列视图（items 队首在前） */
export interface AgentQueueView {
  items: AgentQueueItemView[]
  /** 会话最近 task.progress 上报为 running */
  busy: boolean
  /** 完成回执可自动发送；false = 会话无进度上报数据（降级手动发送注记） */
  autoSend: boolean
}

export const useAgentQueueStore = defineStore('agentQueue', {
  state: () => ({
    /** 会话 id → 队列视图（缺席 = 无排队指令） */
    queues: {} as Record<string, AgentQueueView>,
    /** 是否已完成过一次全量拉取（徽标渲染前的前置条件） */
    loaded: false,
    /** 拉取互斥（receipt 风暴下的重复请求收口） */
    loading: false,
  }),
  getters: {
    /** 会话排队条数（会话行徽标；未加载过返回 0） */
    countFor(state): (sessionId: string) => number {
      return (sessionId: string) => state.queues[sessionId]?.items.length ?? 0
    },
    /** 是否存在任意排队指令（侧栏入口徽标） */
    hasAny(state): boolean {
      return Object.keys(state.queues).length > 0
    },
  },
  actions: {
    /** 全量拉取（侧栏挂载首拉 + 回执到达 + 写操作后对账；失败静默保旧值） */
    async refreshAll(): Promise<void> {
      if (this.loading) return
      this.loading = true
      try {
        // 响应解包约定：axios 拦截器已返回 gin body，业务负载在 res.data
        const res = (await terminalApi.listQueues()) as unknown as { data?: { queues?: SessionQueueEntry[] } }
        const next: Record<string, AgentQueueView> = {}
        for (const q of res?.data?.queues ?? []) {
          const items = (q.items ?? []).map(i => ({ text: i.text, queuedAt: i.queuedAt }))
          if (items.length === 0) continue // 空队列与缺席同义（applyEntry 同口径）
          next[q.sessionId] = {
            items,
            busy: q.busy === true,
            autoSend: q.autoSend === true,
          }
        }
        this.queues = next
        this.loaded = true
      } catch {
        // 拉取失败保旧值：队列视图是缓存不是事实源，下次回执/写操作再对账
      } finally {
        this.loading = false
      }
    },
    /** 排队入尾：返回是否被服务端即时发送（idle 场景，UI 据此提示「已立即发送」） */
    async enqueue(sessionId: string, text: string): Promise<boolean> {
      // 响应解包约定：axios 拦截器已返回 gin body（{data: entry, sent}）——
      // 业务负载在 res.data，与 asks store 的 cast 同款
      const res = (await terminalApi.enqueueQueueItem(sessionId, text)) as unknown as { data: SessionQueueEntry; sent?: boolean }
      this.applyEntry(res.data)
      return res.sent === true
    },
    /** 整表替换（编辑/删除/重排共用；items 为纯文本数组，队首在前） */
    async updateItems(sessionId: string, items: string[]): Promise<void> {
      const res = (await terminalApi.replaceQueueItems(sessionId, items)) as unknown as { data: SessionQueueEntry }
      this.applyEntry(res.data)
    },
    /** 手动发送第 index 条（降级路径 / 停摆兜底）：broadcast-write 直写
     *  PTY（尾部 \r 执行语义）+ 成功后整表摘除。失败向上抛，交宿主提示 */
    async sendNow(sessionId: string, index: number): Promise<void> {
      const q = this.queues[sessionId]
      if (!q || index < 0 || index >= q.items.length) return
      const text = q.items[index]!.text
      const body = text.length > 0 && !/[\r\n]$/.test(text) ? text + '\r' : text
      await terminalApi.broadcastWrite([sessionId], body)
      await this.updateItems(sessionId, q.items.filter((_, i) => i !== index).map(i => i.text))
    },
    /** 队列已变（OpsChannelBridge queue.changed 分发）：服务端弹队首后广播，
     *  前端拉全量对账——徽标/面板的实时感知通道。弹出先于广播，收到即刷必
     *  读到发送后队列态；未加载过 = 本页无消费面板，刷新跳过 */
    onQueueChanged(): void {
      if (!this.loaded) return
      void this.refreshAll()
    },
    /** 服务端视图写回本地缓存（写口/刷新共用） */
    applyEntry(entry: SessionQueueEntry): void {
      const items = (entry.items ?? []).map(i => ({ text: i.text, queuedAt: i.queuedAt }))
      if (items.length === 0) {
        delete this.queues[entry.sessionId]
        return
      }
      this.queues[entry.sessionId] = {
        items,
        busy: entry.busy === true,
        autoSend: entry.autoSend === true,
      }
    },
    /** 会话关闭清账（terminals.changed 对账调用）：死会话的本地视图即刻消失 */
    dropSession(sessionId: string): void {
      delete this.queues[sessionId]
    },
    /** 仅供测试使用：清空全部状态 */
    resetForTest(): void {
      this.queues = {}
      this.loaded = false
      this.loading = false
    },
  },
})
