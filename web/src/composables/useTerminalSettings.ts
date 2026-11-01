import { computed, ref } from 'vue'
import { settingsApi, type TerminalBackend, type SettingsData } from '../api/client'
import type { TerminalFontFamily } from '../terminal-themes/types'

/**
 * 终端视图的后端设置同步：一次性拉取 /api/settings，
 * 解析出 scrollback / backend / 命令历史开关，并把主题字体分发回 terminal-theme store。
 * 从 TerminalView.vue 抽出（债项拆分）。
 */
export function useTerminalSettings(options: {
  /** 主题/字体 hydrate 回调（terminal-theme store 在调用方持有） */
  hydrate: (data: { terminalTheme?: string; terminalFont?: TerminalFontFamily }) => void
  /** 全量 settings 数据回调（可选）：宿主复用同一次请求提取其余字段，
   *  避免各终端宿主（项目/全局/管理页）各自再拉一遍 /api/settings */
  onData?: (data: Partial<SettingsData>) => void
}) {
  const DEFAULT_SCROLLBACK_LINES = 20000
  const currentScrollbackLines = ref<number>(DEFAULT_SCROLLBACK_LINES)
  // 命令历史记录开关（拉取前默认开）
  const historyEnabled = ref(true)
  const currentBackend = ref<TerminalBackend>('auto')
  const currentTmuxAvailable = ref(false)
  const currentIsWindows = ref(false)
  // 实际生效的后端（auto 解析后）：auto + tmux 可用 = tmux；否则 native
  const effectiveBackend = computed<'tmux' | 'native'>(() => {
    if (currentBackend.value === 'tmux') return 'tmux'
    if (currentBackend.value === 'auto' && currentTmuxAvailable.value && !currentIsWindows.value) return 'tmux'
    return 'native'
  })

  /** 拉取设置并分发（失败静默：全部保持默认值） */
  function fetchSettings(): void {
    settingsApi.get().then((res: { data?: Partial<SettingsData> } | any) => {
      const data = (res?.data ?? {}) as Partial<SettingsData>
      if (data.terminalBackend) {
        currentBackend.value = data.terminalBackend as TerminalBackend
      }
      if (typeof data.tmuxAvailable === 'boolean') {
        currentTmuxAvailable.value = data.tmuxAvailable
      }
      if (typeof data.platform === 'string') {
        currentIsWindows.value = data.platform.startsWith('win')
      }
      if (typeof data.terminalScrollbackLines === 'number' && data.terminalScrollbackLines > 0) {
        currentScrollbackLines.value = data.terminalScrollbackLines
      }
      if (typeof data.terminalHistoryEnabled === 'boolean') {
        historyEnabled.value = data.terminalHistoryEnabled
      }
      options.hydrate({
        terminalTheme: data.terminalTheme,
        terminalFont: data.terminalFont as TerminalFontFamily | undefined,
      })
      options.onData?.(data)
    }).catch(() => { /* silent */ })
  }

  return {
    currentScrollbackLines,
    historyEnabled,
    currentBackend,
    effectiveBackend,
    fetchSettings,
  }
}
