import type { TerminalCommandPreviewResult, TerminalRiskMatch } from '../api/domains/terminal'

/**
 * 高危命令影响面预检（P-20261005-191）前端半件：粘贴块候选提取 + 低成本
 * 预筛（「什么时候值得问服务端要预览」的触发阀）+ 会话白名单 + 影响面摘要
 * 文案描述符。判定的唯一事实源是服务端模式表（server/terminal/commandrisk.go
 * + /api/terminals/command-preview 动态计数）；本文件的预筛只决定「要不要发起
 * 预览」——漏报只是少一次预检（粘贴照常直达，与历史行为一致），误报由服务端
 * 判空纠正，两侧清单允许分歧（键入逐字符经 onData 不会整段命中预筛，天然
 * 不拦手敲）。
 */

export type { TerminalCommandPreviewResult, TerminalRiskMatch }

// bracketed paste 包裹标记：现代 shell（bash 5.1+/zsh/PSReadLine）开 2004 模式，
// xterm term.paste 对粘贴内容加 \x1b[200~ … \x1b[201~ 包裹整段下发——这是
// onData 上「粘贴 vs 键入」最可靠的形态判据；未开包裹模式的粘贴以整块多字
// 符下发（键入是逐字符），由预筛兜住
const BRACKET_ON = '\x1b[200~'
const BRACKET_OFF = '\x1b[201~'

/** 候选最小长度：单字符键入/控制字符不构成命令串 */
const MIN_CANDIDATE_LEN = 2

/**
 * 从 onData 原始 chunk 提取粘贴候选文本。null = 非粘贴形态（纯控制序列/
 * 单字符键入），调用方直接放行零开销。
 * bracketed 包裹段剥壳取内文；未包裹的整块（含 ESC 判定放行箭头键类序列）
 * 原样候选，交给预筛把关。
 */
export function extractPasteCandidate(data: string): string | null {
  let text = data
  if (data.includes(BRACKET_ON)) {
    text = data.split(BRACKET_ON)[1] ?? ''
    const off = text.indexOf(BRACKET_OFF)
    if (off >= 0) text = text.slice(0, off)
  } else if (data.includes('\x1b')) {
    // 未包裹但含 ESC：按键序列（箭头/功能键）不是粘贴
    return null
  }
  // bracketed 包裹把换行归一为 \r：还原为 \n 供模式匹配
  text = text.replace(/\r\n?/g, '\n').trim()
  return text.length >= MIN_CANDIDATE_LEN ? text : null
}

// 预筛（触发阀，宽松从宽——误报代价只是一次预览请求）：
//  rm 短 flag 含 r/f 位 / --recursive；git reset --hard、clean -f、push -f/--force、
//  checkout --/. 、restore 目标；truncate 零值；shred；docker …prune；> 覆盖重定向
const HIGH_RISK_HINT_RE = new RegExp(
  [
    String.raw`\brm\s+-{1,2}[\w-]*[rRf]`,
    String.raw`\bgit\s+(?:-[Cc]\s+\S+\s+)*reset\s+--hard\b`,
    String.raw`\bgit\s+clean\s+-\w*f`,
    String.raw`\bgit\s+push\s+[^\n|;&]*(?:\s-f\b|\s--force)`,
    String.raw`\bgit\s+checkout\s+(?:--|\.)`,
    String.raw`\bgit\s+restore\s+(?:--staged\s+)?(?:--worktree\s+)?[^\s-]`,
    String.raw`\btruncate\s+(?:-s\s+0\b|--size=?0)`,
    String.raw`\bshred\s+\S`,
    String.raw`\bdocker\s+\S+\s+prune\b`,
    String.raw`(?:^|[\s;(])>\s*[^\s|;&>]`,
  ].join('|'),
)

/** 预筛命中：值得发起服务端预览。纯本地正则零 IO，onData 每 chunk 现跑 */
export function looksHighRisk(text: string): boolean {
  return HIGH_RISK_HINT_RE.test(text)
}

// ============== 会话白名单（确认过的同型命令本会话不再拦） ==============
// 页面生命周期内存 Set（刷新即清 = 刻意保守：知情确认不跨会话免检），
// 键 = 模式 id（同型 = 同模式族）：确认过 rm 族一次，本会话后续 rm 族粘贴
// 不再弹卡（用户已表达过对这类操作的知情）
const confirmedRiskIds = new Set<string>()

/** 确认落地：把本次确认覆盖的模式族记入会话白名单 */
export function confirmRiskIds(ids: string[]): void {
  for (const id of ids) confirmedRiskIds.add(id)
}

/** 命中集是否全部已在白名单内（是 → 直接放行不再弹卡） */
export function isRiskWhitelisted(matches: TerminalRiskMatch[]): boolean {
  return matches.length > 0 && matches.every(m => confirmedRiskIds.has(m.id))
}

/** 白名单状态（测试用） */
export function riskWhitelistSize(): number {
  return confirmedRiskIds.size
}

/** 清空白名单（测试/设置页重置用） */
export function resetRiskWhitelist(): void {
  confirmedRiskIds.clear()
}

// ============== 影响面摘要描述符（组件渲染用，纯函数可单测） ==============

export interface ImpactText {
  /** i18n key（terminal.cmdPreview.impact.* 命名空间） */
  key: string
  params?: Record<string, unknown>
  /** dynamic=有计数 / zero=计数全 0（降级灰提示）/ static=静态降级（无计数面） */
  tone: 'dynamic' | 'zero' | 'static'
}

/** 单命中的影响面摘要：动态计数 → 人读描述符。截断标注「+」下界语义 */
export function impactOf(m: TerminalRiskMatch): ImpactText {
  const d = m.dynamic
  if (!d) {
    return { key: 'terminal.cmdPreview.impact.static', tone: 'static' }
  }
  switch (m.kind) {
    case 'git': {
      if ((d.dirty ?? 0) === 0 && (d.untracked ?? 0) === 0) {
        return { key: 'terminal.cmdPreview.impact.gitClean', tone: 'zero' }
      }
      if (m.id === 'git-clean') {
        return {
          key: 'terminal.cmdPreview.impact.untracked',
          params: { n: d.untracked ?? 0 },
          tone: (d.untracked ?? 0) > 0 ? 'dynamic' : 'zero',
        }
      }
      return {
        key: 'terminal.cmdPreview.impact.dirty',
        params: { n: d.dirty ?? 0 },
        tone: (d.dirty ?? 0) > 0 ? 'dynamic' : 'zero',
      }
    }
    case 'overwrite':
      return d.exists
        ? {
            key: 'terminal.cmdPreview.impact.overwriteExists',
            params: { size: d.sizeHuman || `${d.bytes ?? 0} B` },
            tone: 'dynamic',
          }
        : { key: 'terminal.cmdPreview.impact.overwriteNew', tone: 'zero' }
    default: {
      const n = d.files ?? 0
      return {
        key: n > 0 ? 'terminal.cmdPreview.impact.files' : 'terminal.cmdPreview.impact.nothing',
        params: {
          n,
          size: d.sizeHuman || '0 B',
          suffix: d.truncated ? '+' : '',
        },
        tone: n > 0 ? 'dynamic' : 'zero',
      }
    }
  }
}

/** 是否需要弹确认卡：全部命中计数为 0 → 降级灰提示不弹（git reset --hard 在
 *  干净树无害——提案注明的误报治理）；静态降级（无计数面）照弹——信息缺席
 *  恰是弹卡的理由 */
export function previewNeedsConfirm(result: TerminalCommandPreviewResult): boolean {
  if (!result.matches?.length) return false
  return !result.matches.every(m => impactOf(m).tone === 'zero')
}
