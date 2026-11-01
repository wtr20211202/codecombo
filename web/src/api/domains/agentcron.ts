// 定时智能体任务域 API（P-20261002-43）
import type { AxiosRequestConfig } from 'axios'
import api from '../http'

/** AgentCron 定时任务（与服务端 store.AgentCron 同形）：
 * 每日 HH:MM + 周几集合（空 = 每日），prompt ≤500 字节经 launchArgs 通道注入 */
export interface AgentCron {
  id: string
  name: string
  hour: number
  minute: number
  /** 0=周日…6=周六；空 = 每天 */
  weekdays?: number[]
  /** 底层运行时（'' = auto；shell/claude/codex/dsh/自定义注册名） */
  runtime?: string
  prompt: string
  dir?: string
  /** 评估时区（P-20261005-217，可选）：IANA 名（如 Asia/Shanghai），空 = 按
   * 服务器时区评估（存量任务行为不变）。服务端保存口校验 LoadLocation */
  timezone?: string
  enabled: boolean
  /** 错过补偿：服务停机跨过触发点时启动后补跑一次 */
  missCatchUp?: boolean
  /** 触发类型（P-20261003-124）：'' / schedule = 定时；after = 前序完成触发
   * （不再按时刻调度，由父任务完成回执驱动） */
  trigger?: string
  /** 父任务 ID（trigger=after 时必填；服务端保存口校验存在性与成环） */
  afterCronId?: string
  /** 完成触发档位：'' / success = 成功才触发；always = 完成即触发（失败也级联） */
  afterMode?: string
  /** 接力源（P-20261005-207 自动续命）：'' = 不接力；'latest' = 项目（dir）
   * 最近已结束 claude 会话动态解析；其余非空 = 显式会话 id（失效触发期降级） */
  relayFrom?: string
  /** 指标抽取规则（P-20261005-237，缺省关）：正则首个命名捕获组承载数值，或
   * `json:` 前缀 + 点分路径；完成回执落定时从输出尾窗取值入时序 */
  extract?: string
  lastRunAt?: string
  /** launched / done / failed / skipped / error:<msg> */
  lastResult?: string
  /** 最近一次接力解析时刻（服务端 RecordRelay 单点写，用户编辑不可触碰） */
  lastRelayAt?: string
  /** relayed = 已注入前言；skipped: <原因> = 降级无前言（任务照常发起） */
  lastRelayNote?: string
  /** 最近运行历史（最新在尾，服务端环形截断 20 条；P-20261002-143） */
  history?: AgentCronRunEntry[]
  /** 最近错过槽历史（P-20261006-22，最新在尾，服务端环形截断 20 条；无错过 =
   * 键缺席。巡检 agent 可编程读「昨晚哪些任务错过」——值守简报数据源之一） */
  missedHistory?: AgentCronMissedEntry[]
  createdAt: string
  updatedAt: string
}

/** AgentCronRunEntry 单次运行历史条目（与服务端 store.AgentCronRun 同形） */
export interface AgentCronRunEntry {
  at: string
  /** 与 lastResult 同词汇：launched / done / failed / skipped / error:<msg> */
  result: string
  /** 失败/跳过摘要（≤120 rune，成功路径为空） */
  errSummary?: string
}

/** AgentCronMissedEntry 单次错过槽条目（与服务端 store.AgentCronMissed 同形）：
 * slot 是计划槽点（错过即该槽没跑），补跑自身的运行终态照常落 history */
export interface AgentCronMissedEntry {
  slot: string
  /** skipped = 未开补偿只标记（灰）；caught-up = 补跑发起成功（绿）；
   * failed = 补跑发起失败（红，errSummary 带错误摘要） */
  action: 'skipped' | 'caught-up' | 'failed'
  errSummary?: string
}

/** CronMetricPoint 任务指标时序单点（与服务端 store.CronMetricPoint 同形） */
export interface CronMetricPoint {
  at: string
  value: number
}

/** CronMetricSeries 列表透出的指标时序（P-20261005-237，配置 extract 且已有
 * 抽取点时在位）：name = 指标名（规则派生：正则命名组 / json 路径末段），
 * points 时间升序（旧→新）；无数据 = 键缺席（服务端不以空数组冒充） */
export interface CronMetricSeries {
  name: string
  points: CronMetricPoint[]
}

/** AgentCronServerTZ 列表载荷 server 段（P-20261005-217，跨时区部署的对表
 * 数据面）：name = 服务器时区名（仅展示参考）；now = 服务器当前时刻
 * RFC3339（自带数字偏移，壁钟部分即服务器本地时刻）；utcOffset = 数字偏移
 * 归一形态（+08:00）。旧前端零触及的增量键 */
export interface AgentCronServerTZ {
  name: string
  now: string
  utcOffset: string
}

/** 列表载荷：任务本体 + 服务端计算的下次触发预览（与调度判定同一实现；
 * after 任务为 null——事件驱动无时刻概念）+ 指标时序段 + 服务器时区快照 */
export interface AgentCronItem extends AgentCron {
  nextRunAt: string | null
  metric?: CronMetricSeries
}

/** 列表响应：items + 服务器时区快照（评估时区标注与对表展示用） */
export interface AgentCronListResult {
  data: AgentCronItem[]
  server?: AgentCronServerTZ
}

/** 试跑返回（LaunchAgentSession 快照） */
export interface AgentCronRunResult {
  id: string
  name: string
  path: string
  runtime: string
  launched: boolean
}

/** 保存载荷：服务端全量替换可编辑字段——trigger 三字段、relayFrom 与 timezone
 * 必须显式携带，否则会把既有依赖/接力/时区配置清掉（store applyEditable 替换
 * 语义） */
export type AgentCronPayload = Omit<AgentCron, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastResult' | 'lastRelayAt' | 'lastRelayNote'>

// 定时任务 CRUD + 立即试跑；silent：拦截器已弹 toast，调用方本地再弹会双提示
export const agentCronApi = {
  list: (config?: AxiosRequestConfig) => api.get<AgentCronListResult>('/agent-crons', config),
  create: (data: AgentCronPayload) =>
    api.post<{ data: AgentCronItem }>('/agent-crons', data, { silent: true }),
  update: (id: string, data: AgentCronPayload) =>
    api.put<{ data: AgentCronItem }>(`/agent-crons/${id}`, data, { silent: true }),
  remove: (id: string) => api.delete(`/agent-crons/${id}`, { silent: true }),
  run: (id: string) => api.post<{ data: AgentCronRunResult }>(`/agent-crons/${id}/run`, undefined, { silent: true }),
}
