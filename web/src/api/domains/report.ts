// 日报存档域 API（P-20261003-4）：服务端每日日报落档（14 天滚动保留）的
// 回看口——列表 + 单日详情——与手动触发生成（补跑/重发）。聚合语义在服务端
// server/report（与日报通知同源），本文件只做类型化的端口封装
import type { AxiosRequestConfig } from 'axios'
import api from '../http'

// 单项目单日日报存档（与通知 msgParams 同一聚合口径；差异：tokens 为原始
// 数值跨天可比——紧凑展示归前端 fmtTokens，commitSubjects 为当日提交主题明细）
export interface DailyReportEntry {
  date: string           // YYYY-MM-DD（服务器本地时区）
  projectId: string
  projectName: string
  commits: number
  commitSubjects?: string[]
  sessions: number       // 当日活跃 claude 会话数
  tokens: number         // 当日 token 消耗（原始值）
  cmds: number           // 当日终端命令数
  approvalsPending: number // 实例级事实（发报时刻快照，随每条存档附带）
  approvalsDone: number
  deploysOk: number
  deploysFail: number
}

// 实例单日活动序列行（P-20261003-37）：日报发报链随存档顺带 upsert 的旁路
// 投影，实例级聚合（无项目维度），365 天滚动保留
export interface ActivityDayEntry {
  date: string    // YYYY-MM-DD（服务器本地时区）
  commits: number
  sessions: number
  commands: number
}

export const reportApi = {
  // 最近存档倒序（date 降序、同日按项目 ID 升序）；limit 服务端钳制 ≤200。
  // as unknown 断言：响应拦截器已解包 response.data，调用方拿到的 res 即响应体
  listDaily: (limit?: number, config?: AxiosRequestConfig) =>
    api.get<{ data: DailyReportEntry[] }>('/reports/daily', { params: limit ? { limit } : undefined, ...config }) as unknown as Promise<{ data?: DailyReportEntry[] }>,
  // 单日全部项目存档；该日无存档返回空列表（空日是常态非错误）
  dailyDetail: (date: string, config?: AxiosRequestConfig) =>
    api.get<{ data: DailyReportEntry[] }>(`/reports/daily/${date}`, config) as unknown as Promise<{ data?: DailyReportEntry[] }>,
  // 手动生成一轮日报：缺省今天（投递通知+落档），传历史日只补档不投递
  runDaily: (date?: string, config?: AxiosRequestConfig) =>
    api.post<{ sent: number; date: string }>('/reports/daily/run', date ? { date } : {}, config) as unknown as Promise<{ sent: number; date: string }>,
  // 最近 days 天实例活动序列（date 升序，旧→新，热力图列序直铺）；days 缺省
  // = 服务端全保留窗口（≤365），季度视图由调用方传 91 自取
  listActivity: (days?: number, config?: AxiosRequestConfig) =>
    api.get<{ data: ActivityDayEntry[] }>('/reports/activity', { params: days ? { days } : undefined, ...config }) as unknown as Promise<{ data?: ActivityDayEntry[] }>,
}
