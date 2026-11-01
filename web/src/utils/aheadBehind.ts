// ahead/behind 批量拉取（能力探测分流 + 404 回退兜底）
//
// 优先走批量接口 GET /api/ahead-behind（一次请求替代 N 次扇出）。是否可用经
// /api/meta 能力探测（P-20261004-4）分流：对端声明 ahead-behind-all 才走批量
// ——多实例异版本部署下，旧对端（无该端点 → 404）不再白白发注定失败的请求；
// 远程实例不再无条件扇出（新版对端同样吃到批量红利）。探测失败或能力项
// 未声明时退回逐项目扇出，批量端点的 404 回退保留兜底（清单与路由漂移时不失能）。
import { projectApi } from '../api/client'
import { CAP_AHEAD_BEHIND_ALL, useMetaStore } from '@/stores/meta'

export interface AheadBehind {
  ahead: number
  behind: number
}

const ZERO: AheadBehind = { ahead: 0, behind: 0 }

/** 拉取给定项目的 ahead/behind 映射；失败的项目按 0/0 缺省（不打扰用户）。
 * 冻结项目（frozen，P-20261003-9）跳过探测：死项目不参与首页徽章，
 * 批量端点与逐项目扇出两条路径都不再为其起 git 子进程 */
export async function fetchAheadBehindMap(
  projects: ReadonlyArray<{ id: string; frozen?: boolean }>,
): Promise<Record<string, AheadBehind>> {
  const ids = projects.filter(p => !p.frozen).map(p => p.id)
  // 能力探测分流：声明 ahead-behind-all（本机实例必声明）才走批量端点
  const meta = useMetaStore()
  await meta.ensureCaps()
  if (meta.hasCap(CAP_AHEAD_BEHIND_ALL)) {
    try {
      // 响应拦截器已解包：res 即 { data: { <projectId>: {ahead, behind} } }
      const res = await projectApi.aheadBehindAll({ silent: true }) as unknown as { data?: Record<string, AheadBehind> }
      const data = res.data || {}
      const map: Record<string, AheadBehind> = {}
      for (const id of ids) map[id] = data[id] || ZERO
      return map
    } catch (e: any) {
      if (e?.response?.status !== 404) return {}
    }
  }
  // 逐项目扇出（对端未声明批量能力 / 批量端点 404 兜底）
  const map: Record<string, AheadBehind> = {}
  await Promise.all(ids.map(async (id) => {
    try {
      const res = await projectApi.aheadBehind(id, { silent: true }) as unknown as { data?: AheadBehind }
      map[id] = res.data || ZERO
    } catch {
      map[id] = ZERO
    }
  }))
  return map
}
