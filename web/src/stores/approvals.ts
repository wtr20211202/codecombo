import { defineStore } from 'pinia'
import { opsConfirmApi, type ApprovalHorizon } from '../api/domains/opsconfirm'
import type { ApprovalRecord } from '../api/domains/opsconfirm'
import { settingsApi } from '../api/domains/system'
import { registerReconnectRefetch } from '../composables/reconnectRefetch'

/** 全局审批档位（服务端 settings.agentApprovalMode 的前端镜像，P-20261003-316 四档）：
 *  ask=每次询问 / allow-session=会话级放行 / allow-24h=放行 24 小时（带过期）/
 *  allow=永久放行（历史「完全允许」，值语义不变） */
export type ApprovalMode = 'ask' | 'allow-session' | 'allow-24h' | 'allow'

/** horizon（裁决三选一）→ 全局档位映射：档位切换总走显式选择（同服务端语义） */
export const HORIZON_TO_MODE: Record<ApprovalHorizon, ApprovalMode> = {
  session: 'allow-session',
  '24h': 'allow-24h',
  always: 'allow',
}

/** 「最近裁决」就近回看条数上限（P-20261003-226 提案定值 10）：卡堆尾部下拉
 *  只回看最近的终态记录，列表增长不进前端（更早的走完整审计面） */
export const APPROVAL_RECENT_LIMIT = 10

/** 终态排序时间戳（resolvedAt 优先、createdAt 兜底）：无效/缺失按 0 沉底，
 *  不让脏时间戳抛异常断排序 */
function resolvedTsMs(a: ApprovalRecord): number {
  const v = new Date(a.resolvedAt || a.createdAt || '').getTime()
  return Number.isNaN(v) ? 0 : v
}

/**
 * 智能体操作审批（B4 约定式）：
 * - Agent 高危操作前经 POST /api/ops-confirm 请求确认，后端广播 approval.pending
 * - OpsChannelBridge 把 approval.* window 事件写入本 store
 * - ApprovalCards 全局卡片堆渲染 pending 项，「允许一次 / 拒绝 / 放行时限三选一」
 *   → resolve API
 * - 裁决结果经 approval.resolved 广播回流（多标签页一致清账）
 * - 最近裁决（P-20261003-226）：resolved 记录就近留存 recent（上限
 *   APPROVAL_RECENT_LIMIT），卡堆尾部下拉只读回看——误裁决后的快速对账出口
 * - 全局档位镜像（P-20261002-126 + P-20261003-316）：mode/expiresAt/sessionCount
 *   是 settings 的只读镜像，放行徽标（ApprovalModeBadge）据此常驻展示；初始恒
 *   ask——首查未回/拉取失败按保守态渲染（不亮徽标、卡片照常弹，宁缺勿滥）
 */
export const useApprovalsStore = defineStore('approvals', {
  state: () => ({
    /** id → 待裁决审批（resolved 即移除） */
    pending: {} as Record<string, ApprovalRecord>,
    /** 最近裁决（P-20261003-226）：resolved 记录就近回看源（新→旧，上限
     *  APPROVAL_RECENT_LIMIT）。三路汇入：seedPending 冷启动/重连带重建
     *  （同一列表响应顺带，零新增请求）+ 本页裁决 resolve 前捕获 + 他页裁决
     *  approval.resolved 广播捕获（后两者需本地有完整记录才有 op/target 可显，
     *  规则 deny 等本页从未见卡的记录跳过，下次 seed 重建自然补齐） */
    recent: [] as ApprovalRecord[],
    /** 全局审批档位镜像：ask=每次询问（默认）/ 其余为放行态（徽标常驻） */
    mode: 'ask' as ApprovalMode,
    /** allow-24h 档位到期时刻（ISO 串；空串=无时限）——徽标剩余时限渲染源 */
    expiresAt: '',
    /** allow-session 档位放行会话数（服务端映射条目数）——徽标会话级呈现源 */
    sessionCount: 0,
  }),
  getters: {
    pendingList(state): ApprovalRecord[] {
      return Object.values(state.pending)
    },
    pendingCount(state): number {
      return Object.keys(state.pending).length
    },
    /** 有 pending 审批的会话 id 集合（P-20261003-198）：静默标特化「等待裁决」的
     *  归属判定源——sessionId 与 terminal-sessions 会话 id 同域（P-161 卡头会话名
     *  同款关联）。pending 由人裁决、量级恒小，Set 重建无热路径顾虑 */
    pendingSessionIds(state): Set<string> {
      const ids = new Set<string>()
      for (const a of Object.values(state.pending)) {
        if (a.sessionId) ids.add(a.sessionId)
      }
      return ids
    },
    /** 放行态（徽标显隐的唯一判定出口）：三档放行模式任一在场即亮 */
    allowActive(state): boolean {
      return state.mode !== 'ask'
    },
    /** 永久放行态（历史 allowAll 语义保留给档位文案分支） */
    allowAll(state): boolean {
      return state.mode === 'allow'
    },
  },
  actions: {
    /** approval.pending 事件入站（后端广播完整记录） */
    upsert(a: ApprovalRecord) {
      if (!a?.id) return
      if (a.status === 'pending') this.pending[a.id] = a
      else this.markResolved(a.id, a.status)
    },
    /** 冷启动补账（P-20261003-130）：GET /ops-confirm 列表 pending 回填卡堆。
     *  本 store 平时只靠 approval.pending 广播入账——广播先于本页生命周期产生的
     *  pending（页面刷新/服务重启前已在等）无增量可收，agent 仍在轮询等待而裁决
     *  面消失。seed 与广播无序竞态无害：同 id 覆盖（多标签页幂等），广播先行时
     *  seed 重拉同记录；resolved 项只清不加（upsert 语义）。TTL 兼容（P-45）：过期
     *  项由服务端惰性翻转 + approval.resolved 广播清账，seed 不做本地过期判断 */
    async seedPending() {
      try {
        // 响应解包约定：axios 拦截器已返回 gin body，业务负载在 res.data。
        // 刻意不传 status/limit（P-20261003-254 默认全量语义）：本 seed 同时承担
        // pending 全量回填与「最近裁决」重建（P-20261003-226 权威补齐源，需完整
        // resolved 集）——单次全量响应两路消费零新增请求；值班大屏同链路已按
        // status=pending 收敛（见 MonitorView.seedApprovals）
        const res = (await opsConfirmApi.list()) as unknown as { data?: ApprovalRecord[] }
        const list = res?.data ?? []
        for (const a of list) {
          this.upsert(a)
        }
        // 「最近裁决」就地重建（P-20261003-226）：同一响应顺带零新增请求。与
        // 上方 upsert 循环同一 await 续体内同步执行（窗口广播只在宏任务边界
        // 派发，不会插进来），循环内 markResolved 的就地入账会被本重建整体
        // 取代——按服务端权威列表为准，天然去重；本页从未见过的终态记录
        // （如规则 deny 自动裁决、别的标签页更早的裁决）由此补齐
        this.recent = list
          .filter(a => a.status === 'allowed' || a.status === 'denied')
          .sort((x, y) => resolvedTsMs(y) - resolvedTsMs(x))
          .slice(0, APPROVAL_RECENT_LIMIT)
      } catch { /* 列表拉取失败不阻塞（WS 广播兜底增量） */ }
    },
    /** approval.resolved 事件入站（本标签页裁决或他处裁决的回流）。本地仍有
     *  完整记录时顺带入账「最近裁决」（P-20261003-226）——广播载荷只有
     *  id/status，op/target 从本地 pending 记录取；本地无记录（规则 deny 从
     *  未弹卡）时跳过不虚构，下次 seed 列表重建自然补齐 */
    markResolved(id: string, status?: string) {
      const local = this.pending[id]
      delete this.pending[id]
      // 结果词归一：信调用方给的（广播/upsert 传终态），缺省信本地记录自带
      // 终态（upsert 传完整 resolved 记录的路径）；两者皆无则结果不可如实
      // 呈现，不入账（宁缺勿错）
      const st = status === 'allowed' || status === 'denied'
        ? status
        : (local && (local.status === 'allowed' || local.status === 'denied') ? local.status : '')
      if (local && st) {
        this.pushRecent({ ...local, status: st, resolvedAt: local.resolvedAt || new Date().toISOString() })
      }
    },
    /** 「最近裁决」就地入账：新条目置顶，同 id 去重（双广播/重放幂等），
     *  上限截断保最新 */
    pushRecent(a: ApprovalRecord) {
      this.recent = [a, ...this.recent.filter(r => r.id !== a.id)].slice(0, APPROVAL_RECENT_LIMIT)
    },
    /** 档位镜像刷新：GET /settings 读 agentApprovalMode/expiresAt/sessionCount。
     *  触发点为应用启动与 settings.changed 广播（档位落盘/设置页改回均广播，
     *  多标签页一致跟随）；服务端 GET 已按有效档位归一（24h 过期回 ask），镜像
     *  可直接信任；失败静默保原值——镜像短暂陈旧可容忍，不弹错打断用户 */
    async refreshMode() {
      try {
        const res = (await settingsApi.get({ silent: true })) as unknown as {
          data?: { agentApprovalMode?: string; agentApprovalExpiresAt?: string; agentApprovalSessions?: number }
        }
        const m = res.data?.agentApprovalMode
        this.mode = m === 'allow' || m === 'allow-session' || m === 'allow-24h' ? m : 'ask'
        this.expiresAt = res.data?.agentApprovalExpiresAt || ''
        this.sessionCount = res.data?.agentApprovalSessions || 0
      } catch { /* 拉取失败保持原值 */ }
    },
    /** 用户裁决：成功后本地即清（广播回流兜底他处同步）；always=永久档（历史字段）；
     *  horizon=放行时限三选一（P-20261003-316，携带时优先于 always）；
     *  reason=拒绝理由（可选，仅 deny 语义，透传给 resolve API） */
    async resolve(id: string, allow: boolean, always = false, reason = '', horizon: ApprovalHorizon | '' = '') {
      await opsConfirmApi.resolve(id, allow, always, reason, horizon)
      // 带终态清账：markResolved 就地捕获本页 pending 记录入账「最近裁决」
      // （P-20261003-226 误裁决回查的主路径——本页裁决的 op/target 此刻在手）
      this.markResolved(id, allow ? 'allowed' : 'denied')
      // 放行档位裁决 = 后端已落盘：mode/expiresAt 本地同帧镜像（不等 settings.changed
      // 广播回流；广播兜底其余标签页）。24h 到期时刻本地同帧起算，广播回流校正精确值。
      // 会话计数**不本地自增**：settings.changed 广播在服务端授予之后发出，本页收到
      // 广播触发的 refreshMode 读到的已含本次授予——再叠加本地 +1 即双计（run14
      // 实测徽标「2 个会话」而服务端权威 1，两轮全量复现；+1 先于/后于广播镜像
      // 落地的次序竞态，错值且无后续广播纠正）。改为就地拉一次镜像：与广播触发
      // 的 refreshMode 同读服务端真值，双 GET 同值幂等收敛，计数不再有第二写者
      if (allow && horizon) {
        this.mode = HORIZON_TO_MODE[horizon]
        this.expiresAt = horizon === '24h'
          ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
          : ''
        if (horizon === 'session') void this.refreshMode()
      } else if (allow && always) {
        this.mode = 'allow'
        this.expiresAt = ''
      }
    },
  },
})

// 重连补拉注册（P-20261003-236）：ops 通道重连后的 pending 补账不再由
// OpsChannelBridge 逐域手写清单，登记进集中注册表（composables/reconnectRefetch.ts）
// 由各重连触发点统一遍历执行；闭包内懒取 store，装配期不依赖活动 pinia
registerReconnectRefetch('approvals', () => { void useApprovalsStore().seedPending() })
