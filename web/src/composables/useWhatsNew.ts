import { ref, watch } from 'vue'
import { whatsNewApi, type WhatsNewInfo, type WhatsNewSection } from '../api/domains/system'
import { safeStorage } from '../utils/storage'
import { isNewerVersion } from '../utils/version'

// 应用内 What's New（P-20261007-17）：升级后首启一次性轻弹层的判定与已读记账。
//
// - delta 口径：段落版本严格新于「上次已读版本」（isNewerVersion 语义化比较，
//   任一侧解析失败视为不新——宁可漏弹不误弹）；无版本号段落只作展示不参与判定
// - 首启无已读记录（新装/本功能上线前的存量用户）：静默记当前最新段为已读，
//   不弹——弹层只服务「升级」场景，打扰度纪律 = 一次性 + 可关 + 不再弹
// - 端点不可达（旧实例/代理拓扑 404）：静默跳过，不做降级补弹
// - 已读记录走 safeStorage（localStorage 通道，隐私模式内存兜底）——纯客户端
//   UI 状态，不入服务端持久化三车道

/** 上次已读版本的 localStorage 键（与 updateNotified.* 同为纯客户端记账键） */
export const WHATS_NEW_SEEN_KEY = 'whatsNewSeenVersion'

// App 单例：弹层判定只跑一次（updateCheck.startAutoCheck 的 started 守卫同款；
// 模块级 ref 供宿主组件与测试共享同一份 show/delta）
let started = false
const show = ref(false)
const delta = ref<WhatsNewSection[]>([])

/** delta 段落：严格新于已读版本的段落（保持后端给序=新版本在前） */
export function whatsNewDelta(sections: WhatsNewSection[], seen: string | null): WhatsNewSection[] {
  if (!seen) return []
  return sections.filter(s => s.version && isNewerVersion(s.version, seen))
}

/** 当前已读基线（无记录返回 null） */
export function whatsNewSeen(): string | null {
  return safeStorage.getItem(WHATS_NEW_SEEN_KEY)
}

/** 记已读：取展示段落中最新的版本号（isNewerVersion 归约取 max，不依赖段序；
 *  全部无版本号段落时保持原基线不动） */
export function markWhatsNewSeen(displayed: WhatsNewSection[]): void {
  const newest = displayed.reduce<string>((acc, s) => {
    if (s.version && (!acc || isNewerVersion(s.version, acc))) return s.version
    return acc
  }, '')
  if (newest) safeStorage.setItem(WHATS_NEW_SEEN_KEY, newest)
}

/** 关闭即记账（一次性语义的收口点）：任意关闭路径——「知道了」按钮、遮罩点击、
 *  Esc——都要把本次展示段落记为已读，否则遮罩/Esc 关闭会绕过记账导致刷新再弹 */
function settleSeen(): void {
  if (delta.value.length === 0) return
  markWhatsNewSeen(delta.value)
  delta.value = []
}

/** 关闭弹层（同步记账，供按钮直呼；遮罩/Esc 关闭经下方 watch 兜住） */
export function dismissWhatsNew(): void {
  show.value = false
  settleSeen()
}
watch(show, (v) => { if (!v) settleSeen() })

/** 启动判定（幂等，App 挂载后调用一次）：拉取段落 → 无记录静默记已读 /
 *  有记录算 delta → 有新版段落才亮弹层 */
export function checkWhatsNew(): void {
  if (started) return
  started = true
  void (async () => {
    let sections: WhatsNewSection[]
    try {
      // silent：端点不可达属预期形态（旧实例/代理拓扑），拦截器不弹错
      const res = await whatsNewApi.get({ silent: true }) as unknown as { data?: WhatsNewInfo }
      sections = res?.data?.sections ?? []
    } catch {
      return
    }
    if (sections.length === 0) return
    const seen = whatsNewSeen()
    if (!seen) {
      markWhatsNewSeen(sections)
      return
    }
    const d = whatsNewDelta(sections, seen)
    if (d.length === 0) return
    delta.value = d
    show.value = true
  })()
}

/** 测试复位：清单例守卫与弹层态（仅测试用途） */
export function resetWhatsNewForTest(): void {
  started = false
  show.value = false
  delta.value = []
}

/** 弹层显隐与 delta（宿主组件只读渲染；关闭必须走 dismissWhatsNew 记账） */
export function useWhatsNew() {
  return { show, delta }
}
