// 审批窗口过程实况录制域 API（P-20261001-15）
import type { AxiosRequestConfig } from 'axios'
import api from '../http'

/** 录制元数据索引（服务端 store.Recording；cast 文件走 artifacts 车道） */
export interface RecordingMeta {
  id: string
  sessionId?: string
  approvalIds: string[]
  agent?: string
  op?: string
  target?: string
  status: 'recording' | 'completed'
  startedAt: string
  stoppedAt?: string
  sizeBytes: number
}

export const recordingApi = {
  /** 元数据列表（最新在前）；approvalId=按审批标记过滤（审批卡入口） */
  list: (params?: { approvalId?: string; sessionId?: string; limit?: number }, config?: AxiosRequestConfig) =>
    api.get<{ data: RecordingMeta[] }>('/recordings', { params, ...config }),
  /** cast 回放源（asciinema v2 文本，服务端写盘前已遮蔽）；arraybuffer 走通用鉴权 */
  cast: (id: string, config?: AxiosRequestConfig) =>
    api.get(`/recordings/${id}/cast`, { responseType: 'arraybuffer', ...config }),
  /** 删除单条（隐私：屏幕实况可随时清除；活动录制先收尾） */
  remove: (id: string) => api.delete(`/recordings/${id}`),
}
