import type { FleetBatchMeta } from '../utils/fleetBatches'

/**
 * 终端会话统一数据源的数据模型（自 terminal-sessions store 拆出，纯搬运零
 * 逻辑改动）：服务端列表/快照项形状、广播载荷、展示偏好类型与 cwd 读取口。
 * 由 terminal-sessions.ts 原地 re-export（既有消费方 import 路径不变）。
 */

/** GET /terminals 列表项 / terminals.changed 快照项 */
export interface TerminalSessionInfo {
  id: string
  name: string
  /** 'shell' 项目会话 | 'agent' 系统会话 */
  kind: string
  projectId: string
  path: string
  createdAt: string
    /** agent 会话底层运行时（仅创建响应携带；快照无此字段，保留已知值） */
    runtime?: string
    /** 创建时预检顺取的运行时版本 --version 首行（P-20261003-134）：创建响应
     *  同步携带 + 服务端快照经 meta 反查持久携带；旧会话/纯 shell/自定义命令
     *  豁免链无值缺省（tooltip 空显不虚构） */
    runtimeVersion?: string
    /** 创建响应的 launched（运行时是否成功拉起）；恢复场景决定提示文案 */
    launched?: boolean
    /** 服务端活动时钟（P-20261003-192，ISO）：PTY 输入/输出双面刷新的最近
     *  活动时刻，空闲分离判定的对账依据；旧对端无此字段缺省（可选消费，
     *  与浏览器侧 activityMap 分属两口径——浏览器内存态刷新即失） */
    lastActivity?: string
    /** OSC 7 实时追踪的会话工作目录（P-20261004-59）：本机路径口径。三路
     *  来源收敛同一字段——①连接宿主写路径旁挂解析（实时，毫秒级）②服务端
     *  快照 currentDir（跨标签页/恢复场景）③applySnapshot 已知值兜底。缺省
     *  = 无帧（旧 shell/新会话无 prompt），消费方经 sessionWorkingDir 回落
     *  path（创建 dir）——旧 shell 零回归 */
    currentDir?: string
    /** 人工策展的敏感标记（P-20261003-155）：导出/分享出域命中时服务端回
     *  warnings 要求二次确认；本地检索不受限。快照仅置位携键（缺 key =
     *  未标记 = false），行角标与出域前置判断同源 */
    sensitive?: boolean
    /** 创建时注入的初始指令原文（P-20261003-146）：会话行「重新发起」预填
     *  新建对话框的数据面。快照经 meta 反查携带（缺 key = 无记录——无 prompt
     *  创建/旧会话），创建后不变更；applySnapshot 对缺 key 保留已知值（创建
     *  响应先行，meta 异步落库窗口的同款兜底） */
    initialPrompt?: string
    /** 会话来源（P-20261005-189）：'self'=自建（缺省）/ 'external'=外部接管
     *  （attach 服务器上用户默认 socket 的既有 tmux 会话）——关闭分流（外部
     *  会话关闭=解除接管不杀会话）与接管徽标/默认只读锁的判据。旧服务端
     *  快照无此字段缺省（视为 self，零回归） */
    origin?: string
    /** 编队批元数据（P-20261005-145）：bulk-agent 成员的批身份（batchId+
     *  发起时间+成员花名册），快照经服务端 meta 反查携带（缺 key = 非编队
     *  会话）。值班聚合卡按批分组的数据面；创建后不变更，applySnapshot 已知
     *  值兜底（同 initialPrompt 口径） */
    fleetBatch?: FleetBatchMeta
    /** 会话名系统派生（P-20261023-3）：创建时未显式命名（prompt 摘要/槽位
     *  继承/序号默认名）——命名来源身份记录；缺 key = false（旧会话/显式
     *  命名）。创建后不变更，快照与创建响应双源同值 */
    derived?: boolean
    /** 恢复旗标创建（P-20261023-3）：launchArgs 为 --resume 等旗标形态——
     *  侧栏「接续」徽标判据（新建 ≠ 复用：接续会话继承槽位旧名，与新会话
     *  同名歧义的第二区分维度）；缺 key = false */
    resumed?: boolean
}

/** 会话当前工作目录：OSC 7 实时值优先，无帧回落创建 dir（path）。
 *  四个 cwd 消费位（文件链接/树定位/驻留徽标/复制会话）的统一读取口——
 *  回落语义收口在此，任何消费方不得直读 currentDir 判空。
 *  参数取结构化最小面（path 可选——AgentTermSession 视图形状 path 缺省） */
export function sessionWorkingDir(s: { currentDir?: string; path?: string }): string {
  return s.currentDir || s.path || ''
}

/** terminals.changed 广播 payload */
export interface TerminalsChangedPayload {
  sessions?: Partial<TerminalSessionInfo>[]
}

/** 会话排序方式（管理页侧栏与悬浮列表共用同一份 store 状态） */
export type SessionSortMode = 'default' | 'name' | 'activity'

/** 会话中心终端页签分组视图（P-20261003-238）：flat=既有呈现 / runtime=按运行时分组 */
export type SessionGroupMode = 'flat' | 'runtime'
