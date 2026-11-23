/**
 * 终端 WS `input_rejected` 帧码 → 文案键的单一映射（P-20261122-17）。
 *
 * 终端 WS 的 PTY 输出恒为 BinaryMessage，TextMessage 整类是服务端控制帧
 * （JSON）。`input_rejected` 帧有两个稳定 code（服务端
 * api/terminal/ws_attach.go 同名常量对账）：
 *   - readonly_external：真·接管会话服务端只读闸（origin=external，
 *     input-lock 解锁可恢复）
 *   - input_held_by_share：分享持权闸（访客正通过分享输入，owner 键盘让位；
 *     恢复路径是在分享中心收回输入权或结束分享，input-lock 不解此闸）
 * 两码此前共用 readonly_external 与「解锁后可输入」文案，用户按提示解锁
 * 无效（P-20261122-17 立案）。本模块是 code → toast 文案键的唯一事实源，
 * 未知码不提示（前向兼容：新增码不刷无意义 toast）。
 */

/** 真·接管会话服务端只读闸拒绝码（P-20261008-17） */
export const TERMINAL_WS_REJECT_READONLY_EXTERNAL = 'readonly_external'

/** 分享持权拒绝码（P-20261122-17） */
export const TERMINAL_WS_REJECT_INPUT_HELD_BY_SHARE = 'input_held_by_share'

/** 服务端 input_rejected 帧码 → i18n 文案键；未知码返回 null（不提示） */
export function terminalRejectToastKey(code: string | undefined): string | null {
  if (code === TERMINAL_WS_REJECT_READONLY_EXTERNAL) return 'terminal.inputLock.rejectedServer'
  if (code === TERMINAL_WS_REJECT_INPUT_HELD_BY_SHARE) return 'terminal.inputLock.rejectedShare'
  return null
}

// 拒绝 toast 去重（按会话+文案键 4s 一条——服务端已 1s 防抖，多 pane 同会话
// 与 agent 灌输入场景再压一档，不刷屏）。message/t 由调用方传入：useMessage/
// useI18n 必须在组件 setup 上下文调用，WS onmessage 回调里注入会失败
const lastRejectToastAt = new Map<string, number>()

/** 按帧码展示拒绝 toast（未知码/空码静默）。文案分义：readonly_external=
 * 解锁可输入；input_held_by_share=分享持权，恢复路径在分享中心 */
export function maybeToastTerminalReject(
  sessionId: string,
  message: { warning: (text: string) => void },
  t: (key: string) => string,
  code: string | undefined,
): void {
  const toastKey = terminalRejectToastKey(code)
  if (!toastKey) return
  const now = Date.now()
  const dedupeKey = `${sessionId}|${toastKey}`
  if (now - (lastRejectToastAt.get(dedupeKey) ?? 0) < 4000) return
  lastRejectToastAt.set(dedupeKey, now)
  message.warning(t(toastKey))
}
