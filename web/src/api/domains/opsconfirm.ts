// 智能体操作审批域 API（B4）
import type { AxiosRequestConfig } from 'axios'
import api from '../http'

/** 放行时限档位（P-20261003-316 三选一）：session=会话级 / 24h=全局带过期 / always=永久 */
export type ApprovalHorizon = 'session' | '24h' | 'always'
/** 结构化影响面（P-20261003-319）：agent 发起审批时可选附带的裁决速读摘要——
 *  审批卡顶部徽标行数据源（kind 类型徽标 + 一句话 summary + filesCount 计数 +
 *  关键命令清单）。服务端已就地校验（枚举+上限，坏载荷 400），前端按可信形态消费 */
export interface ApprovalImpact {
  kind: 'delete' | 'reset' | 'push-force' | 'remote-exec' | 'deploy' | 'other'
  summary: string
  filesCount?: number
  commands?: string[]
}

/** 合并审批挂起条目（P-20261006-26）：主卡 merged 清单元素——同会话同型操作
 *  入队等待、随主卡同裁决的请求快照（op 与主卡相同不重复携带；target 服务端
 *  已脱敏，卡面渲染另有 maskApprovalSecrets 兜底） */
export interface ApprovalMergedItem {
  id: string
  target?: string
  createdAt?: string
}

export interface ApprovalRecord {
  id: string
  sessionId?: string
  agent?: string // 发起方智能体类型（claude/codex/dsh/shell，服务端按会话运行时反查；空=未知）
  op: string
  target?: string
  detail?: string
  impact?: ApprovalImpact // 结构化影响面（P-20261003-319，可选；未附带=老卡不渲染徽标行）
  status: 'pending' | 'allowed' | 'denied'
  reason?: string // 拒绝理由（P-20261003-21：denied 时回传给发起 agent 调整方案；无理由/allowed 缺省）
  createdAt?: string
  resolvedAt?: string
  // 合并审批（P-20261006-26）：mergedInto 非空 = 本记录是主卡挂起队列条目
  // （pending 形态不出现在列表/广播——展示由主卡 merged 清单承载，终态后照常
  // 进历史审计）；merged = 主卡携带的挂起队列快照（「+N 同型待批」数据源）
  mergedInto?: string
  merged?: ApprovalMergedItem[]
  ruleHit?: string // 命中的审批规则 opPattern（P-20261003-35，服务端 AgentApproval.RuleHit 出参镜像，未命中缺省——模式自学习检测 P-20261006-28 据此排除规则裁决的记录） 34363d05 (feat(web): 审批模式自学习建议——手动允许升格为规则 (P-20261006-28))
}

export const opsConfirmApi = {
  /** 裁决（用户侧）：allow=true 即「允许一次」；always=true 完全允许=永久档（历史字段，
   *  兼容保留）；horizon 放行时限三选一（P-20261003-316，携带时优先于 always）；
   *  reason 拒绝理由（可选，仅 deny 语义——空串不下发，与原行为零变化） */
  resolve: (id: string, allow: boolean, always = false, reason = '', horizon: ApprovalHorizon | '' = '') => {
    const body: Record<string, unknown> = { allow, always }
    if (reason) body.reason = reason
    if (horizon) body.horizon = horizon
    return api.post(`/ops-confirm/${id}/resolve`, body)
  },
  /** 列表（诊断/管理用）。可选过滤（P-20261003-254，均不传=全量兼容既有消费方）：
   *  status 按状态过滤（pending|allowed|denied；补账场景传 pending——裁决队列
   *  全量、量级恒小不随历史增长）；limit 取最新 N 条（1..500，历史查看收敛 payload）。
   *  historyForOp（P-20261005-173 同类历史查询）：传完整 op 串按字面精确匹配回
   *  最近已裁决记录（服务端固定 resolved-only + 最新在前 + 钳 3 条，status/limit
   *  在该查询面被忽略）——审批卡「同类历史」弱行数据源 */
  list: (params?: { status?: ApprovalRecord['status']; limit?: number; historyForOp?: string }) =>
    api.get<{ data: ApprovalRecord[] }>('/ops-confirm', { params }),
  /** 裁决历史 CSV 导出（P-20261003-247）：服务端全量转 CSV 附件（审计 CSV
   *  同模式，含公式注入防护）。blob 接收——axios 拦截器自动带 X-Lock-Token
   *  （直链点击不带解锁头会 423），拦截器只回 data 不透 Content-Disposition，
   *  下载名客户端合成（audit/claude 导出同款）；timeout 0：全量导出不设超时 */
  exportCsv: (config?: AxiosRequestConfig) =>
    api.get('/ops-confirm/export', { responseType: 'blob', timeout: 0, ...config }) as unknown as Promise<Blob>,
}
