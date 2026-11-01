// 会话敏感内容自动检测建议（P-20261003-207）：导出动作落地后异步扫描输出
// 尾窗（secretHintInTail，P-197 同款模式集），命中且未标记时弹「标记敏感?」
// 确认——建议非闸门：可跳过、误报容忍，出域拦截仍由 P-155 的
// AgentSessionMeta.Sensitive 闸门负责（本条只负责让标记不依赖记性）。
// 扫描与弹窗全异步：调用方 void 即走，导出链路零阻塞（弹窗迟到属设计语义——
// 建议出现在导出完成之后，不打断下载本身）。
import { useMessage } from 'naive-ui'
import { confirmDialog } from './useDialog'
import { useI18n } from './useI18n'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { secretHintInTail } from '../utils/sensitiveMask'

// 本应用运行内已建议过的会话：跳过/误报后同会话不再重复弹（每次导出都弹
// 属骚扰；要再标记走行菜单「标记敏感」常驻入口）。重开应用视为新会话重新
// 评估——「每会话每运行一次」是防骚扰边界，不是永久豁免
const hinted = new Set<string>()

export function useSensitiveMarkHint() {
  const message = useMessage()
  const { t } = useI18n()

  /**
   * 导出后的敏感内容建议（P-20261003-207）。getText 返回导出内容全文（服务端
   * 链给导出 blob 文本、客户端链给缓冲文本；尾窗抽样在 secretHintInTail 内
   * 统一有界）。永不 reject：取文失败/标记失败静默收场——导出已完成，建议
   * 链路尽力而为
   */
  async function suggestSensitiveMarking(
    sessionId: string,
    sessionName: string,
    getText: () => Promise<string> | string,
  ): Promise<void> {
    try {
      const store = useTerminalSessionsStore()
      // 仅本地会话（AgentSessionMeta 域）可标：远程终端等 id 不在 store 的
      // 会话直接跳过（无标记入口就不建议，避免「确认后落空」的死弹窗）
      const session = store.sessions.find(s => s.id === sessionId)
      if (!session || session.sensitive === true) return
      if (hinted.has(sessionId)) return
      const text = await getText()
      if (!text || !secretHintInTail(text)) return
      hinted.add(sessionId)
      const go = await confirmDialog({
        type: 'warning',
        title: t('terminal.secretHintTitle'),
        content: t('terminal.secretHintContent', { name: sessionName }),
        confirmText: t('terminal.markSensitive'),
        cancelText: t('terminal.secretHintSkip'),
      })
      if (!go) return
      await store.setSensitive(sessionId, true)
      message.success(t('terminal.markSensitiveDone'))
    } catch { /* 建议链路尽力而为（导出已完成）；失败不打扰用户 */ }
  }

  return { suggestSensitiveMarking }
}
