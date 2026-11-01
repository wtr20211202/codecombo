// 智能体结构化提问域 API（P-20261001-27）
import api from '../http'

export interface AskRecord {
  id: string
  terminalId?: string // 归属终端会话（发起方经 CC_TERMINAL_ID 自标识）
  agent?: string // 发起方智能体类型（claude/codex/dsh/shell，服务端按会话运行时反查；空=未知）
  question: string
  options?: string[] // 可选项（非空时前端以按钮作答）
  status: 'pending' | 'answered' | 'expired'
  answer?: string
  createdAt?: string
  answeredAt?: string
  expiresAt?: string
}

export const opsAskApi = {
  /** 作答（用户侧）：自由文本或选项原文；仅 pending 可答（先到者为准） */
  answer: (id: string, answer: string) =>
    api.post(`/ops-ask/${id}/answer`, { answer }),
  /** 列表（值班大屏冷启动补账/诊断用） */
  list: () => api.get<{ data: AskRecord[] }>('/ops-ask'),
}
