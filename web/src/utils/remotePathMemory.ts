/**
 * 远程文件浏览路径记忆（P-20261006-19）纯函数：每主机「最近路径 LRU + 手动 pin 置顶」
 * 的列表语义。排序约定：新→旧（置顶区恒在最近区之上）；上限 MAX_RECENT_PATHS /
 * MAX_PINNED_PATHS、超出 FIFO 淘汰最旧（fileTreePins P-97 同款惯例）。
 * 持久化形态是 localStorage `sc.rfm.mem.<hostId>` 的 { recent, pins } 单文档
 * （safeStorage 通道——裸 localStorage 在屏蔽 Cookie/隐私模式下抛 SecurityError
 * 是既有红线；设备本地偏好口径，与 sc.rfm.cwd.<hostId> 同族不跨设备同步），
 * 读写拼装在宿主 useRemoteFileBrowser，此处只管单主机内的列表语义。
 */

/** 最近路径上限（LRU 环形封顶） */
export const MAX_RECENT_PATHS = 10

/** 手动 pin 上限（常用 3-5 条，超出 FIFO 淘汰最旧的 pin） */
export const MAX_PINNED_PATHS = 5

/** 持久化文档形态（sc.rfm.mem.<hostId> 的 JSON 反序列化目标） */
export interface RemotePathMem {
  recent: string[]
  pins: string[]
}

/**
 * 根路径判定：POSIX 根 / 或盘符根（C:/）。根永远一键可达（面包屑/上级），
 * 不入史——否则每次打开面板的初始落点都会把无导航价值的根塞进历史。
 */
export function isRootPath(p: string): boolean {
  if (p === '/') return true
  return /^[A-Za-z]:\/?$/.test(p)
}

/**
 * 记录一次访问：去重置顶 + 截断（LRU 语义；fileTreePins.upsertPin 同式）。
 * 调用方保证 pinned 过的路径不入此表（pin 区常驻，双区不重复）。
 */
export function upsertRecentPath(list: string[], p: string, max = MAX_RECENT_PATHS): string[] {
  return [p, ...list.filter(x => x !== p)].slice(0, max)
}

/** pin：从最近表摘除 + 置顶插入 pin 表（重复 pin = 移到最前；超限 FIFO 淘汰最旧 pin） */
export function pinFromHistory(pins: string[], recents: string[], p: string): RemotePathMem {
  return {
    pins: [p, ...pins.filter(x => x !== p)].slice(0, MAX_PINNED_PATHS),
    recent: recents.filter(x => x !== p),
  }
}

/** unpin：从 pin 表摘除 + 置顶回最近表（不丢路径，取消钉选仍可从最近区点选） */
export function unpinToHistory(pins: string[], recents: string[], p: string): RemotePathMem {
  return {
    pins: pins.filter(x => x !== p),
    recent: upsertRecentPath(recents, p),
  }
}

/** 选项显示别名：末两段（fileTreePins.pinAlias 同式；全路径走 title 属性） */
export function pathAlias(p: string): string {
  const parts = p.split('/').filter(Boolean)
  if (parts.length === 0) return p
  return parts.slice(-2).join('/')
}

/**
 * 持久层读取守卫：脏数据/旧版本残留按空历史处理，不进内存态
 * （useCloneUrlHistory.loadHistory 同式；非字符串/空白项逐条滤除）。
 */
export function parsePathMem(raw: string | null): RemotePathMem {
  const empty: RemotePathMem = { recent: [], pins: [] }
  if (!raw) return empty
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return empty
    const arr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
    return {
      recent: arr((parsed as { recent?: unknown }).recent),
      pins: arr((parsed as { pins?: unknown }).pins),
    }
  } catch {
    return empty
  }
}
