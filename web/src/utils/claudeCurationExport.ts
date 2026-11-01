/**
 * 回放策展导出渲染（P-20261003-144）：把「当前过滤命中集 / 书签轮」的时间线
 * 条目渲染为 Markdown 策展文档。全量导出走服务端 P-44 渲染链；策展子集的
 * 过滤/书签都是前端态（P-81 页内过滤、P-122 策展书签），纯前端渲染收口在此，
 * 下载链（blob + exportFileName 命名）复用既有导出约定。
 *
 * 版式镜像 server/claudesessions/export.go renderExportMarkdown（user/assistant
 * 分节、工具摘要行、结果引用块、头部元信息+口径注记），文档语言沿用服务端导出
 * 文档的中文惯例——导出文档是工件非 UI 文案，不入 locale（提案 i18n 范围 =
 * 下拉项）；两族导出文档语言一致是刻意取舍，勿按「用户可见文本」改 t()。
 *
 * 与服务端渲染的一处刻意分叉：分节除「kind 变化」外「时刻变化」也开新节——
 * 策展集是稀疏散点（书签轮之间隔着未导出的轮次），沿用服务端「同 kind 连排
 * 同节」会让每轮时刻（书签的定位键、命中轮的回跳锚点）在文档里丢失；同一
 * 时刻拆出的 tool_use+text（同一条 assistant 消息）仍合在一节。数据面 = 已
 * 加载时间线条目（服务端逐条已截断、分页窗口有界），无需再设输出体积护栏。
 */
import type { ClaudeTimelineEntry } from '../api/domains/claude'

export type CurationExportScope = 'hits' | 'bookmarks'

export interface CurationExportInput {
  /** 会话标题（文档头；与下载名摘要同源） */
  title: string
  sessionId: string
  now: Date
  /** 待渲染条目（已按导出范围过滤，时间正序） */
  entries: ClaudeTimelineEntry[]
  /** 会话总步数（头部元信息注记导出占比） */
  total: number
  scope: CurationExportScope
  /** scope=hits：当前查询词（口径注记引用原文） */
  query?: string
  /** scope=hits：正则匹配开关（口径注记注明匹配语义） */
  regex?: boolean
  /** scope=bookmarks：指向未加载段（截断窗外）的书签数，>0 时如实注记 */
  missingBookmarks?: number
}

/** 文档头：标题 + 元信息 + 口径注记（策展导出的诚实边界：只含什么、不含什么） */
function renderHeader(o: CurationExportInput): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const d = o.now
  const lines = [
    `# Claude 会话：${o.title}（策展导出）`,
    '',
    `- 会话 ID：\`${o.sessionId}\``,
    `- 导出条目：${o.entries.length}（会话共 ${o.total} 步）`,
    `- 导出时间：${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    '',
  ]
  if (o.scope === 'hits') {
    const mode = o.regex ? '正则匹配' : '字面匹配'
    lines.push(`> 注：本文档仅包含回放搜索「${o.query ?? ''}」的命中轮次（${mode}）；未命中的轮次与未加载的更早轮次不在其中，全量内容请使用「导出 → Markdown」。`)
  } else {
    const missing = o.missingBookmarks && o.missingBookmarks > 0
      ? `另有 ${o.missingBookmarks} 个书签指向未加载的更早轮次，未包含。`
      : ''
    lines.push(`> 注：本文档仅包含书签标记的轮次；未标记的轮次不在其中，全量内容请使用「导出 → Markdown」。${missing}`)
  }
  lines.push('', '---', '', '')
  return lines.join('\n')
}

/** 「 · MM-DD HH:mm」节头时刻后缀（服务端 exportTimeSuffix 同式，本地时区） */
function sectionTimeSuffix(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return ` · ${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 多行文本 → 引用块（逐行 ">" 前缀；空行也补前缀保持块连续，服务端 mdQuote 同式） */
function mdQuote(text: string): string {
  return text.replace(/\r\n/g, '\n').split('\n').map(l => `> ${l}`).join('\n')
}

/** 行内代码包裹：换行折叠为空格；内容含反引号时按 CommonMark 惯例加长围栏
 *（服务端 mdInlineCode 同式） */
function mdInlineCode(s: string): string {
  const folded = s.replace(/\r\n/g, '\n').split(/\s+/).filter(Boolean).join(' ')
  let longest = 1
  let run = 0
  for (const ch of folded) {
    if (ch === '`') {
      run++
      if (run >= longest) longest = run + 1
    } else {
      run = 0
    }
  }
  const fence = '`'.repeat(longest)
  return fence + folded + fence
}

/** 工具名进 **强调** 段前的防御性清洗：* 与换行破坏强调语法，折叠之
 *（服务端 mdEscapeCell 同式；工具名来自 transcript 外部产物无兼容承诺） */
function mdEscapeCell(name: string): string {
  return name.replace(/\r\n/g, '\n').split(/\s+/).filter(Boolean).join(' ').replace(/\*/g, '＊')
}

/**
 * 策展导出渲染主入口：头部（元信息+口径注记）+ 条目正文。条目渲染逐字对齐
 * 服务端 renderExportMarkdown 的单条口径（user/assistant 正文段、tool 摘要行、
 * result 引用块）；分节规则见文件头注记的分叉说明。
 */
export function renderCurationMarkdown(o: CurationExportInput): string {
  const parts: string[] = [renderHeader(o)]
  let prevKind = ''
  let prevAt = ''
  for (const e of o.entries) {
    // 分节：kind 变化或时刻变化都开新节（稀疏集的轮次时刻锚点保留）
    if (e.kind !== prevKind || (e.at !== '' && e.at !== prevAt)) {
      if (e.kind === 'user') parts.push(`## 👤 用户${sectionTimeSuffix(e.at)}\n`)
      else if (e.kind === 'assistant') parts.push(`## 🤖 助手${sectionTimeSuffix(e.at)}\n`)
      prevKind = e.kind
      prevAt = e.at
    }
    switch (e.kind) {
      case 'user':
      case 'assistant':
        parts.push(`${e.text}\n\n`)
        break
      case 'tool':
        parts.push(`- 🔧 **${mdEscapeCell(e.tool ?? '')}**${e.input ? `：${mdInlineCode(e.input)}` : ''}\n`)
        break
      case 'result':
        parts.push(mdQuote(e.status === 'error' ? `⚠️ 失败：${e.text}` : `↳ ${e.text}`) + '\n')
        break
    }
  }
  return parts.join('')
}
