// 会话接续链域 API（P-20261004-38）：事件触发的 agent 串行接力——链源会话完成
// 链终态命中链定义即自动拉起下一棒。服务端形状见 server/api/agentchain/api.go
import api from '../http'

/** 链定义（store.AgentChain 服务端形状；触发占位符约定见 ops 手册 agent-chain 节） */
export interface AgentChain {
  id: string
  /** 链源终端会话 ID（task.progress 归属锚点；源会话关闭后链自动失效） */
  sourceTerminalId: string
  /** 下一棒任务指令模板（≤500 字节；{prevTask}/{prevStatus}/{prevStep} 触发时替换） */
  promptTemplate: string
  /** 下一棒运行时（空/auto = 按可用性选型） */
  runtime?: string
  dir?: string
  /** false（默认）= 仅源 done 触发；true = done/failed 都触发 */
  onFailure?: boolean
  createdAt: string
  /** 运行期事实（RecordTrigger 单点写入） */
  lastTriggeredAt?: string
  lastSessionId?: string
  /** launched / error:<发起失败摘要> */
  lastStatus?: string
  triggerCount?: number
}

/** 列表条目：链本体 + 服务端计算的源会话存活态与显示名（死链置灰可删） */
export interface AgentChainItem extends AgentChain {
  sourceAlive: boolean
  sourceName?: string
}

export interface AgentChainCreatePayload {
  sourceTerminalId: string
  promptTemplate: string
  runtime?: string
  dir?: string
  onFailure?: boolean
}

export const agentChainApi = {
  /** 新建链（创建时源会话须在册，否则 400 source session not found） */
  create: (payload: AgentChainCreatePayload) => api.post('/agent-chains', payload),
  /** 链列表（创建时间倒序 + sourceAlive/sourceName） */
  list: () => api.get('/agent-chains'),
  /** 删除链（已拉起的会话不受影响——链只管发起，不拥有会话生命周期） */
  remove: (id: string) => api.delete(`/agent-chains/${id}`),
}
