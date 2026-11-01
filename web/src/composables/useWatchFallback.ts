import { ref } from 'vue'
import { watchFallbackApi, type WatchFallbackStatus } from '../api/domains/system'
import { CAP_WATCH_FALLBACK, useMetaStore } from '../stores/meta'
import { OPS_WATCH_FALLBACK, type WatchFallbackDetail } from '../utils/opsEvents'

/**
 * 文件监听降级轮询兜底的常驻可见状态（P-20261006-34）：降级是持续态，可见性
 * 不靠一次性通知记忆——状态栏「轮询降级中」微标是本单例的唯一消费面（多组件
 * 同源不落 props/事件，useCompareBaseline 同款模块级单例）。
 *
 * 刷新纪律（提案裁决，不做高频轮询——状态迁移以小时计）：
 * - 主驱动 = 服务端状态迁移广播（watch.fallback 经通知 WS → notification
 *   store 二次分发为本窗口事件），显隐即时且多标签页一致；
 * - 兜底 = 页面加载时（消费方挂载）GET /api/watch/fallback 拉一次快照，覆盖
 *   「加载前已降级」与无广播通道的旧后端；
 * - 自愈 = 窗口重新聚焦时重拉快照（refetch-on-focus 惯例，StatusBar 变更计数
 *   同款）——休眠/断线窗口期错过的广播不可回放，聚焦重拉对账。
 *
 * 能力探测：多实例代理下旧对端未声明 watch-fallback 能力项时不发注定 404 的
 * 快照请求（hasCap 分流惯例）；事件监听照挂——新后端的迁移广播照收。
 */

/** 模块级单例状态：null = 从未拉取（微标隐藏的稳态语义一致） */
const status = ref<WatchFallbackStatus | null>(null)

let initialized = false
/** 快照已至少拉取过一次（含失败）：聚焦重拉只对消费方挂载过的会话生效 */
let primed = false

function applyDetail(d: WatchFallbackDetail): void {
  status.value = {
    enabled: !!d.enabled,
    source: d.source ?? '',
    since: d.since,
  }
}

/** 拉一次降级状态快照（幂等 GET；失败保持现状静默——事件广播在位时下一次
 * 迁移仍会对账，加载失败的代价只是微标暂缺，与「未降级」同形不误导操作） */
async function refresh(): Promise<void> {
  const meta = useMetaStore()
  await meta.ensureCaps()
  if (!meta.hasCap(CAP_WATCH_FALLBACK)) return
  primed = true
  try {
    const { data } = await watchFallbackApi.get({ silent: true })
    status.value = data
  } catch {
    // 静默保旧：快照是微标的兜底源而非权威源，不打扰用户
  }
}

export function useWatchFallback() {
  // 监听装配模块级一次（单例状态同生命周期，不随组件卸载；首个消费方——
  // 状态栏——挂载时初始化，首页等无状态栏视图零开销）
  if (!initialized) {
    initialized = true
    window.addEventListener(OPS_WATCH_FALLBACK, (ev) => {
      applyDetail((ev as CustomEvent<WatchFallbackDetail>).detail ?? {})
    })
    window.addEventListener('focus', () => {
      // 聚焦重拉：休眠/断线窗口期错过的迁移广播不可回放，聚焦对账快照
      if (primed) void refresh()
    })
  }
  return { status, refresh }
}
