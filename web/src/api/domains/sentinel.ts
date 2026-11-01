// 输出哨兵域 API（P-20261004-8）：终端输出模式订阅规则 CRUD。
// 匹配在服务端输出 tap（滑窗+防抖护栏复用端口探测基建），前端只管规则面
import type { AxiosRequestConfig } from 'axios'
import api from '../http'

/** SentinelRule 哨兵规则（与服务端 store.SentinelRule 同形）：
 * pattern 为 RE2 正则（服务端编译校验）；scope "global"=全部会话 / projectId；
 * level 决定通知条目样式 */
export interface SentinelRule {
  id: string
  name: string
  pattern: string
  /** 'global' | projectId（空串按 global 处理，服务端写 canonical 值） */
  scope: string
  /** info | warning | error */
  level: string
  createdAt: string
  updatedAt: string
}

export type SentinelRuleInput = Omit<SentinelRule, 'id' | 'createdAt' | 'updatedAt'>

/** SentinelProbeResult 服务端真跑单规则结果（与服务端 terminal.SentinelProbeResult 同形）：
 * hit=false 且 error 非空 = 该模式 RE2 编译失败；matched 为命中行摘录 */
export interface SentinelProbeResult {
  ruleId: string
  hit: boolean
  matched?: string
  error?: string
}

export interface SentinelProbeResponse {
  results: SentinelProbeResult[]
  /** 样例被服务端钳制（500 行/128KB）——「仅试跑前缀」须如实告知 */
  truncated: boolean
}

// 规则 CRUD；silent：拦截器已弹 toast，调用方本地再弹会双提示
export const sentinelApi = {
  list: (config?: AxiosRequestConfig) => api.get<{ data: SentinelRule[] }>('/sentinels', config),
  create: (data: SentinelRuleInput) => api.post<{ data: SentinelRule }>('/sentinels', data, { silent: true }),
  update: (id: string, data: Partial<SentinelRuleInput>) =>
    api.put<{ data: SentinelRule }>(`/sentinels/${id}`, data, { silent: true }),
  remove: (id: string) => api.delete(`/sentinels/${id}`, { silent: true }),
  /** 服务端真跑（P-20261004-107）：内联规则（不落库）经生产同路径滑窗引擎喂样例，
   * RE2 精确语义逐规则返回命中——测试框双档之「精确档」。非静默：显式动作失败
   * 由拦截器 toast 反馈 */
  test: (data: { rules: Array<{ id: string; pattern: string }>; sample: string }) =>
    api.post<{ data: SentinelProbeResponse }>('/sentinels/test', data),
}
