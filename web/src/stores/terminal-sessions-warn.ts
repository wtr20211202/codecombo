import { computed, ref } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from './theme'
import i18n from '../i18n'

/**
 * 会话数量软阈值提示域（P-20261003-183，自 terminal-sessions store 拆出，纯
 * 搬运零逻辑改动）：创建越过该值时轻提示一次「会话较多」，非阻断（提示不强
 * 管）。每会话一个 PTY 进程 + 回放缓冲，几十个累积（忘记关）资源缓慢劣化——
 * 服务端另有硬上限（terminal.MaxSessions，可配
 * server.terminalMaxSessions，缺省 50、下限护栏 10，超限拒绝，P-20261006-12），
 * 本值是其前的早期可见性，故须始终小于硬上限（下限护栏 ≤10 的收紧配置下本
 * 提示不再先行，服务端拒绝是兜底，无害）。
 */
export const SESSIONS_WARN_THRESHOLD = 20

// 全局 t 函数（store 在 setup 外，无法用 useI18n composable；notification.ts 同款）
const t = (key: string, params?: Record<string, unknown>) => i18n.global.t(key, params as never)

// 阈值提示 toast（useCloneTracker 孤儿兜底同款离散 message）：懒创建——模块
// 会在 jsdom 单测加载，离散 API 延迟到首次真正提示时才建
let manySessionsMessage: ReturnType<typeof createDiscreteApi<'message'>>['message'] | null = null
function manySessionsToast() {
  if (!manySessionsMessage) {
    const themeStore = useThemeStore()
    manySessionsMessage = createDiscreteApi(['message'], {
      configProviderProps: computed(() => ({
        theme: themeStore.naiveTheme,
        themeOverrides: themeStore.naiveOverrides,
      })),
    }).message
  }
  return manySessionsMessage
}

export function useTerminalSessionsWarn() {
  // ============== 会话数量软阈值提示（P-20261003-183，非阻断） ==============
  // episode 门控：一次「超阈时段」只提示一次，不逐次刷屏——提示后的持续创建
  // 不再重复弹，会话数落回阈值以内（关闭/退出）即复位，再次越过会重新提示。
  // 纯内存会话内状态，不持久化（刷新后首次越过仍会提示，正是想要的）
  const manyWarned = ref(false)
  /** 总数越过软阈值时轻提示一次（warning 级、自动消失、不打断创建流程）。
   *  total 为创建响应携带的服务端权威计数（旧服务端缺字段时调用方回退本地
   *  对账后的列表长度），本地列表陈旧不影响判定 */
  function warnIfMany(total: number) {
    if (total <= SESSIONS_WARN_THRESHOLD || manyWarned.value) return
    manyWarned.value = true
    try {
      manySessionsToast()?.warning(t('terminal.manySessionsWarn', { n: total }))
    } catch { /* 提示面故障不影响创建主链路 */ }
  }
  /** 仅供测试使用：复位 episode 门控与 toast 懒创建单例（下个用例的首次提示
   *  重新创建，离散 API 的 mock 调用记录才能逐用例观察——模块级单例否则跨
   *  用例持有旧实例） */
  function resetWarnForTest(): void {
    manyWarned.value = false
    manySessionsMessage = null
  }

  return { manyWarned, warnIfMany, resetWarnForTest }
}
