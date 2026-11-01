// 环境画像域 API（P-20261007-14）：项目环境只读聚合面——dev 端口观测 +
// 可见哨兵规则 + 部署目标摘要一页「环境简历」。纯读无写；服务端源级降级
// （读失败的键整体缺席），消费方以 undefined 区分「无」与「源降级」
import type { AxiosRequestConfig } from 'axios'
import api from '../http'

/** EnvProfileDevPort 画像端口行：登记条目 + 读取时反查的会话名。
 * source: detected=终端输出探测 / reported=agent 上报；lastSeen 是最近一次
 * 观测刷新时刻（画像=历史观测聚合非实时拓扑，端口可能已死仍列供参考） */
export interface EnvProfileDevPort {
  port: number
  label: string
  source: string
  firstSeen: string
  lastSeen: string
  sessionId?: string
  sessionName?: string
}

/** EnvProfileSentinel 画像哨兵行：该项目可见的输出哨兵规则元数据
 * （scope "global"=全部会话 / projectId；正则明细走 sentinelApi.list） */
export interface EnvProfileSentinel {
  id: string
  name: string
  /** info | warning | error（通知条目样式同词表） */
  level: string
  scope: string
}

/** EnvProfileDeployTarget 画像部署目标行：只出摘要——主机名/协议/认证形态；
 * 地址与凭据字段服务端刻意不出（fleet「只出摘要」纪律） */
export interface EnvProfileDeployTarget {
  id: string
  name: string
  /** sftp | ftp */
  protocol: string
  authType: string
}

/** EnvProfile GET /projects/:id/env-profile 响应 data 段。
 * devPorts 恒在场（内存源）；sentinels/deployTargets 读失败整键缺席 */
export interface EnvProfile {
  projectId: string
  devPorts: EnvProfileDevPort[]
  sentinels?: EnvProfileSentinel[]
  deployTargets?: EnvProfileDeployTarget[]
}

export const envProfileApi = {
  // 响应拦截器已解包 response.data（运行期返回 body 本体）；`as unknown as`
  // 是 domains 层与该解包语义对齐的既有惯例（system.ts selfCheckApi 同款）
  get: (projectId: string, config?: AxiosRequestConfig) =>
    api.get<{ data: EnvProfile }>(`/projects/${projectId}/env-profile`, config) as unknown as Promise<{ data?: EnvProfile }>,
}
