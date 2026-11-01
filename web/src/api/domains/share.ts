// 文件分享域 API：短链管理（创建/列表/轮换/撤销）+ 文本片段分享 + 终端只读直播
// + 分享子服务状态
import type { AxiosRequestConfig } from 'axios'
import api from '../http'
import type { ShareTtlChoice } from '../../utils/shareTtl'
import { settingsApi, networkApi } from './system'
import {
  buildShareAddressPlan,
  type ShareAddressPlan,
  type ShareServiceStatusLike,
} from '../../utils/shareAddress'
import type { NetworkAddress } from '../../utils/networkAddress'

// ShareKind 分享形态：file = 项目内文件/目录；snippet = 文本片段（排障贴短链，
// 不绑项目、24h 自动过期）；terminal = 终端只读直播（token→会话，遮蔽化只读
// 输出流，默认 30 分钟过期）；terminal-frozen = 终端输出时点冻结快照（P-20261005-205，
// 创建时刻的定格链接，遮蔽净化单文件快照，默认 30 天、会话关闭后仍可访问）；
// cast = 会话回放（P-20261004-103，录制 cast 快照 + 只读回放页，默认 1 小时）；
// session = 会话回放只读分享（P-20261003-77，Claude 会话时间线快照，含思考块/
// 工具详情，默认 24 小时）
export type ShareKind = 'file' | 'snippet' | 'terminal' | 'terminal-frozen' | 'cast' | 'session'

// ShareHealth 分享健康（P-20261020-10，服务端列表响应投影）：
// ok = 目标可服务；target_missing = live 文件目标已删除/移走；
// project_gone = 项目记录或项目根目录不可用；snapshot_missing = 冻结副本缺失。
// 旧服务端缺字段 → 前端按 ok 回落（升级兼容，纯增量字段）
export type ShareHealth = 'ok' | 'target_missing' | 'project_gone' | 'snapshot_missing'

// ShareInfo 一条分享记录（服务端 store.Share 的管理面投影）
export interface ShareInfo {
  token: string
  kind: ShareKind
  projectId: string
  projectName: string
  path: string
  /** 多路径冻结分享（P-20261008-1）：选择集清单（项目相对路径，排序后）；
   *  非空 = 批量评审包单链（path 为空、仅 frozen），单路径记录不携带 */
  paths?: string[]
  name: string
  isDir: boolean
  size: number
  createdAt: string
  /** 过期时点（ISO）：snippet 创建即定 24h；file 为 opt-in TTL（默认永久，字段缺省）；terminal 默认 30 分钟 */
  expiresAt?: string
  /** 访问次数（P-20261002-14）：短链被打开/下载的累计次数（0/缺省 = 未访问） */
  hits?: number
  /** 最近访问时点（ISO）：从未被访问时缺省 */
  lastAccessAt?: string
  /** 终端会话锚点（kind=terminal / terminal-frozen 专有；cast 形态承载来源会话的展示元数据） */
  terminalId?: string
  /** 回放分享的录制锚点（kind=cast 专有，P-20261004-103）：录制索引 id */
  recordingId?: string
  /** 会话回放分享的会话锚点（kind=session 专有，P-20261003-77）：Claude session id */
  sessionId?: string
  /** 冻结快照分享（P-20261003-320，kind=file 专有）：创建时复制副本，访客内容定格不可变 */
  frozen?: boolean
  /** 访问口令门（P-20261006-25）：true = 访客需口令才能看（哈希永不外发，只报有无） */
  hasPassphrase?: boolean
  /** 访客页溯源水印（P-20261005-193）：true = 访客页叠加低透明水印（分享名+链接尾号+日期，截图外传可归因） */
  watermark?: boolean
  /** 一次性查看（P-20261006-27）：true = 首位访客打开后进入 10 分钟宽限窗（store.ViewOnceGrace），窗后失效（服务端常量单点，前端不复制判定） */
  viewOnce?: boolean
  /** 一次性已失效（P-20261006-27）：已被查看且宽限窗走完（服务端按记录投影），管理列表据此挂「已失效」标 */
  consumed?: boolean
  /** 访客留言计数（P-20261006-13）：0/缺省 = 无留言（「留言 N」角标数据源；真实存量以留言列表为准） */
  messages?: number
  /** 退役访问次数（P-20261008-2）：历次轮换作废的旧链接退役后被访问的合计次数
   *  ——零误报的外泄确认信号（0/缺省 = 无命中，旧记录无退役史同样缺省） */
  retiredHits?: number
  /** 最近一次退役访问时点（ISO）：从未被踩时缺省 */
  lastRetiredAt?: string
  /** 该份冻结快照在盘字节量（P-20261005-176）：仅快照在盘的行携带（冻结文件分享/终端输出快照），服务端逐树统计投影 */
  frozenBytes?: number
  /** 分享健康（P-20261020-10，服务端 stat/快照探测投影）：缺省 = 旧服务端，按 ok 解读 */
  health?: ShareHealth
  /** 协作通道开关（P-20261024-1）：true = 访客面暴露上传位 + 受限留言档（500→2000）。
   *  旧服务端缺字段 → 按关解读（升级兼容，纯增量字段） */
  collab?: boolean
  /** 直通输入档开关（P-20261024-1 第二档独立开关，与 collab 互不联动） */
  directInput?: boolean
  /** 直通持权/申请态（P-20261024-1，服务端 shareSvc 投影）：held=true 有人持权
   *  （会话徽标/行内收回的数据源）；pending=true 有待批申请（缺省 = 无态） */
  direct?: ShareDirectProjection
}

/** ShareDirectProjection 直通持权/申请态（P-20261024-1，GET /api/share 行投影） */
export interface ShareDirectProjection {
  held: boolean
  /** 待批申请在途（held=false 时有效） */
  pending?: boolean
  /** 持权访客摘要（visitorId 前 8 位，对账辨识位） */
  visitorTail?: string
  nick?: string
  grantedAt?: string
  lastInputAt?: string
  /** 持权剩余秒数（10min 滑动时效，服务端单点计算） */
  expiresIn?: number
}

/** 通知行内动作/广播载荷前缀（服务端 share.shDropPayloadPrefix 镜像）：
 *  「shdrop:<token>:<id>」——交给会话动作链的寻址键 */
export const SHDROP_PAYLOAD_PREFIX = 'shdrop:'

/** ShareDropItem 一条已收素材（GET /api/share/:token/drops，主人侧唯一带路径出口） */
export interface ShareDropItem {
  id: string
  /** 净化后的展示名（访客原始 filename 不外泄） */
  name: string
  /** 落盘名（<id>_<净化名>；主人侧可见，访客面剥除） */
  fileName: string
  size: number
  /** image | file */
  kind: string
  nick?: string
  at: string
  /** 已消费时点（ISO）：交给会话即标——已消费 24h 清/未消费 72h 清 */
  consumedAt?: string
  /** 敏感文件名扫描命中（警示注记，处置权在主人） */
  sensitive?: boolean
  /** 素材绝对路径（服务端 DropAbsPath 投影——贴进会话动作链的取数点） */
  absPath: string
}

// ShareFrozenUsage 快照库占用（P-20261005-176）：GET /api/share 响应级投影
// ——双体积护栏（单份 200MB/总量 1GB）从撞 413 才知变常透明，agent 可程序化
// 容量治理；统计失败时服务端省略该字段（列表可用性优先）
export interface ShareFrozenUsage {
  /** 快照库整根实际占用量（含 TTL 未清的孤儿残壳——与创建护栏预算同口径） */
  totalBytes: number
  /** 总量护栏（share.MaxFrozenTotalBytes，当前 1GB） */
  capBytes: number
}

// ShareMode 分享模式（P-20261003-320）：live = 活视图（访客内容实时读项目，
// 缺省）；frozen = 冻结快照（创建时复制副本，内容定格 + 副本全量敏感扫描，
// 默认 30 天 TTL、单份上限 200MB）
export type ShareMode = 'live' | 'frozen'

/** snippet 内容字节上限（对齐服务端 store.MaxSnippetBytes，32KiB） */
export const SNIPPET_MAX_BYTES = 32 * 1024

/** 冻结快照单份字节上限（对齐服务端 share.MaxFrozenBytes，200MB）：批量
 *  分享的合计体积触顶时服务端 413 拒绝，前端在创建弹层提前预警拆分 */
export const FROZEN_MAX_BYTES = 200 * 1024 * 1024

/** 批量分享选择项上限（对齐服务端 shareapi.maxBatchSharePaths，50 项） */
export const BATCH_SHARE_MAX_PATHS = 50

// ShareServiceStatus 分享子服务就绪态（短链拼接依赖 port + scheme）
export interface ShareServiceStatus {
  running: boolean
  port: number
  scheme: '' | 'http' | 'https'
}

// CreateShareResult 创建分享的响应体：创建成功带 data；命中敏感文件警告
// 且未确认（override=false）时服务端不创建，仅返回 warnings 命中清单 +
// scanTruncated（目录超大只扫了部分条目）
export interface CreateShareResult {
  data?: ShareInfo
  warnings?: string[]
  scanTruncated?: boolean
}

// ShareMessage 一条访客留言（服务端 store.ShareMessage 的管理面投影；
// 只读回流——回复是 IM 的活，主人侧仅聚合可见 + 单删/清空）
export interface ShareMessage {
  id: string
  token: string
  /** 访客自报昵称（空 = 匿名） */
  nickname?: string
  text: string
  createdAt: string
}

export const shareApi = {
  // list 全部分享；响应附 frozenUsage（P-20261005-176 快照库占用，统计失败省略）
  list: () => api.get<{ data: ShareInfo[]; frozenUsage?: ShareFrozenUsage }>('/share'),
  // override：敏感文件警示确认后的二次请求标记（true = 用户已确认仍要分享）；
  // mode：分享模式（P-20261003-320），live 缺省不发字段（旧对端兼容）；
  // passphrase：可选访问口令（P-20261006-25），空串缺省不发字段（旧对端兼容）；
  // watermark：访客页溯源水印开关（P-20261005-193），true 缺省不发字段
  //（服务端缺省开，归因基线），false 显式发字段关闭；
  // viewOnce：一次性查看开关（P-20261006-27），false 缺省不发字段（服务端
  // 缺省关，存量语义零变化；frozen 模式服务端 400——调用方先行规避）；
  // ttl：有效期预设（P-20261020-5：1h/1d/7d/30d/permanent），expiresAt：
  // 自定义日期 RFC3339 绝对时点——两者互斥；都不发 = 未显式选择，服务端按
  // settings.shareDefaultTTL（live，缺省永久）或 frozen 30 天默认兜底
  create: (projectId: string, path = '', override = false, mode: ShareMode = 'live', passphrase = '', watermark = true, viewOnce = false, ttl?: ShareTtlChoice, expiresAt?: string) =>
    api.post<CreateShareResult>('/share', {
      projectId,
      path,
      override,
      ...(mode === 'frozen' ? { mode } : {}),
      ...(passphrase ? { passphrase } : {}),
      ...(watermark ? {} : { watermark: false }),
      ...(viewOnce ? { viewOnce: true } : {}),
      ...(ttl ? { ttl } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    }),
  // createBatch 多路径冻结分享（P-20261008-1）：把多选的文件/目录集合
  // （项目相对路径）定格为一条短链。MVP 仅 frozen（服务端拒绝 live 批量），
  // 参数面与 create 的 frozen 档一致（口令/水印/敏感扫描 override 二次确认）；
  // 集合顺序无关幂等——同集合重复创建恒同链
  createBatch: (projectId: string, paths: string[], override = false, passphrase = '', watermark = true) =>
    api.post<CreateShareResult>('/share', {
      projectId,
      paths,
      override,
      mode: 'frozen',
      ...(passphrase ? { passphrase } : {}),
      ...(watermark ? {} : { watermark: false }),
    }),
  // createSnippet 文本片段分享（不绑项目；name 可选，缺省取内容首行）。
  // 内容上限 SNIPPET_MAX_BYTES 由调用方先行校验，服务端 413 兜底；
  // passphrase 可选访问口令（P-20261006-25，四形态统一守卫）；
  // watermark 溯源水印开关同 create（缺省开不发字段）；
  // viewOnce 一次性查看开关同 create（缺省关不发字段）
  createSnippet: (content: string, name = '', passphrase = '', watermark = true, viewOnce = false) =>
    api.post<CreateShareResult>('/share/snippet', {
      content,
      name,
      ...(passphrase ? { passphrase } : {}),
      ...(watermark ? {} : { watermark: false }),
      ...(viewOnce ? { viewOnce: true } : {}),
    }),
  // createTerminal 终端只读直播分享（token→会话，访客看遮蔽化只读输出流）。
  // ttlMinutes 可选（缺省服务端 30 分钟）；会话不存在 → 404。
  // override 敏感会话出域警示的确认标记（P-20261003-155）：命中且未确认时
  // 响应不带 data 只带 warnings，确认后带 true 二次请求才创建（文件分享同流）
  createTerminal: (sessionId: string, ttlMinutes?: number, override = false) =>
    api.post<{ data: ShareInfo }>('/share/terminal', {
      sessionId,
      override,
      ...(ttlMinutes != null ? { ttlMinutes } : {}),
    }),
  // createTerminalFrozen 终端输出时点冻结快照分享（P-20261005-205）：创建
  // 时刻的 scrollback 定格链接——服务端净化（剥 ANSI + 敏感值遮蔽）后落单
  // 文件快照，会话继续跑内容不更新；默认 30 天 TTL、会话关闭后仍可访问。
  // 同一段输出重复定格恒同链（内容哈希派生）；会话不存在 → 404、空输出 → 400。
  // override 敏感会话出域闸门与 createTerminal 同一契约
  createTerminalFrozen: (sessionId: string, override = false) =>
    api.post<{ data: ShareInfo }>('/share/terminal-frozen', { sessionId, override }),
  // createCast 会话回放分享（P-20261004-103）：把一次录制的 cast 以只读回放页
  // 分享出去——服务端在创建时刻把 cast 快照进隔离区（录制继续写不影响访客），
  // 默认 1 小时 TTL、上限 24h。同一录制重复分享恒同链（倒计时不续期，但会
  // 重写快照跟进录制内容）。override = 敏感模式扫描警示的确认标记（P-97
  // 同语义）：命中且未确认时响应不带 data 只带 warnings，确认后带 true 二次
  // 请求才创建；即使确认，落盘快照也会再做全量兜底遮蔽
  createCast: (recordingId: string, override = false, ttlMinutes?: number) =>
    api.post<CreateShareResult>('/share/cast', {
      recordingId,
      override,
      ...(ttlMinutes != null ? { ttlMinutes } : {}),
    }),
  // createSession 会话回放只读分享（P-20261003-77）：把一条 Claude 会话的
  // 完整时间线（含思考块/工具详情）以只读页分享出去——创建时刻的条目快照
  //（P-108 敏感值已在服务端遮蔽为 ***），会话继续写不影响访客所见。默认
  // 24h TTL、上限同值（可调短）；同一会话重复分享恒同链（倒计时不续期，
  // 重分享会重写快照跟进新增回合）。会话不存在 → 404、无可回放条目 → 400
  createSession: (sessionId: string, ttlMinutes?: number) =>
    api.post<{ data: ShareInfo }>('/share/session', {
      sessionId,
      ...(ttlMinutes != null ? { ttlMinutes } : {}),
    }),
  // remove 撤销单条分享；config 尾参（git.projectStatus 同款先例）：批量撤销链
  //（P-20261005-226）逐条调用传 silent——部分失败是批量语义内的预期分支，逐项
  // 结果由调用方聚合报告，不放拦截器逐条弹错（N 条失败 = N 个 toast 噪音）
  remove: (token: string, config?: AxiosRequestConfig) => api.delete(`/share/${token}`, config),
  // rotate 轮换短链（泄露应对）：旧链立即失效，响应 data 为携带新 token 的记录
  rotate: (token: string) => api.post<{ data: ShareInfo }>(`/share/${token}/rotate`),
  // refresh 冻结分享原地刷新（P-20261005-177，保 token 换内容——与 rotate
  // 换链语义正交并存）：同 token 重拷当前内容，已分发链接继续有效；敏感扫描
  // 对新副本跑一遍，命中未确认时响应不带 data 只带 warnings（旧副本原样），
  // 确认后带 override:true 二次请求才换内容（create 同一契约）；护栏触顶 413
  // 且旧副本保留；刷新即 TTL 重置（30 天）。仅 frozen 记录可用（其他形态 400）
  refresh: (token: string, override = false) =>
    api.post<CreateShareResult>(`/share/${token}/refresh`, override ? { override: true } : {}),
  // setExpiry 调整有效期（opt-in TTL）：expiresAt 为 RFC3339 绝对时点，
  // null = 恢复永久；snippet 的 24h 固定窗口服务端拒绝调整（400）
  setExpiry: (token: string, expiresAt: string | null) =>
    api.post<{ data: ShareInfo }>(`/share/${token}/expiry`, { expiresAt }),
  // setPassphrase 访问口令门设置/更换/移除（P-20261006-25）：passphrase 空
  // 串 = 移除；rotate = 改口令联动轮换短链（旧链与已发访客会话一并失效），
  // 响应 data 为最终记录（rotate 后带新 token）。改/移除口令即让全部已发
  // 访客门会话失效（服务端 cookie 绑定记录哈希，无需额外操作）
  setPassphrase: (token: string, passphrase: string, rotate = false) =>
    api.post<{ data: ShareInfo }>(`/share/${token}/passphrase`, { passphrase, rotate }),
  status: () => api.get<{ data: ShareServiceStatus }>('/share/status'),
  // ── 访客留言板主人侧（P-20261006-13）：只读回流 + 垃圾出清 ──
  // listMessages 留言列表（新到旧）；未知/已撤销分享 → 404
  listMessages: (token: string) => api.get<{ data: ShareMessage[] }>(`/share/${token}/messages`),
  // deleteMessage 单删一条留言
  deleteMessage: (token: string, id: string) => api.delete(`/share/${token}/messages/${id}`),
  // clearMessages 清空该分享全部留言，响应携删除条数
  clearMessages: (token: string) => api.delete<{ removed?: number }>(`/share/${token}/messages`),
  // ── 协作通道管理面（P-20261024-1，动作化行内端点——分享无编辑面） ──
  // setCollab 协作通道开关：开启暴露访客上传位 + 受限留言档；关闭即回收
  //（端点恢复 404，存量素材保留可读）。响应 data 为最终记录
  setCollab: (token: string, collab: boolean) =>
    api.post<{ data: ShareInfo }>(`/share/${token}/collab`, { collab }),
  // setDirectInput 直通输入档开关（第二档独立开关）：on=true 需 confirm 显式
  // 确认（管理面摩擦硬闸，服务端 400 拦截缺标记的调用）；on=false 回收方向
  // 不需要 confirm（持权立刻失效 + 会话只读闸解除）
  setDirectInput: (token: string, on: boolean, confirm = false) =>
    api.post<{ data: ShareInfo }>(`/share/${token}/direct-input`, { on, confirm }),
  // listDrops 收件清单（新到旧，含 absPath 绝对路径——主人侧唯一带路径出口）
  listDrops: (token: string) =>
    api.get<{ data: ShareDropItem[]; share?: { name?: string; collab?: boolean } }>(`/share/${token}/drops`),
  // consumeDrop 标已消费（交给会话即标——已消费 24h 清/未消费 72h 清）
  consumeDrop: (token: string, id: string) =>
    api.post<{ data: { ok: boolean } }>(`/share/${token}/drops/${id}/consume`),
  // deleteDrop 单删素材（未知 id 幂等成功）
  deleteDrop: (token: string, id: string) => api.delete<{ data: { ok: boolean } }>(`/share/${token}/drops/${id}`),
  // approveDirect 批准访客的直通输入申请（单持有者握手 owner 半边；无在途
  // 申请 → 409、非 agent 会话 → 400）
  approveDirect: (token: string, visitorId = '', nickname = '') =>
    api.post<{ data: { granted: boolean; visitorId: string; nick?: string; sessionId: string } }>(
      `/share/${token}/direct/approve`,
      { ...(visitorId ? { visitorId } : {}), ...(nickname ? { nickname } : {}) },
    ),
  // revokeDirect 一键收回直通输入权（管理器行内/通知中心持权卡/会话侧徽标
  // 三路入口 + 回收端点第四路共用；幂等——had=false = 本就无持权）
  revokeDirect: (token: string) => api.post<{ data: { ok: boolean; had: boolean } }>(`/share/${token}/direct/revoke`),
  // getDirect 直通档状态投影（enabled/session/pending/hold——管理面轮询数据源）
  getDirect: (token: string) =>
    api.get<{
      data: {
        enabled: boolean
        kind?: string
        session?: { id: string; alive: boolean; kind?: string; name?: string }
        pending?: { visitorId: string; nick?: string; requestedAt: string; expiresIn: number }
        hold?: { visitorId: string; nick?: string; grantedAt: string; lastInputAt: string; expiresIn: number }
      }
    }>(`/share/${token}/direct`),
}

// buildShareUrl 兼容包装（P-20261020-2 起统一走 utils/shareAddress 的地址计划）：
// 不携带 settings/网络候选时只能按「当前地址/旧 sharePort」选址，仅供未迁移的
// 宿主与单测兜底。新代码用 buildShareAddressPlan / resolveShareAddressPlan。
/** @deprecated 使用 shareApi 的地址计划（buildShareAddressPlan） */
export function buildShareUrl(token: string, status: ShareServiceStatus): string {
  return buildShareAddressPlan(token, {
    currentHref: window.location.href,
    status,
    publicBaseUrl: '',
    externalAccessUrl: '',
    addresses: [],
  }).url
}

// ── 统一分享地址计划（P-20261020-2）──
// 结果卡/管理器/二维码/直播邀请通知共用：settings 的分享基址与外部访问地址 +
// /api/system/network 候选与 GET /api/share/status 一起喂给纯函数
// utils/shareAddress。两路设置读取用 allSettled 隔离失败（缺哪路就少哪条
// 选址依据，不阻断分享创建/管理面）。

export interface ShareAddressExtras {
  /** settings.sharePublicBaseUrl（空 = 未配置） */
  publicBaseUrl: string
  /** settings.externalAccessUrl（空 = 未配置） */
  externalAccessUrl: string
  /** 本机非回环地址候选（回环入口下自动改址用） */
  addresses: NetworkAddress[]
}

export async function fetchShareAddressExtras(): Promise<ShareAddressExtras> {
  const [settingsResult, networkResult] = await Promise.allSettled([
    settingsApi.get({ silent: true }),
    networkApi.list({ silent: true }),
  ])
  const settings = settingsResult.status === 'fulfilled'
    ? settingsResult.value as unknown as { data?: { sharePublicBaseUrl?: string; externalAccessUrl?: string } }
    : null
  const network = networkResult.status === 'fulfilled'
    ? networkResult.value as { data?: NetworkAddress[] }
    : null
  return {
    publicBaseUrl: settings?.data?.sharePublicBaseUrl || '',
    externalAccessUrl: settings?.data?.externalAccessUrl || '',
    addresses: Array.isArray(network?.data) ? network.data : [],
  }
}

/**
 * 解析一条分享的最终访客短链（含徽标状态）。
 * extras 可由调用方并行预取（创建流程里与 shareApi.status 同批），缺省时现拉。
 */
export async function resolveShareAddressPlan(
  token: string,
  status: ShareServiceStatusLike,
  extras?: ShareAddressExtras,
): Promise<ShareAddressPlan> {
  const context = extras ?? await fetchShareAddressExtras()
  return buildShareAddressPlan(token, {
    currentHref: window.location.href,
    status,
    ...context,
  })
}

// ── 快投递 quickdrop（P-20261006-51）：手机/脚本 → 工作台的最轻投递通道 ──
// 投递凭据 scd_ token 生命周期 + 收件箱管理面。投递原语 POST /api/quickdrop
// 与访客页 /drop/<token> 是公开面（token 即凭据），不经本域（agent/手机浏览器
// 直连，浏览器内前端无调用点——api-routes-baseline 注记）

/** QuickdropTokenMeta 投递凭据元信息（不含明文；服务端 store.QuickdropTokenMeta 的 TS 镜像） */
export interface QuickdropTokenMeta {
  exists: boolean
  /** 明文前 4 位 hex（scd_ 之后），辅助辨识 */
  prefix: string
  createdAt: string
  rotatedAt: string
}

/** QuickdropItem 一条投递（服务端 store.Quickdrop 的管理面投影，内容明文——鉴权面内回查转发用） */
export interface QuickdropItem {
  id: string
  content: string
  /** 投递来源 IP（元数据，用于辨识「手机投的」还是「脚本投的」） */
  from?: string
  createdAt: string
  /** 过期时点（ISO）：创建即定 24h，过期即查无 */
  expiresAt: string
  /** 内容字节数（服务端 size 投影） */
  size: number
}

/** 通知行内动作载荷前缀（服务端 quickdrop.PayloadPrefix 镜像）：「quickdrop:<id>」 */
export const QUICKDROP_PAYLOAD_PREFIX = 'quickdrop:'

export const quickdropApi = {
  // getToken 投递凭据元信息（明文永不回读，轮换时一次性展示）
  getToken: () => api.get<{ data: QuickdropTokenMeta }>('/quickdrop/token'),
  // createToken 生成/轮换凭据：已有 token 立即失效（轮换语义），明文仅在
  // 本次响应 data.token 返回一次，落盘只存哈希
  createToken: () => api.post<{ data: { token: string; meta: QuickdropTokenMeta } }>('/quickdrop/token'),
  // revokeToken 撤销凭据（投递页与端点即刻 404）
  revokeToken: () => api.delete<{ data: { ok: boolean } }>('/quickdrop/token'),
  // list 收件箱清单（新→旧，只含存活条目；过期由服务端惰性把守）
  list: () => api.get<{ data: QuickdropItem[] }>('/quickdrop'),
  // remove 摘除单条（转发消费后手动清理；未知 id 幂等成功）
  remove: (id: string) => api.delete<{ data: { ok: boolean } }>(`/quickdrop/${id}`),
}

// buildDropUrl 拼接投递页链接：/drop/<token> 在主服务端口（与工作台同源），
// 前端把当前 origin 直接拼上——手机浏览器书签存这个地址即可投递
export function buildDropUrl(token: string): string {
  return `${window.location.origin}/drop/${token}`
}
