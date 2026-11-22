// 快投递完整链接主人侧本机缓存（P-20261117-1）。
//
// 动机：scd_ token 服务端只存 sha256 哈希不存明文（server/store/quickdrop.go
// 「只存哈希不存明文：token 是投递凭据」），Generate/轮换时明文只返回一次；
// 管理面此前只在成功回调那一刻持完整 URL，刷新/换天后主人只能翻旧聊天记录
// 找回 /drop/<token> 链接——「明文仅显示一次」不该等于「此后再无出口」。
//
// 安全边界（不推翻）：明文已在主人浏览器手里的一刻（生成/轮换成功回调）才
// 落缓存，缓存面 = 已见过明文的同一浏览器，零新增暴露面；服务端依旧零明文，
// 显示一次/仅哈希/撤销即失效三条语义全不动（与 sc.unlockToken 本机存凭据
// 同级先例）。不做服务端明文找回。
//
// 陈旧防御：缓存随行记录 rotatedAt（服务端 Meta 回传的轮换时间戳），token 可
// 经脚本 API 或他机浏览器轮换/撤销——与 Meta 比对不符即视为死链（调用方置灰
// 并提示「凭据已在他处轮换」），绝不把可能失效的链接当活链复制。
import { safeStorage } from './storage'

/** 缓存载荷：完整投递页链接（buildDropUrl 产物）+ 写入时的服务端 rotatedAt */
export interface QuickdropUrlCache {
  url: string
  rotatedAt: string
}

export const QUICKDROP_URL_KEY = 'sc.quickdrop.url'

/** 读缓存；缺失/损坏/形状不符一律回落 null（缓存是纯便利，任何异常都不该打断管理面） */
export function readQuickdropUrlCache(): QuickdropUrlCache | null {
  const raw = safeStorage.getItem(QUICKDROP_URL_KEY)
  if (!raw) return null
  try {
    const obj = JSON.parse(raw) as { url?: unknown; rotatedAt?: unknown }
    if (
      typeof obj?.url !== 'string' || !obj.url ||
      typeof obj?.rotatedAt !== 'string' || !obj.rotatedAt
    ) return null
    return { url: obj.url, rotatedAt: obj.rotatedAt }
  } catch {
    return null
  }
}

/** 写缓存（生成/轮换成功回调处调用；rotatedAt 由调用方从 Meta 取，空值不写防假比对） */
export function writeQuickdropUrlCache(url: string, rotatedAt: string): void {
  if (!url || !rotatedAt) return
  const payload: QuickdropUrlCache = { url, rotatedAt }
  safeStorage.setItem(QUICKDROP_URL_KEY, JSON.stringify(payload))
}

/** 清缓存（撤销成功 / Meta 回报凭据已不存在） */
export function clearQuickdropUrlCache(): void {
  safeStorage.removeItem(QUICKDROP_URL_KEY)
}
