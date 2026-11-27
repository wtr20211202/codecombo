/**
 * 粘贴上传限额类型（P-20261123-6 S2 ⑨）：独立文件——system.ts 恰 1139 行
 * 体量基线（file-size 纪律），SettingsData 用 extends 引入，不净增主文件行数。
 * MB 语义 = MiB（1024×1024 字节）；owner 1~512/1~64 可调，share/remote 1~20/1~10
 * 仅下调（默认=上限）；显式 0 = 恢复默认。
 */
import type { SettingsData } from './system'

/** 单端限额（生效值形态：已补默认/钳制/image≤file 纠偏） */
export interface PasteLimitEntry {
  fileMB: number
  imageMB: number
  /** 请求体上限（file + per-context 余量；诊断展示用） */
  bodyMB: number
}

/** 三端生效值 */
export interface PasteLimitsData {
  owner: PasteLimitEntry
  share: PasteLimitEntry
  remote: PasteLimitEntry
}

/** 默认值与可调范围（GET /settings pasteLimitsSpec 下发——前端不抄范围） */
export interface PasteLimitsSpec {
  defaults: Record<'owner' | 'share' | 'remote', { fileMB: number; imageMB: number }>
  ranges: Record<
    'owner' | 'share' | 'remote',
    { fileMin: number; fileMax: number; imageMin: number; imageMax: number }
  >
}

/** PUT 载荷叶子形态：undefined=不动；0=恢复默认；非零=范围内值 */
export interface PasteLimitPairPut {
  fileMB?: number
  imageMB?: number
}

export interface PasteLimitsPut {
  owner?: PasteLimitPairPut
  share?: PasteLimitPairPut
  remote?: PasteLimitPairPut
}

/** 带 pasteLimits 的 SettingsData（GET 投影扩展） */
export interface SettingsDataWithPasteLimits extends SettingsData {
  pasteLimits?: PasteLimitsData
  pasteLimitsSpec?: PasteLimitsSpec
}
