// 智能体任务进度快照域 API（P-20261004-120）
import api from '../http'
import type { AgentTaskProgressPayload } from '../../utils/agentTaskNotify'

/** GET /api/ops-tasks/active 单条：服务端 per-session 最近一条 task.progress
 *  瞬态快照（内存面——会话关闭即清、重启清空；发布口校验规整后的原始全量
 *  载荷原样在册，消费方按需取字段） */
export interface ActiveOpsTask {
  /** 会话归属（X-Session-ID 头优先，载荷 terminalId/sessionId 兜底） */
  sessionId: string
  /** 服务端收到时刻（unix 毫秒）：陈旧判活的诚实时钟——页面关闭期间的
   *  沉默在补账后立刻如实计入，而非从补账时刻重新起算 */
  receivedAt: number
  /** 最近一条全量载荷（task/status/step/steps/terminalId/summary…） */
  payload: AgentTaskProgressPayload
}

export const opsTaskApi = {
  /** 各会话最近一条 task.progress（receivedAt 升序）：悬浮球/进度卡/监控卡
   *  刷新后即时回填的数据面（OpsChannelBridge 挂载/重连补账），也是 agent
   *  「全舰队在跑什么」的一瞥可知巡检原语 */
  listActive: () => api.get<{ data: { tasks: ActiveOpsTask[]; serverTime: number } }>('/ops-tasks/active'),
}
