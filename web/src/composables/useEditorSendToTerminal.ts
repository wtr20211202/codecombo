import { h, ref } from 'vue'
import type { Ref } from 'vue'
import type { VNodeChild } from 'vue'
import { NCheckbox } from 'naive-ui'
import type { MessageApi } from 'naive-ui'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { containsSensitiveValue } from './useAgentFix'
import { PASTE_SIZE_WARN_BYTES, isPasteMultilineNoWarn, setPasteMultilineNoWarn } from './useTerminalClipboard'

/**
 * 编辑器「发送选中到终端」（P-20261004-21）：Monaco 右键菜单把选中的命令/SQL/
 * 脚本写进当前活跃终端并回车执行（VS Code「Run Selection in Active Terminal」
 * 同场景）。写入通道复用 Layout provide 的 sendToTerminal 链——底部终端面板 →
 * TerminalView.sendText → 高危命令影响面闸门（gateTerminalInput）→
 * pane.writeInput，无活跃终端按 createIfMissing 先开项目默认终端（tab 栏「+」
 * 同一条创建链）。本组合式只管编辑器侧的选区捕获与确认编排，不另起写入面。
 *
 * 确认链（任一取消即整体丢弃，全部通过才落 PTY）：
 * ① 敏感启发式（containsSensitiveValue 复用，与 agent prompt 出域同口径）命中
 *   先提示——选区写终端会被执行并进 shell 历史，外泄面与出域等同；
 * ② 多行（可被「不再提示」豁免，与终端粘贴链共用同一偏好键）/ 超 64KB（体积
 *   感知版，不受豁免，P-20261002-136 同口径）走大粘贴确认同款弹窗（预览前
 *   PREVIEW_LINES 行 + 行数/体积 + 不再提示勾选）；
 * ③ 高危命令影响面确认卡由 sendText 链内既有闸门承接，此处不重复建卡。
 *
 * 执行语义：写入前剥离选区尾部单个换行再补一个 \r（PTY Enter）——与广播输入/
 * agent launch 注入同一惯例；网页复制来的命令几乎都带尾换行，不剥会多一记空回车。
 */

/** 与 TerminalView.sendText 链对齐的结果三态（'no-pane' 在宿主侧折算为
 *  'no-terminal'，本组合式不感知 pane 细节） */
export type SendToTerminalOutcome = 'sent' | 'cancelled' | 'no-terminal'

export interface EditorSendToTerminalDeps {
  /** 当前选区文本（空串 = 无选区/无编辑器；菜单 precondition 已挡空选区，防御性再守） */
  getSelection: () => string
  /** 写入链：Layout provide 的 sendToTerminal（内部已过高危命令闸门） */
  send: (text: string, opts?: { createIfMissing?: boolean }) => Promise<SendToTerminalOutcome>
  t: ReturnType<typeof useI18n>['t']
  message: MessageApi
}

/** 确认弹窗预览行数：与终端粘贴确认同款（useTerminalClipboard.pastePreviewLines） */
const PREVIEW_LINES = 8

// UTF-8 字节数统计：模块级复用 encoder（useTerminalClipboard 同款），阈值按真实
// 字节算——CJK 内容下 string.length 低估约 3 倍
const sendTextEncoder = new TextEncoder()

/** 一次发送的判定计划（纯函数可单测）：剥尾换行后的净文本 + 各确认维度的命中面 */
export interface EditorSendPlan {
  /** 剥尾换行后的净文本（落 PTY 前由调用方补 \r） */
  payload: string
  /** 超 64KB：体积感知版弹窗，不受「不再提示」豁免（与粘贴链同口径） */
  large: boolean
  /** 需要多行确认（payload 多行且偏好未豁免） */
  multiline: boolean
  lineCount: number
  kb: number
  /** 弹窗预览行（前 PREVIEW_LINES 行） */
  previewLines: string[]
}

export function planEditorSend(text: string, multilineNoWarn: boolean): EditorSendPlan {
  // 剥尾换单个（CRLF / LF / CR），与粘贴链 applyPaste 同一正则口径
  const payload = text.replace(/\r?\n$/, '').replace(/\r$/, '')
  const lines = payload.split(/\r\n|\r|\n/)
  // 字节按原始选区算（粘贴链同口径：剥尾省下的几个字节不影响档位判定）
  const bytes = sendTextEncoder.encode(text).byteLength
  return {
    payload,
    large: bytes > PASTE_SIZE_WARN_BYTES,
    multiline: lines.length > 1 && !multilineNoWarn,
    lineCount: lines.length,
    kb: Math.round(bytes / 1024),
    previewLines: lines.slice(0, PREVIEW_LINES),
  }
}

/** 确认弹窗正文（渲染函数，导出供单测驱动勾选联动）：提示行 + 预览块 +
 *  「不再提示」勾选（大文本不渲染勾选——该档位不受偏好豁免，渲染了也无意义）。
 *  noWarn 为受控 ref，勾选状态经渲染依赖回收驱动弹窗重渲染（promptDialog 输入框
 *  同链路先例） */
export function renderSendConfirmBody(
  plan: EditorSendPlan,
  noWarn: Ref<boolean>,
  t: (key: string, params?: Record<string, unknown>) => string,
): VNodeChild {
  return h('div', { style: 'color: var(--text-body); font-size: 13px; line-height: 1.6' }, [
    h('p', { style: 'margin: 0 0 10px' }, t(
      plan.large ? 'editor.sendToTerminal.largeWarn' : 'editor.sendToTerminal.multilineWarn',
      { n: plan.lineCount, kb: plan.kb },
    )),
    h('div', { style: 'margin: 0 0 10px' }, [
      h('div', { style: 'color: var(--text-dim); font-size: 11px; margin-bottom: 4px' },
        t('editor.sendToTerminal.preview', { n: plan.previewLines.length })),
      // 预览块样式与 TerminalPane .paste-preview 同值内联（离散弹窗挂 body 层
      // 拿不到组件 scoped class，同 terminal-pane.css n-modal 放行注记的边界）
      h('pre', {
        style: 'margin:0;padding:8px 10px;max-height:180px;overflow:auto;background:var(--bg-terminal);border:1px solid var(--border-default);border-radius:4px;color:var(--text-body);font-family:var(--font-mono, monospace);font-size:12px;line-height:1.5;white-space:pre-wrap',
      }, plan.previewLines.join('\n')),
    ]),
    plan.large ? null : h(NCheckbox, {
      checked: noWarn.value,
      'onUpdate:checked': (v: boolean) => { noWarn.value = v },
    }, () => t('terminal.closeConfirmNoPrompt')),
  ])
}

export function useEditorSendToTerminal(deps: EditorSendToTerminalDeps) {
  const { getSelection, send, t, message } = deps
  // 发送中标志：确认链是异步流程，防右键连点重入（重复写入即重复执行）
  const sending = ref(false)

  /** 右键「发送选中到终端」：确认链全过 → 写入活跃终端并回车执行 */
  async function sendSelectionToTerminal(): Promise<void> {
    if (sending.value) return
    const text = getSelection()
    if (!text) return
    // 重入锁从入口即落（不是写入前才落）：确认链是异步流程，链中再触发会叠出
    // 第二张确认卡，两张都确认就是两次执行——整个流程单飞
    sending.value = true
    try {
      // ① 敏感启发式（命中先提示）：取消 = 整体放弃，不进后续任何闸
      if (containsSensitiveValue(text)) {
        const ok = await confirmDialog({
          title: t('editor.sendToTerminal.sensitiveTitle'),
          content: t('editor.sendToTerminal.sensitiveBody'),
          type: 'warning',
        })
        if (!ok) return
      }
      // ② 多行 / 超 64KB：大粘贴确认同款（大文本档不受「不再提示」豁免）
      const plan = planEditorSend(text, isPasteMultilineNoWarn())
      // 剥尾换行后为空（纯空白/纯换行选区）：无命令可执行，补 \r 也只是空回车，
      // 直接放弃不打扰终端
      if (!plan.payload) return
      if (plan.multiline || plan.large) {
        const noWarn = ref(isPasteMultilineNoWarn())
        const ok = await confirmDialog({
          title: t(plan.large ? 'editor.sendToTerminal.largeTitle' : 'editor.sendToTerminal.multilineTitle'),
          content: () => renderSendConfirmBody(plan, noWarn, t),
          type: 'warning',
          confirmText: t('editor.sendToTerminal.sendAnyway'),
          cancelText: t('common.cancel'),
        })
        if (!ok) return
        if (noWarn.value && !plan.large) setPasteMultilineNoWarn(true)
      }
      // ③ 写入活跃终端（无终端先开项目默认终端，链内承接）；尾部补 \r 执行
      const outcome = await send(plan.payload + '\r', { createIfMissing: true })
      if (outcome === 'sent') {
        message.success(t('editor.sendToTerminal.sent'))
      } else if (outcome === 'cancelled') {
        // 高危命令确认卡取消：知情放弃是明确结果，与检索落位链同一文案口径
        message.info(t('terminal.cmdPreview.insertCancelled'))
      } else {
        message.warning(t('editor.sendToTerminal.noTerminal'))
      }
    } finally {
      sending.value = false
    }
  }

  return { sendSelectionToTerminal, sending }
}
