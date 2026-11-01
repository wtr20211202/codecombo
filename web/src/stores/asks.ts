import { defineStore } from 'pinia'
import { opsAskApi } from '../api/domains/opsask'
import type { AskRecord } from '../api/domains/opsask'
import { registerReconnectRefetch } from '../composables/reconnectRefetch'

/**
 * 智能体结构化提问（P-20261001-27）：
 * - Agent 长任务需要用户输入时经 POST /api/ops-ask 提问，后端广播 input.request
 * - OpsChannelBridge 把 input.* window 事件写入本 store
 * - AskCards 全局卡片堆渲染 pending 项（自由文本/选项按钮双形态），作答 → answer API
 * - 作答结果经 input.resolved 广播回流（多标签页一致清账）
 * - 未答问题 30 分钟 TTL：到点卡片自清（expiresAt 倒计时，服务端惰性翻转 + 周期清理兜底）
 */
export const useAsksStore = defineStore('asks', {
  state: () => ({
    /** id → 待回答提问（answered/expired 即移除） */
    pending: {} as Record<string, AskRecord>,
  }),
  getters: {
    pendingList(state): AskRecord[] {
      return Object.values(state.pending)
    },
    pendingCount(state): number {
      return Object.keys(state.pending).length
    },
  },
  actions: {
    /** input.request 事件入站（后端广播完整记录） */
    upsert(a: AskRecord) {
      if (!a?.id) return
      if (a.status === 'pending') this.pending[a.id] = a
      else this.markResolved(a.id)
    },
    /** input.resolved 事件入站（本标签页作答或他处作答的回流） */
    markResolved(id: string, status?: string) {
      void status
      delete this.pending[id]
    },
    /** 冷启动/重连补账（P-20261001-19）：GET /ops-ask 列表 pending 回填卡堆。
     *  本 store 平时只靠 input.request 广播入账——ops 通道断线窗口期产生的
     *  提问（广播不可回放）无增量可收，agent 仍在轮询等待而提问卡消失。
     *  与审批 seedPending（P-20261003-130）同模式：列表与广播无序竞态无害
     *  （同 id 覆盖），非 pending 项经 upsert 走清账语义；TTL 过期项由服务端
     *  惰性翻转后随列表自然清掉，不做本地过期判断 */
    async seedPending() {
      try {
        // 响应解包约定：axios 拦截器已返回 gin body，业务负载在 res.data
        const res = (await opsAskApi.list()) as unknown as { data?: AskRecord[] }
        for (const a of res?.data ?? []) {
          this.upsert(a)
        }
      } catch { /* 列表拉取失败不阻塞（WS 广播兜底增量） */ }
    },
    /** TTL 到点自清（AskCards 定时巡查；服务端广播不覆盖过期——惰性翻转发生在轮询侧） */
    pruneExpired(now = Date.now()) {
      for (const id of Object.keys(this.pending)) {
        const exp = this.pending[id]?.expiresAt
        if (exp && new Date(exp).getTime() <= now) delete this.pending[id]
      }
    },
    /** 用户作答：成功后本地即清（广播回流兜底他处同步） */
    async answer(id: string, answer: string) {
      await opsAskApi.answer(id, answer)
      this.markResolved(id)
    },
  },
})

// 重连补拉注册（P-20261003-236）：与 approvals 域同款——断线窗口期的
// input.request 广播不可回放，任一通道重连后经集中注册表统一补账
registerReconnectRefetch('asks', () => { void useAsksStore().seedPending() })
