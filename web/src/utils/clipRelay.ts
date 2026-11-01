// 跨设备剪贴板中继（P-20261002-32）纯函数面：设备 id 管理 / 到达事件过滤 /
// 本机剪贴板读取降级链。toast 与请求编排在使用侧（OpsChannelBridge 到达桥 /
// useClipRelay 发取动作），本模块不持视图状态——与 previewPortNotify
//（P-20261002-70）同构拆分，逻辑可在 jsdom 单测

import type { ClipArrivedDetail } from './opsEvents'
import { safeStorage } from './storage'

/** 内容字节上限：与服务端 clipMaxBytes（server/api/system/clip.go）镜像，
 *  改一侧须同步另一侧 */
export const CLIP_MAX_BYTES = 32 * 1024

const DEVICE_KEY = 'sc.clip-relay.device'

let cachedDeviceId = ''

/**
 * 本机设备 id（localStorage 持久、同浏览器多 tab 共享）：clipboard.arrived
 * 广播按 origin 过滤，发送方自己（整个浏览器）不弹「剪贴板收到新内容」toast。
 * 随机 id 不含任何机器指纹——它只是回声抑制标签，丢失的代价仅是自家多弹一次
 * toast。不用 crypto.randomUUID：非安全上下文（LAN http 访问）下为 undefined
 * （dsh polyfill 同款坑），这里只需要唯一性不需要密码学强度
 */
export function ownClipDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  let id = safeStorage.getItem(DEVICE_KEY) || ''
  if (!id) {
    id = `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    safeStorage.setItem(DEVICE_KEY, id)
  }
  cachedDeviceId = id
  return id
}

/** 测试钩子：清模块级缓存（用例间隔离） */
export function resetClipRelayStateForTest(): void {
  cachedDeviceId = ''
}

/**
 * 到达事件是否来自其他设备：origin 等于本机 id = 自己发的回声，静默；
 * origin 缺失（调用方绕过前端直调 API 的旧形态）按「他人」处理——宁多提示
 * 不漏提示，缺字段时的静默会让真实到达无人看见
 */
export function isForeignArrival(detail: ClipArrivedDetail | null | undefined): boolean {
  const origin = (detail?.origin || '').trim()
  return origin === '' || origin !== ownClipDeviceId()
}

/**
 * 读本机剪贴板文本（发送侧取料）：优先 navigator.clipboard.readText（secure
 * context + 浏览器授权），失败/不可用回退应用内剪贴板历史最新一条（clipboardHistory
 * store 的 copyText 挂钩入史——LAN http 非安全上下文 readText 为 undefined，
 * 与健壮性红线同款场景，应用内复制的内容仍可发送）。都拿不到返回 null
 * （调用方给「无可发送内容」提示），入参传 entries 数组本身（MRU 在前）
 */
export async function readLocalClipboardText(history: ReadonlyArray<{ text: string }>): Promise<string | null> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      const text = await navigator.clipboard.readText()
      if (text) return text
    }
  } catch {
    /* 权限拒绝 / 文档失焦：走应用内历史兜底 */
  }
  return history.length > 0 ? (history[0]?.text || null) : null
}

/** 内容字节数（TextEncoder：CJK 下 string.length 低估，与 clipboardHistory 同款） */
export function clipByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}
