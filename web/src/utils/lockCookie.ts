// 解锁 token 的 cookie 载体（P-20261020-1 引入，P-20261019-2 收口为服务端专管）：
// token cookie 改由服务端在解锁/设密成功响应上以 Set-Cookie 下发——
// HttpOnly（同主机任意端口页面 JS 读不到 document.cookie 里的令牌）+
// SameSite=Strict（防跨站自动携带）+ Secure 按 scheme（服务端 requestIsHTTPS）。
// 前端不再写令牌 cookie，也不再落 localStorage 副本（stores/lock 内存态 +
// 本文件清除串是 JS 侧仅存的两个动作）。
//
// 本文件只剩「清除串」：用于清掉 P-20261019-2 之前旧版本前端经
// document.cookie 写入的非 HttpOnly 旧 cookie（过渡期遗留）。浏览器对
// HttpOnly cookie 的 document.cookie 写入一律忽略——本清除串对服务端签发的
// 新 cookie 无效也无害，HttpOnly 的清除在服务端（锁定响应过期 + 423 顺手清）。
export const LOCK_COOKIE_NAME = 'sc_lock_token'

/** 构造清除 cookie 的字符串（document.cookie 形态，属性与旧写入侧对齐） */
export function buildClearLockCookie(secure: boolean): string {
  const base = `${LOCK_COOKIE_NAME}=; path=/; SameSite=Lax; max-age=0`
  return secure ? `${base}; Secure` : base
}
