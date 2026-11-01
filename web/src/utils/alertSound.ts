// 审批/提问等待音效合成器（P-20261003-33）：Web AudioContext 振荡器现场合成
// 短促上行双音——零二进制资产依赖。逻辑独立成纯函数模块：不持有视图状态，
// OpsChannelBridge 仅委托一行（同 agentTaskNotify / previewPortNotify 惯例）。
//
// 门控链（playAlert 内串联，全部复用既有守卫位、不改它们本身）：
//   总开关（设置·通知区，默认开）→ 免打扰时段（P-20261002-40 同守卫位，例外
//   类别穿透 P-20261003-115：approval 默认在例外表，夜间挂机审批提醒不吞；
//   ask 无归属例外照旧静默）→ 锁定态（P-20261003-5 同守卫位）→ AudioContext
//   未解锁（见下）。
// 卡片视觉通道（ApprovalCards / AskCards）不经过本模块——门控只吞声音不吞卡，
// 与桌面通知「只吞打扰不吞账目」同语义。
//
// 浏览器自动播放策略边界：AudioContext 须在用户手势上下文中才能出声。工作台
// 长驻形态首次 pointerdown/keydown 即创建 + resume 完成解锁；解锁前到达的等待
// 事件播不出（浏览器本就禁声）→ 静默跳过不排队，下一事件在解锁后正常响。
import { useSoundStore } from '../stores/sound'
import { useDndStore } from '../stores/dnd'
import { useLockStore } from '../stores/lock'

// 模块级单例：首次手势时懒创建，页面生命周期内复用（工作台长驻形态只建一次）
let ctx: AudioContext | null = null
let unlockBound = false
let unlockHandler: (() => void) | null = null

function ensureContext(): AudioContext | null {
  if (ctx) return ctx
  // 能力探测：jsdom / 老浏览器无 Web Audio——返回 null 由播放侧静默跳过
  const Ctor = typeof AudioContext !== 'undefined'
    ? AudioContext
    : (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    ctx = null
  }
  return ctx
}

/** 首次用户手势解锁（OpsChannelBridge 挂载时绑定一次，页面生命周期常驻）：
 * 手势事件内创建 + resume——浏览器只允许在手势调用栈里把 suspended 拉成
 * running。监听不解绑：后续被系统挂起（部分浏览器切 tab 会挂起）时手势可
 * 就地拉起，无手势时 resume 被拒静默忽略 */
export function bindAudioUnlock(): void {
  if (unlockBound) return
  unlockBound = true
  unlockHandler = () => {
    const c = ensureContext()
    if (c && c.state === 'suspended') {
      void c.resume().catch(() => { /* 无手势上下文被拒：保持 suspended，播放侧静默跳过 */ })
    }
  }
  // capture + passive：只旁观不参与业务，也不影响页面滚动/组合键行为
  window.addEventListener('pointerdown', unlockHandler, { capture: true, passive: true })
  window.addEventListener('keydown', unlockHandler, { capture: true, passive: true })
}

/** 单音：sine 短音 + 快起慢衰指数包络（指数斜坡不可到 0，以极小值兜底） */
function beep(c: AudioContext, at: number, freq: number, dur: number): void {
  const osc = c.createOscillator()
  const gain = c.createGain()
  osc.type = 'sine'
  osc.frequency.value = freq
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(0.05, at + 0.012) // 快起；峰值 0.05 柔和不炸耳
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)
  osc.connect(gain)
  gain.connect(c.destination)
  osc.start(at)
  osc.stop(at + dur + 0.02)
}

/** 等待音效入口（OpsChannelBridge 在 approval.pending / input.request 到达时
 * 调用，category 传事件归属：'approval' / 'ask'——免打扰例外类别按归属判定，
 * P-20261003-115）：门控链全过且上下文 running 才出声；任一不过即静默返回
 *（不排队不重试——ops 通道无重连回放，同一事件不会二次到达，无需按 id 去重） */
export function playAlert(category: string): void {
  if (!useSoundStore().enabled) return // 总开关（设置·通知区，默认开）
  if (useDndStore().isSilenced(category)) return // 免打扰时段（P-40 同守卫位，例外类别穿透）
  if (useLockStore().isLocked) return // 锁定态（P-5 同守卫位）
  const c = ctx
  if (!c || c.state !== 'running') return // 未手势解锁 / 被系统挂起：播不出即跳过
  try {
    const t0 = c.currentTime + 0.01
    beep(c, t0, 880, 0.09) // A5
    beep(c, t0 + 0.11, 1174.7, 0.16) // D6 上行纯四度收尾——「等待裁决」辨识度
  } catch {
    // 合成失败静默：音频是旁路注意通道，任何异常不干扰审批/提问主流程
  }
}

// 测试钩子：丢弃已建上下文并解绑手势监听（用例间隔离；生产代码不调用）
export function resetAlertSoundForTest(): void {
  if (unlockHandler) {
    window.removeEventListener('pointerdown', unlockHandler, { capture: true })
    window.removeEventListener('keydown', unlockHandler, { capture: true })
    unlockHandler = null
  }
  ctx = null
  unlockBound = false
}
