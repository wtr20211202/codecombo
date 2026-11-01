import { computed, ref } from 'vue'
import { safeStorage } from '../utils/storage'

// HTTP 明文访问警示（P-20261002-30）：产品支持 TLS，但局域网经明文 HTTP 访问时
// 解锁密码 / API 令牌 / 代码内容全部明文过线，同网段可嗅探。顶栏下方警示条 +
// 锁屏（输入密码的第一现场）同步提示，两处共享同一「不再提示」记忆。

const DISMISS_KEY = 'sc.httpWarningDismissed'

// loopback 主机名豁免清单——**硬要求**：产品全部 e2e 跑在 http://localhost 下，
// 不豁免会让警示条污染全量截图/断言。URL.hostname 对 IPv6 回环返回无方括号
// 形式（'::1' 而非 '[::1]'），同 InstanceFormModal 的既有注释。
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '::1']

/** 明文 HTTP 访问判定：http: 协议且主机名非 loopback。独立导出便于单测
 *  直传 location 形状（jsdom 的 window.location 不可替换）。 */
export function isPlainHttpContext(
  loc: { protocol: string; hostname: string } = window.location,
): boolean {
  if (loc.protocol !== 'http:') return false
  return !LOOPBACK_HOSTNAMES.includes(loc.hostname.toLowerCase())
}

// 模块级共享状态——警示条与锁屏提示的所有调用点共享同一份记忆。
// 协议/主机在会话内恒定（改变必经整页刷新），检测在模块加载时判定一次。
const plainHttp = isPlainHttpContext()
const dismissed = ref(safeStorage.getItem(DISMISS_KEY) === '1')

export function useHttpWarning() {
  const visible = computed(() => plainHttp && !dismissed.value)

  /** 「不再提示」：写 localStorage（safeStorage 兜底隐私模式），顶栏与锁屏
   *  两处随之共同隐藏 */
  function dismiss(): void {
    dismissed.value = true
    safeStorage.setItem(DISMISS_KEY, '1')
  }

  return { visible, dismiss }
}
