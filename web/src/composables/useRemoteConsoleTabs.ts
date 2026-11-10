import { ref } from 'vue'
import type { Ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { useRemoteHostStore } from '../stores/remoteHost'
import { remoteHostApi } from '../api/client'
import type { RemoteHost } from '../api/client'
import { confirmDialog, promptDialog } from './useDialog'

// 远程控制台的 tab 生命周期（自 RemoteConsoleView 原样搬运，P-20261002-27）：
// 开 / 关 / 重开 / 重命名 / 聚焦 / 命名 / SFTP 无 shell 延迟提示。
// tabs / activeTabId 状态由宿主持有并传入，本 composable 只操作其内容。
export interface ConsoleTab {
  hostId: string
  sessionId: string
  title: string
  /** 远端 tmux 会话名（服务端 terminalRemoteTmux 开启时创建；重开时回传以重连既有会话） */
  tmuxName?: string
  /** 远端 tmux 版本与剪贴板能力地板（P-20261109-7 A2）：create 时并行探测回带；
   *  探测失败/页面刷新恢复的旧 tab 无值——pane 挂载时经 tmux-floor 端点补拉 */
  tmuxVersion?: string
  tmuxClipboardFloor?: string
  /** open = WS 会话进行中；ended = 服务端会话已 GC（终态，可重开） */
  state: 'open' | 'ended'
}

// 各 tab 终端实例（发送常用命令 + 右键菜单动作下发；能力与项目终端同层）
export interface RemotePaneApi {
  writeInput(data: string): boolean
  copySelection(): void
  // 复制为代码块（```bash 围栏 + 命令行头；与项目终端同款，P-20261003-270）
  copyAsCodeBlock(): void
  copyAll(): void
  // 复制上一条命令输出（OSC 133 C/D 行号记账区间提取；与项目终端同款）
  copyLastOutput(): void
  pasteFromClipboard(): void
  exportAsText(name: string): void
  getSelectionLength(): number
  clear(): void
  fit(deep?: boolean): void
  hasReceivedOutput(): boolean
  disconnect(): void
}

export interface UseRemoteConsoleTabsDeps {
  tabs: Ref<ConsoleTab[]>
  activeTabId: Ref<string>
  // pane 实例引用表（宿主经 setPaneRef 维护；SFTP 无 shell 观察期读取输出状态）
  paneRefs: Map<string, RemotePaneApi>
  // FTP 主机开终端必败：改直达文件管理（弹窗状态由宿主模板持有）
  onOpenFileManager?: (host: RemoteHost) => void
}

export function useRemoteConsoleTabs(deps: UseRemoteConsoleTabsDeps) {
  const { tabs, activeTabId, paneRefs } = deps
  const { t } = useI18n()
  const message = useMessage()
  const remoteHostStore = useRemoteHostStore()

  // 创建中标记（按 hostId）：驱动入口按钮 loading
  const creating = ref<Record<string, boolean>>({})

  function hostById(id: string) {
    return remoteHostStore.hosts.find(h => h.id === id)
  }

  function nextTitle(hostId: string): string {
    const name = hostById(hostId)?.name || '?'
    const seq = tabs.value.filter(tb => tb.hostId === hostId).length + 1
    return `${name} · ${seq}`
  }

  /** 预选主机直达（palette「连接主机」/设置卡「终端」/深链）：已有终端聚焦最近一条
   *  而非再开（误触不再产生多余 SSH 会话）；全部关闭时退化为正常开终端 */
  function focusHost(hostId: string) {
    const mine = tabs.value.filter(tb => tb.hostId === hostId && tb.state === 'open')
    if (mine.length === 0) {
      void openTerminal(hostId)
      return
    }
    const latest = mine[mine.length - 1]
    if (!latest) return
    activeTabId.value = latest.sessionId
  }

  /** 打开终端失败的信息：按服务端错误特征追加可行动提示（认证被拒/凭据解密失败/FTP 主机） */
  function terminalOpenErrorText(e: unknown): string {
    const err = e as { rawMessage?: string; message?: string; userMessage?: string }
    const raw = err?.rawMessage || err?.message || ''
    // 友好文案为主，原文截断作摘要（路径/堆栈不整段直出）
    const summary = raw.length > 120 ? `${raw.slice(0, 120)}…` : raw
    const base = `${t('remoteConsole.openFailed')}${summary ? `: ${summary}` : ''}`
    if (raw.includes('FTP host')) return `${base} —— ${t('remoteConsole.ftpNoTerminalHint')}`
    if (raw.includes('credential decrypt failed')) return `${base} —— ${t('remoteConsole.decryptFailHint')}`
    if (raw.includes('auth rejected') || raw.includes('unable to authenticate')) return `${base} —— ${t('remoteConsole.authFailHint')}`
    return err?.userMessage || base
  }

  async function openTerminal(hostId: string) {
    // FTP 主机无 shell：开终端必败——改直达文件管理（与卡片点击行为一致）
    const h = hostById(hostId)
    if (h && h.protocol === 'ftp') {
      deps.onOpenFileManager?.(h)
      return
    }
    if (creating.value[hostId]) return
    creating.value[hostId] = true
    try {
      // 响应拦截器已解包：res 即 { data: { sessionId, ... } }；silent 避免拦截器+本地双 toast
      const res = await remoteHostApi.createTerminal(hostId, 24, 80, { config: { silent: true } }) as unknown as { data?: { sessionId: string; tmuxName?: string; tmuxVersion?: string; tmuxClipboardFloor?: string } }
      const d = res.data
      if (!d?.sessionId) return
      const tab: ConsoleTab = {
        hostId,
        sessionId: d.sessionId,
        title: nextTitle(hostId),
        tmuxName: d.tmuxName,
        tmuxVersion: d.tmuxVersion,
        tmuxClipboardFloor: d.tmuxClipboardFloor,
        state: 'open',
      }
      tabs.value.push(tab)
      activeTabId.value = tab.sessionId
      // 纯 SFTP 服务器可能未开放 shell（连接成功但终端持续无输出）：不开连即提示——
      // shell 正常时前置提示是噪声；改为建连后观察 8s，仍零输出才提示，
      // 避免用户面对空白终端误判为故障
      if (h && h.protocol === 'sftp') scheduleSftpShellHintCheck(tab.sessionId)
    } catch (e: unknown) {
      message.error(terminalOpenErrorText(e), { duration: 8000 })
    } finally {
      creating.value[hostId] = false
    }
  }

  /** SFTP 无 shell 提示的观察期：会话关闭/已退出/已有输出则静默 */
  const SFTP_SHELL_HINT_DELAY_MS = 8000
  function scheduleSftpShellHintCheck(sessionId: string) {
    window.setTimeout(() => {
      const tab = tabs.value.find(tb => tb.sessionId === sessionId)
      if (!tab || tab.state !== 'open') return
      if (paneRefs.get(sessionId)?.hasReceivedOutput()) return
      message.info(t('remoteConsole.sftpShellHint'), { duration: 6000 })
    }, SFTP_SHELL_HINT_DELAY_MS)
  }

  /** 终态 tab 重开：同主机新 session，复用原 tab 位 */
  async function reopenTab(tab: ConsoleTab) {
    const idx = tabs.value.indexOf(tab)
    if (idx === -1) return
    creating.value[tab.hostId] = true
    try {
      const res = await remoteHostApi.createTerminal(tab.hostId, 24, 80, { config: { silent: true }, tmuxName: tab.tmuxName }) as unknown as { data?: { sessionId: string; tmuxName?: string; tmuxVersion?: string; tmuxClipboardFloor?: string } }
      const d = res.data
      if (!d?.sessionId) return
      tabs.value[idx] = {
        ...tab,
        sessionId: d.sessionId,
        tmuxName: d.tmuxName || tab.tmuxName,
        // 重开再探一次：远端 tmux 升级/降级后横幅随之刷新（空 = 探测失败保持无横幅）
        tmuxVersion: d.tmuxVersion,
        tmuxClipboardFloor: d.tmuxClipboardFloor,
        state: 'open',
      }
      activeTabId.value = d.sessionId
    } catch (e: unknown) {
      message.error(terminalOpenErrorText(e), { duration: 8000 })
    } finally {
      creating.value[tab.hostId] = false
    }
  }

  // 关 tab 是否需确认与项目终端共用同一设置（sc.terminal.closeNoConfirm）；
  // 宿主内主动清理（如删除主机）跳过确认
  function closeTab(tab: ConsoleTab, opts?: { skipConfirm?: boolean }) {
    const doClose = () => {
      if (tab.state === 'open') {
        void remoteHostApi.closeTerminal(tab.hostId, tab.sessionId).catch(() => { /* 会话可能已被服务端 GC */ })
      }
      tabs.value = tabs.value.filter(tb => tb !== tab)
      if (activeTabId.value === tab.sessionId) {
        activeTabId.value = tabs.value[tabs.value.length - 1]?.sessionId || ''
      }
    }
    if (opts?.skipConfirm) {
      doClose()
      return
    }
    const noConfirm = localStorage.getItem('sc.terminal.closeNoConfirm') === '1'
    if (noConfirm || tab.state === 'ended') {
      doClose()
      return
    }
    void confirmDialog({
      title: t('remoteConsole.closeTitle'),
      content: t('remoteConsole.closeConfirm', { title: tab.title }),
      type: 'warning',
    }).then((ok) => { if (ok) doClose() })
  }

  async function renameTab(tab: ConsoleTab) {
    const name = await promptDialog({
      title: t('remoteConsole.renameTitle'),
      label: t('remoteConsole.renameLabel'),
      defaultValue: tab.title,
    })
    if (name && name.trim()) tab.title = name.trim()
  }

  // WS 重连预算耗尽（服务端会话已 GC / 主机不可达）→ 终态
  function onPaneExit(sessionId: string) {
    const tab = tabs.value.find(tb => tb.sessionId === sessionId)
    if (tab) tab.state = 'ended'
  }

  return {
    creating,
    hostById,
    focusHost,
    openTerminal,
    reopenTab,
    closeTab,
    renameTab,
    onPaneExit,
  }
}
