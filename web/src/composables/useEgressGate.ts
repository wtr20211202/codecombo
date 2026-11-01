/**
 * 出域敏感闸前端链路（P-20261004-113）：服务端第一跳回 JSON warnings 时弹
 * 确认层（命中类型 + 计数，绝不展示原文），确认后带 confirm=1 重试；终端
 * 导出与会话敏感标记闸并存时同时带 override=1（一次确认覆盖两条闸）。
 *
 * 四条出域链共用：会话回放导出 md/jsonl（SessionTimeline）、终端输出导出
 * （TerminalView）、终端输出对比取数（TerminalCompareOutputModal）、会话
 * 批量导出 zip（ClaudeSessionPicker，P-20261003-225——批量此前完全绕过单导
 * 同款闸，属安全缺口）。循环
 * 收口在 fetchWithEgressGate——「JSON 响应绝不落盘/当内容」的健壮性边界
 * 只有一处实现（半真文件比失败更糟）；唯一例外是显式声明的合法 JSON 载荷
 * （批量导出 P-29 口令信封，allowJsonPayload）。
 */
import { h } from 'vue'
import type { VNodeChild } from 'vue'
import i18n from '../i18n'
import { confirmDialog } from './useDialog'
import {
  hitTypeI18nKey,
  parseEgressWarnings,
  type EgressGateInfo,
} from '../utils/egressGate'

/** 命中类型本地化文案（未知类型回退服务端稳定 token——向前兼容） */
function hitLabel(type: string): string {
  const key = hitTypeI18nKey(type)
  return key ? i18n.global.t(`terminal.sensitiveHitType.${key}`) : type
}

/** blob 是否为出域闸第一跳警示（JSON + warnings）；非闸门形态返回 null */
export async function parseEgressBlob(blob: Blob): Promise<EgressGateInfo | null> {
  if (!blob.type.includes('application/json')) return null
  try {
    return parseEgressWarnings(JSON.parse(await blob.text()))
  } catch {
    return null // 非 JSON 形体/畸形响应：按未知形态处理，绝不继续当附件
  }
}

/** 出域确认弹层：会话标记 + 内容命中合并展示，确认返回 true */
export function confirmEgress(info: EgressGateInfo, sessionName = ''): Promise<boolean> {
  const t = i18n.global.t
  const title = info.session
    ? t('terminal.sensitiveEgressTitle')
    : t('terminal.sensitiveContentEgressTitle')
  const content = (): VNodeChild => {
    const parts: VNodeChild[] = []
    if (info.session) {
      parts.push(h('p', { style: 'margin:0 0 6px' },
        t('terminal.sensitiveEgressIntro', { name: sessionName })))
    }
    if (info.hits.length > 0) {
      parts.push(h('p', { style: 'margin:0 0 6px' }, t('terminal.sensitiveContentEgressIntro')))
      parts.push(h('ul', {
        style: 'margin:0;padding-left:18px;max-height:180px;overflow:auto;word-break:break-all',
      }, info.hits.map(hit => h('li', `${hitLabel(hit.type)} × ${hit.count}`))))
      parts.push(h('p', { style: 'margin:6px 0 0;color:var(--text-secondary)' },
        t('terminal.sensitiveContentEgressNote')))
    }
    if (!info.session && info.hits.length === 0) {
      // 未知/未来闸门 token：通用文案（宁可多确认一次，不静默放行）
      parts.push(h('p', { style: 'margin:0' }, t('terminal.sensitiveContentEgressIntro')))
    }
    return h('div', null, parts)
  }
  return confirmDialog({
    type: 'warning',
    title,
    content,
    confirmText: t('terminal.sensitiveEgressConfirm'),
  })
}

/**
 * 带回环的出域取数：load(confirmed) 由调用方拼确认参数。返回 null =
 * 用户取消 / 已确认仍被拦 / 非闸门 JSON（三种都不得继续当附件或内容）。
 *
 * options.allowJsonPayload：响应里存在「合法的 JSON 载荷」形态时开启（现状
 * 唯一形态 = 批量导出的 P-29 口令信封，P-20261003-225）——非闸门 JSON 直通
 * 返回 blob 而非 null。默认关闭：JSON 响应绝不落盘/当内容的健壮性边界仍是
 * 既有三条链的默认语义，直通只对显式声明的信封档生效。
 */
export interface EgressGateLoopOptions {
  allowJsonPayload?: boolean
}

export async function fetchWithEgressGate(
  load: (confirmed: boolean) => Promise<Blob>,
  sessionName = '',
  options: EgressGateLoopOptions = {},
): Promise<Blob | null> {
  let confirmed = false
  for (;;) {
    const blob = await load(confirmed)
    if (!blob.type.includes('application/json')) return blob
    const gate = await parseEgressBlob(blob)
    if (!gate) return options.allowJsonPayload ? blob : null
    if (confirmed) return null
    if (!(await confirmEgress(gate, sessionName))) return null
    confirmed = true
  }
}
