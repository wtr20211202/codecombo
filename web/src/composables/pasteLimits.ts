/**
 * 粘贴上传限额生效值单例（P-20261123-6 S2）：三端预检共用一份「服务端生效值」，
 * 不再逐层 prop 透传（P-5 的 pasteMax* props 保留作可选覆盖）。
 *
 * 语义（评审定案 ⑤）：
 *  - load() 拉 /api/settings（懒加载+缓存）；apply() 设置页保存成功后同帧更新
 *    （不等广播往返）；settings.changed 广播触发重拉失效（OpsChannelBridge 已
 *    在广播面）；
 *  - **未拉到 / 旧服务缺 pasteLimits / 分享页无注入值 → 一律不做前端预检**
 *    （服务端是权威）——不得回退到 owner 100/20 去"放行"：P-5 未落地时服务端
 *    实际是 20/10，回退 100 会让 25MB 先过前端再被旧服务裸字节拒绝；
 *  - get() 返回 null = 无数据不预检；有数据返回三端 Limit（MB 数值）。
 */
import api from '../api/http'

/** 单端生效值（MB 数值；bodyMB 仅诊断展示用，预检只看 file/image） */
export interface PasteLimitEntry {
  fileMB: number
  imageMB: number
  bodyMB: number
}

export interface PasteLimitsData {
  owner: PasteLimitEntry
  share: PasteLimitEntry
  remote: PasteLimitEntry
}

export interface PasteLimitsSpec {
  defaults: Record<'owner' | 'share' | 'remote', { fileMB: number; imageMB: number }>
  ranges: Record<
    'owner' | 'share' | 'remote',
    { fileMin: number; fileMax: number; imageMin: number; imageMax: number }
  >
}

let cached: PasteLimitsData | null = null
let cachedSpec: PasteLimitsSpec | null = null
let inflight: Promise<void> | null = null

/** 拉取并缓存生效值（懒加载；并发调用共享同一 in-flight） */
export function loadPasteLimits(): Promise<void> {
  if (cached) return Promise.resolve()
  if (inflight) return inflight as Promise<void>
  inflight = api
    .get('/settings')
    .then((res: unknown) => {
      // 响应拦截器形态：axios body 直出 { data: {...} }（settingsApi.get 同款消费）
      const d = (res as { data?: { pasteLimits?: PasteLimitsData; pasteLimitsSpec?: PasteLimitsSpec } } | null)?.data
      cached = d?.pasteLimits ?? null
      cachedSpec = d?.pasteLimitsSpec ?? null
    })
    .catch(() => {
      // 拉取失败 = 无数据不预检（服务端权威兜底），下次调用重试
      cached = null
      cachedSpec = null
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 设置页保存成功后同帧应用（不等 settings.changed 广播往返） */
export function applyPasteLimits(data: PasteLimitsData | null, spec: PasteLimitsSpec | null): void {
  cached = data
  cachedSpec = spec
}

/** settings.changed 广播失效：置空缓存，下次 get 前由调用方 load 重拉 */
export function invalidatePasteLimits(): void {
  cached = null
  cachedSpec = null
}

/** 当前生效值：null = 无数据（不预检——服务端是权威） */
export function getPasteLimits(): PasteLimitsData | null {
  return cached
}

export function getPasteLimitsSpec(): PasteLimitsSpec | null {
  return cachedSpec
}

/** MB 文案（与服务端 pastetmp.MBText 同形态一位小数） */
export function pasteMbText(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}
