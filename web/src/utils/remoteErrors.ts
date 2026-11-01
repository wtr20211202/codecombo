type TFunc = (key: string, params?: Record<string, unknown>) => string

/**
 * 远程主机连接类错误的友好化：把 ssh dial / ftp 的底层报错原文映射为
 * 用户可行动的提示（与全局 KNOWN_ERROR_I18N 同口径）。
 * 无法识别时原样返回——原文仍是排障的重要线索。
 *
 * 二期注记（P-20261005-153）：http.ts 的 ERROR_CODE_I18N 已按结构化错误码
 * （P-305 响应体 {error, code}，remote/域码 remote.auth_failed /
 * remote.host_key_changed 等）优先命中——本函数的调用面（SSH dial 原始错误，
 * 非 HTTP 响应体）多数拿不到 code 字段，正则层仍是主路径；待远程连接错误
 * 通道结构化后同口径接入 code 优先层。
 *
 * @param msg 服务端返回的错误原文（如 "ssh dial 127.0.0.1:23: auth rejected..."）
 * @param t   i18n 翻译函数
 */
export function friendlyRemoteError(msg: string, t: TFunc): string {
  const rules: Array<[RegExp, string]> = [
    // SSH 主机密钥 TOFU 变更拒绝（P-20261003-34）：服务端稳定标记 hostKeyChangedMarker
    //（"host key has changed"），文案指向主机设置的重置入口
    [/host key has changed/i, 'errors.known.hostKeyChanged'],
    [/auth rejected|unable to authenticate|authentication failed/i, 'errors.known.authFailed'],
    [/permission denied/i, 'errors.known.permissionDenied'],
    [/connection refused/i, 'errors.known.connRefused'],
    [/no route to host|network is unreachable|i\/o timeout|timed out/i, 'errors.known.netUnreachable'],
    [/no supported methods remain/i, 'errors.known.authFailed'],
    [/not found/i, 'errors.known.remoteHostNotFound'],
  ]
  for (const [re, key] of rules) {
    if (re.test(msg)) return t(key)
  }
  return msg
}
