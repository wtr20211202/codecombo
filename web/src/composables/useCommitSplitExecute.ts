import { computed, h, reactive, ref } from 'vue'
import type { VNodeChild } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import { useAssistantTaskStore } from '../stores/assistantTask'
import { useI18n } from './useI18n'
import { confirmDialog } from './useDialog'
import { commitApi, terminalApi } from '../api/client'
import type { CommitSplitGroupPayload, CommitSplitReport } from '../api/domains/git'
import { lastSplitSuggestSessionId } from './useCommitSplitSuggest'

/**
 * 拆分建议「逐组执行」（P-20261003-278）：P-186 纯建议输出的执行面——变更面板
 * 提交操作区在「拆分建议」发起过会话后出现入口，点击时读该会话 scrollback
 * （GET /terminals/:id/scrollback，服务端 tmux capture-pane / native 环形缓冲，
 * 不依赖 pane 挂载）解析结构化分组方案（```json 代码块，groups[].name/files/
 * subject），确认弹层逐组预览后整包下发 POST /projects/:id/commit-split-execute
 * ——服务端逐组 stage+commit 循环（写队列域）返回逐组报告，前端渲染失败中断
 * 报告。自动执行的确认门槛 = 预览弹层人工确认（非全自动注记）。
 *
 * - 解析面是容错的：ANSI 剥离（服务端 scrollback 是原始捕获字节）→ 以
 *   "groups" 锚点从后往前回扫候选 JSON（锚点+括号配平，围栏与否/围栏残缺均
 *   容忍）→ 每候选直读失败再试「逐行 trim 后拼接」修复形——TUI 在终端宽度处
 *   硬折行/缩进会把换行插进字符串字面量，合法 JSON 语法里换行只出现在 token
 *   间（可去）或字符串内（折行伪影，拼接即愈合）；prompt 回显自带的格式示例
 *   候选经占位文件（["…"]）剔除必然失败，不误报；两形都败 = 未找到方案，如
 *   实提示不猜测（1.5s 延迟重取一次，容忍 agent 刚收尾的回显落定窗口）
 * - 组隔离语义（服务端 pathspec 提交保证）：分组外已暂存文件不卷入任何组、
 *   保持暂存态——预览弹层对该情形作信息性标注（非阻断）；分组内文件不在当前
 *   变更列表时标注（可能已被提交/还原，git add 自行报错兜底）
 * - 会话锚点是模块内存态（lastSplitSuggestSessionId，随「拆分建议」发起记录）：
 *   刷新即失、入口随之隐藏（再点一次拆分建议即恢复），无落盘面零迁移
 * - agent 仍在产出时的弱信号：assistantTask.bySession[sessionId].status ===
 *   'running'（ops-notify task.progress 链，尽力而为）→ 提示稍后再试而非
 *   「未找到」——两者文案分开，避免把「还在写」误报成「没产出」
 */

/** 解析出的单个分组（name 缺省退化用 subject，展示面不再判空） */
export interface SplitSuggestionGroup {
  name: string
  files: string[]
  subject: string
}

// ANSI 转义序列（CSI + OSC，含 tmux/ConPTY 常见的私有参数形态）；OSC 以 BEL
// 或 ST（ESC \）收尾
// eslint-disable-next-line no-control-regex -- ESC/BEL 是终端线上字段的字面组成部分，匹配控制字符正是本正则的职责
const ANSI_SEQ_RE = /\x1b\[[0-9:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** scrollback 原始字节（或已解码文本）→ 纯文本：JSON 提取面前先剥 ANSI */
export function stripAnsiText(data: ArrayBuffer | string): string {
  const raw = typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data))
  return raw.replace(ANSI_SEQ_RE, '')
}

/** 从 anchor 处向后回溯最近的 '{'，再字符串感知地正向配平括号，返回 {...} 片段。
 *  无配平（截断/未完结输出）返回 null */
function extractJsonSpan(text: string, anchor: number): string | null {
  const start = text.lastIndexOf('{', anchor)
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 解析拆分建议（纯函数）：以 "groups" 锚点从后往前回扫候选 JSON（会话里方案
 *  可能被重复打印/注入面重发，末份可能被缓冲截断——最新完整份优先，截断份
 *  解析失败自然回退前一份）；围栏与否不敏感（锚点+括号配平天然覆盖两种形态，
 *  围栏残缺也容忍）。每候选先直读，失败再试折行修复形（逐行 trim 后无分隔
 *  拼接——合法 JSON 换行只在 token 间可去、字符串内换行是 TUI 折行伪影，
 *  拼接即愈合）；prompt 回显里的格式示例候选经占位文件剔除必然失败，不误报 */
export function parseSplitSuggestion(text: string): SplitSuggestionGroup[] | null {
  const anchors: number[] = []
  const re = /"groups"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) anchors.push(m.index)
  const seen = new Set<string>()
  for (let i = anchors.length - 1; i >= 0; i--) {
    const span = extractJsonSpan(text, anchors[i]!)
    if (!span || seen.has(span)) continue
    seen.add(span)
    for (const attempt of [span, span.split(/\r?\n/).map(l => l.trim()).join('')]) {
      try {
        const groups = normalizeGroups(JSON.parse(attempt))
        if (groups) return groups
      } catch { /* 下一修复形/下一锚点 */ }
    }
  }
  return null
}

/** 格式示例占位文件（promptFormat 的 ["…"]）：建议会话的 scrollback 里 prompt
 *  自身的回显也含这份示例（JSON 示例随指令进终端），锚点回扫会撞上——'…'
 *  永远不是真实 git 路径，落盘面前剔除，使 prompt 回显候选必然规整失败 */
const PLACEHOLDER_FILES = new Set(['…', '...'])

/** groups 数组规整校验：文件逐项 trim 去空去重剔占位；files 剔后为空或
 *  subject/name 全空的组丢弃；name 缺省退化用 subject。一个可用组都不剩视为
 *  解析失败 */
function normalizeGroups(raw: unknown): SplitSuggestionGroup[] | null {
  if (!raw || typeof raw !== 'object') return null
  const arr = (raw as { groups?: unknown }).groups
  if (!Array.isArray(arr)) return null
  const out: SplitSuggestionGroup[] = []
  for (const g of arr) {
    if (!g || typeof g !== 'object') continue
    const rec = g as Record<string, unknown>
    const name = typeof rec.name === 'string' ? rec.name.trim() : ''
    const subject = typeof rec.subject === 'string' ? rec.subject.trim() : ''
    const files = Array.isArray(rec.files)
      ? [...new Set(rec.files.filter((f): f is string => typeof f === 'string' && f.trim() !== '').map(f => f.trim()))]
        .filter(f => !PLACEHOLDER_FILES.has(f))
      : []
    if (files.length === 0) continue
    const s = subject || name
    if (!s) continue
    out.push({ name: name || s, files, subject: s })
  }
  return out.length > 0 ? out : null
}

/** 预览清单展示上限（超出折叠计数注记，confirmDialog 内容面惯例） */
const PREVIEW_LIST_MAX = 40

export function useCommitSplitExecute() {
  const projectStore = useProjectStore()
  const changesStore = useChangesStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useCommitSplitSuggest 同范式）：组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })
  const preparing = ref(false) // 解析建议中（fetch scrollback + parse）
  const executing = ref(false) // 逐组执行中（服务端循环往返）
  // 入口可见性：本应用会话内创建过拆分建议会话（模块级锚点，随发起记录）
  const hasSuggestion = computed(() => lastSplitSuggestSessionId.value !== '')

  /** 会话 scrollback → 纯文本（会话不存在/读取失败返回 null，调用方就地反馈）。
   *  服务端直出裸字节（application/octet-stream），axios 拦截器返回 body 本身
   *  即 ArrayBuffer（TerminalBroadcastResultPanel 同款取法） */
  async function fetchSessionText(sessionId: string): Promise<string | null> {
    try {
      const buf = await terminalApi.scrollback(sessionId, { silent: true }) as unknown as ArrayBuffer
      if (!buf) return null
      return stripAnsiText(buf)
    } catch { return null }
  }

  /** 确认弹层：逐组预览 + 组外暂存信息注记 + 组内缺失文件警示。返回是否确认执行 */
  async function showPreview(groups: SplitSuggestionGroup[]): Promise<boolean> {
    const grouped = new Set(groups.flatMap(g => g.files))
    const foreignStaged = changesStore.files.filter(f => f.staged && !grouped.has(f.path)).map(f => f.path)
    const known = new Set(changesStore.files.map(f => f.path))
    const missing = [...new Set(groups.flatMap(g => g.files).filter(f => !known.has(f)))]
    const list = (items: string[]): VNodeChild => {
      const shown = items.slice(0, PREVIEW_LIST_MAX)
      return h('ul', { style: 'margin:2px 0 0;padding-left:18px;word-break:break-all' }, [
        ...shown.map(f => h('li', f)),
        items.length > shown.length ? h('li', { style: 'color:var(--text-secondary)' }, t('commit.splitExec.more', { n: items.length - shown.length })) : null,
      ])
    }
    const warn = (label: string, items: string[]): VNodeChild =>
      h('p', { style: 'margin:6px 0 0;color:var(--accent-orange)' }, [`${label}（${items.length}）：`, list(items)])
    // 组外已暂存是信息性注记（pathspec 提交不会卷入、保持暂存态），非警示
    const note = (label: string, items: string[]): VNodeChild =>
      h('p', { style: 'margin:6px 0 0;color:var(--text-secondary)' }, [`${label}（${items.length}）：`, list(items)])
    return confirmDialog({
      type: 'warning',
      title: t('commit.splitExec.dialogTitle'),
      content: (): VNodeChild => h('div', null, [
        h('p', { style: 'margin:0 0 6px' }, t('commit.splitExec.dialogIntro', { n: groups.length })),
        h('ol', { style: 'margin:0;padding-left:18px;max-height:260px;overflow:auto' }, groups.map(g => h('li', { style: 'margin:0 0 4px' }, [
          h('div', null, [
            h('strong', null, g.name),
            h('span', { style: 'color:var(--text-secondary)' }, ` — ${g.subject}`),
          ]),
          h('div', { style: 'font-size:12px;color:var(--text-secondary);word-break:break-all' }, g.files.join('、')),
        ]))),
        foreignStaged.length > 0 ? note(t('commit.splitExec.noteForeignStaged'), foreignStaged) : null,
        missing.length > 0 ? warn(t('commit.splitExec.warnMissingFiles'), missing) : null,
      ]),
      confirmText: t('commit.splitExec.confirm'),
    })
  }

  /** 逐组执行：整包下发服务端循环，按报告形态分流反馈（全成 / 中断） */
  async function executeGroups(pid: string, groups: SplitSuggestionGroup[]): Promise<void> {
    executing.value = true
    try {
      const payload: CommitSplitGroupPayload[] = groups.map(g => ({ name: g.name, files: g.files, subject: g.subject }))
      let report: CommitSplitReport | undefined
      try {
        const res = await commitApi.executeSplit(pid, payload) as unknown as { data?: CommitSplitReport }
        report = res?.data
      } catch { /* 拦截器处理（请求级 400/网络错误的通用 toast） */ }
      if (!report) return
      // 执行面已动过 git：立即重拉变更列表（3s TTL 缓存已由服务端就地失效；
      // 尽力而为，WS 三路刷新仍兜底）
      void changesStore.fetchStatus(pid).catch(() => {})
      if (report.failed) {
        // 失败中断报告（提案③）：已落库组 / 失败组与步骤、原因 / 未执行剩余数。
        // confirm 面板承载（内容多行，toast 装不下）；已执行的组不回滚——报告即事实。
        // failed 局部化：内容渲染闭包里的可选链收窄会被 TS 丢弃（闭包内不再收敛）
        const failed = report.failed
        const executed = report.executed
        await confirmDialog({
          type: 'error',
          title: t('commit.splitExec.reportTitle'),
          content: (): VNodeChild => h('div', null, [
            executed.length > 0
              ? h('p', { style: 'margin:0 0 4px' }, t('commit.splitExec.executedHead', { n: executed.length }))
              : null,
            h('ul', { style: 'margin:0;padding-left:18px' }, executed.map(e =>
              h('li', { style: 'word-break:break-all' }, `✓ ${e.subject}${e.commit ? ` (${e.commit})` : ''}`))),
            h('p', { style: 'margin:8px 0 0;color:var(--accent-orange)' }, t('commit.splitExec.failedHead', {
              name: failed.name || failed.subject,
              step: t(`commit.splitExec.step.${failed.step}`),
            })),
            h('p', { style: 'margin:4px 0 0;font-size:12px;word-break:break-all;color:var(--text-secondary)' }, failed.error),
            report.remaining > 0 ? h('p', { style: 'margin:6px 0 0' }, t('commit.splitExec.remaining', { n: report.remaining })) : null,
          ]),
          confirmText: t('common.confirm'),
        })
        return
      }
      message.success(t('commit.splitExec.done', { n: report.executed.length }))
    } finally {
      executing.value = false
    }
  }

  /** 解析延迟重取宽限：agent 刚收尾/用户过早点击时，终端回显可能仍在分帧落定
   *  （末份输出未完整进缓冲）——一次 1.5s 后重读重解析再判失败，消掉「点击过早」
   *  整类误报；两轮都无完整方案才走失败提示 */
  const PARSE_RETRY_DELAY_MS = 1500

  /** 入口动作：读会话 → 解析 → 预览确认 → 执行。未找到方案时按「仍在产出」
   *  与「无结构化方案」分文案（progress 弱信号尽力而为，不阻断重试） */
  async function executeSplitSuggestion(): Promise<void> {
    if (preparing.value || executing.value || !hasSuggestion.value) return
    const pid = projectStore.currentProjectId
    if (!pid) return
    preparing.value = true
    try {
      const sessionId = lastSplitSuggestSessionId.value
      const text = await fetchSessionText(sessionId)
      if (text === null) {
        message.error(t('commit.splitExec.fetchFailed'))
        return
      }
      let groups = parseSplitSuggestion(text)
      if (!groups) {
        // 延迟重取：末轮回显可能仍在落定，重读重解析一次再判失败
        await new Promise(resolve => setTimeout(resolve, PARSE_RETRY_DELAY_MS))
        const retry = await fetchSessionText(sessionId)
        if (retry !== null) groups = parseSplitSuggestion(retry)
      }
      if (!groups) {
        const status = useAssistantTaskStore().bySession[sessionId]?.status
        if (status === 'running') message.info(t('commit.splitExec.running'))
        else message.warning(t('commit.splitExec.noSuggestion'))
        return
      }
      if (!await showPreview(groups)) return
      await executeGroups(pid, groups)
    } finally {
      preparing.value = false
    }
  }

  return reactive({ executeSplitSuggestion, preparing, executing, hasSuggestion })
}

export type SplitExecuteState = ReturnType<typeof useCommitSplitExecute>
