// 智能操作通道的浏览器实例身份（P-20261117-4）纯函数面：stable browserId 的
// 生成与读取。frontend 动词族设备定向的路由键——WS 握手 query 携带 + 会话创建
// 请求 X-Browser-Id 头携带，服务端据此把 frontend.* 设备效应（下载框/剪贴板/
// 开标签/重载）路由到「发起会话的那台浏览器」而非全部已连浏览器。
// 本模块不持视图状态，与 clipRelay（P-20261002-32）同构拆分。

import { safeStorage } from './storage'

const BROWSER_ID_KEY = 'sc.ops.browserId'

// 形态上限与服务端 SanitizeBrowserId 对齐（64 字节 + 白名单字符集）——
// 生成的 id 天然合规，上限只是防外部改写脏值时的静默失联（脏值被服务端
// 拒收 = 该浏览器收不到定向效应，宁可生成新 id 也不悄悄降级）
const BROWSER_ID_MAX = 64

let cachedBrowserId = ''

/**
 * 本浏览器实例 id（localStorage 持久、同浏览器多标签共享）：frontend.* 设备
 * 效应的定向路由键（P-20261117-4）。身份粒度=每浏览器（clipRelay 的
 * sc.clip-relay.device 同款），与 notesOriginNonce 的每窗粒度两级互补不混用。
 * 随机 id 不含任何机器指纹——它只是路由标签而非安全边界（同实例信任域内
 * 伪造 browserId 只能收到本就发给某浏览器的设备效应），丢失的代价是绑定/
 * 启发式暂时失准，服务端降级通知化兜底。不用 crypto.randomUUID：非安全上下文
 * （LAN http 访问）下为 undefined（clipRelay ownClipDeviceId 同款坑，dsh
 * polyfill 同款坑），这里只需要唯一性不需要密码学强度
 */
export function opsBrowserId(): string {
  if (cachedBrowserId) return cachedBrowserId
  let id = safeStorage.getItem(BROWSER_ID_KEY) || ''
  if (!id || id.length > BROWSER_ID_MAX || !/^[A-Za-z0-9._-]+$/.test(id)) {
    id = `ops-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    safeStorage.setItem(BROWSER_ID_KEY, id)
  }
  cachedBrowserId = id
  return id
}

/** browserId 的 WS query / 请求头携带形态（URL 已编码） */
export function opsBrowserIdQuery(): string {
  return `browserId=${encodeURIComponent(opsBrowserId())}`
}

/** 测试钩子：清模块级缓存（用例间隔离，clipRelay 同惯例） */
export function resetOpsBrowserIdForTest(): void {
  cachedBrowserId = ''
}
