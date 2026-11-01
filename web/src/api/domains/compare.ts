// 对比实验域 API（P-20261003-46）：双 agent 同题竞写——双开发起 / 完成状态 /
// 产出并集三分类 / 采用标注。服务端形状见 server/api/compareexp/api.go
import api from '../http'

/** 实验单侧（一个 agent 会话；result 复用完成链 done/failed 同值 + error:<msg>） */
export interface CompareExpSide {
  sessionId: string
  runtime?: string
  name?: string
  dir?: string
  launched?: boolean
  /** '' = 等待回执；done / failed / error:<发起失败摘要> */
  result?: string
  /** 底层智能体会话 id（终结回执捕获；claude 场景 = 对话 uuid，token 用量对账键） */
  agentSessionId?: string
}

/** 对比实验记录（store.CompareExperiment 服务端形状） */
export interface CompareExperiment {
  id: string
  prompt: string
  dir?: string
  /** running = 双侧至少一侧尚无终结回执；ready = 可进对比决断 */
  status: 'running' | 'ready'
  a: CompareExpSide
  b: CompareExpSide
  /** 采用标注：'' / 'a' / 'b'（annotate 仅记录；apply 见 adopt mode） */
  adopted?: string
  /** 采用标注时点的行动文件指纹快照（mode=apply 的安全对账参照） */
  applySnapshot?: { side: string; capturedAt: string; files: Record<string, string> }
  createdAt: string
  readyAt?: string
}

/** 对比文件行（三态：双真 = 双方、单真 = 仅该侧） */
export interface CompareFileRow {
  path: string
  inA: boolean
  inB: boolean
  statusA?: string
  statusB?: string
}

/** 实验详情（experiment + 双侧会话存活态 + 实时三分类） */
export interface CompareExperimentDetail {
  experiment: CompareExperiment
  alive: { a: boolean; b: boolean }
  files: CompareFileRow[]
}

export interface CompareLaunchPayload {
  prompt: string
  dir?: string
  runtimeA: string
  runtimeB: string
  /** 分目录竞写（worktree 隔离）；缺省双侧共用 dir */
  dirA?: string
  dirB?: string
}

/** 采用落盘结果（mode=apply 响应；P-20261004-72） */
export interface CompareApplyResult {
  side: 'a' | 'b'
  /** 采用侧独有（保留不动） */
  kept: number
  /** 另一侧独有 tracked（逆向回滚到其基线） */
  rolledBack: number
  /** 另一侧独有 untracked（删除，字节已备份） */
  deleted: number
  /** 双方/同目录他侧独有（无操作注记） */
  noop: number
  notes?: string[]
  /** 备份记录 id（applies/:id/patch 可取还原补丁） */
  backupId: string
}

/** 落盘记录（轻量视图；备份本体经 patch 端点另取） */
export interface CompareApplyRecord {
  id: string
  expId: string
  side: 'a' | 'b'
  dir?: string
  baseHead?: string
  kept: number
  rolledBack: number
  deleted: number
  noop: number
  notes?: string[]
  patchBytes: number
  truncated: boolean
  hasUntracked: boolean
  createdAt: string
}

/** 落盘记录全量（还原补丁 + 被删 untracked 字节；字节 JSON 落形 base64，二进制安全） */
export interface CompareApplyPatch {
  id: string
  expId: string
  side: 'a' | 'b'
  dir?: string
  baseHead?: string
  kept: number
  rolledBack: number
  deleted: number
  noop: number
  notes?: string[]
  patch: string
  untracked?: Record<string, string>
  createdAt: string
}

export const compareExperimentApi = {
  /** 双开两个 runtime 会话竞写同一 prompt */
  create: (payload: CompareLaunchPayload) => api.post('/compare-experiments', payload),
  /** 实验列表（创建时间倒序） */
  list: () => api.get('/compare-experiments'),
  /** 详情：双侧产出并集三分类实时计算（跟随工作区漂移） */
  get: (id: string) => api.get(`/compare-experiments/${id}`),
  /** 采用标注（side 传 '' 清除；mode 缺省 annotate 仅标注） */
  adopt: (id: string, side: 'a' | 'b' | '') => api.post(`/compare-experiments/${id}/adopt`, { side }),
  /** 采用落盘二阶段（P-20261004-72）：保留/回滚/删除 + 强制备份 + 指纹对账 */
  applyAdoption: (id: string, side: 'a' | 'b') =>
    api.post(`/compare-experiments/${id}/adopt`, { side, mode: 'apply' }),
  /** 落盘记录列表（轻量视图） */
  applies: (id: string) => api.get(`/compare-experiments/${id}/applies`),
  /** 单条落盘记录全量（还原补丁 + 备份字节——「备份可查」取数面） */
  applyPatch: (id: string, aid: string) => api.get(`/compare-experiments/${id}/applies/${aid}/patch`),
  /** 删除实验记录（已拉起的会话不受影响；落盘记录级联清账） */
  remove: (id: string) => api.delete(`/compare-experiments/${id}`),
  /** 单文件「基线 vs 侧产出」unified diff（status 传该行在侧上的短状态，'?' 走合成） */
  fileDiff: (id: string, side: 'a' | 'b', file: string, status?: string) =>
    api.get(`/compare-experiments/${id}/filediff`, { params: { side, file, status } }),
}
