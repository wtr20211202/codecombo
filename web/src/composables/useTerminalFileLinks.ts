import type { Terminal, IBufferRange, ILink } from '@xterm/xterm'
import { projectApi } from '../api/client'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../utils/opsEvents'
import { isAbsolutePath, matchPathCandidates } from '../utils/pathScan'
import { useProjectStore } from '../stores/project'
import { sessionWorkingDir, useTerminalSessionsStore } from '../stores/terminal-sessions'

// 终端输出文件路径链接层（对标 VS Code / JetBrains / Warp 终端：路径即入口）。
// 经 term.registerLinkProvider 注册自定义链接（与 WebLinksAddon 共存，http/https
// 链接仍由 addon 处理——本层的匹配正则对协议地址不命中，见 utils/pathScan
// 的 PATH_RE 守卫）：
// - 匹配绝对路径（Windows 盘符 + POSIX）与 ./相对、../相对、src/x.go 纯相对形态，
//   可带 :LINE[:COL] 后缀（编译/测试报错的 file.go:123 主场景）
// - 相对路径按会话当前目录解析（OSC 7 实时追踪 currentDir，无帧回落创建
//   dir——sessionWorkingDir 统一收口，旧 shell 零回归，P-20261004-59）；
//   解析后必须落在会话归属的注册项目根内，且经 file-policy（服务端防穿越）
//   确认文件存在才渲染可点样式——不存在的路径/目录一律保持死文本
// - Ctrl/Meta+单击派发 window 事件 OPS_OPEN_FILE_AT，由 Layout（useLayoutViews）
//   桥接到 useOpenFiles.openFileByPath() 打开文件并按行号滚动定位；裸单击不激活
//   （终端单击既有语义是聚焦/光标定位，一行报错多路径时不误触连开页签，
//   对标 VS Code / JetBrains 终端的 Ctrl+单击）
// 会话目录不属于任何已注册项目时不启用（agent 终端任意 cwd / 远程终端会话均
// 天然落空），保持范围收敛。

// 路径文本扫描核（正则/提取）收口 utils/pathScan.ts 共享模块：通知正文路径
// 链接化（P-20261004-61）复用同一匹配器——两场景文本形态同源（工具链输出的
// 报错栈），正则守卫只养一份；本文件保留 cwd 解析/项目相对化/存在性探测等
// 会话上下文相关层。

/** 相对路径按会话目录折叠为绝对路径（. / .. 逐段折叠；分隔符风格随 cwd）。
 *  cwd 恒为绝对路径（服务端创建会话时写入）；POSIX 根与盘符段不可被 .. 弹出 */
export function resolveAgainstCwd(cwd: string, rel: string): string {
  const winStyle = /^[A-Za-z]:/.test(cwd) || cwd.includes('\\')
  const sep = winStyle ? '\\' : '/'
  const isDrive = (s: string) => /^[A-Za-z]:$/.test(s)
  const segs: string[] = []
  if (cwd.startsWith('/')) segs.push('') // POSIX 根哨兵：join 时产出开头 /
  for (const part of cwd.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    segs.push(part)
  }
  for (const part of rel.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      const top = segs[segs.length - 1]
      if (top !== undefined && top !== '' && !isDrive(top)) segs.pop()
      continue
    }
    segs.push(part)
  }
  return segs.join(sep) || sep
}

const WIN_PATH_RE = /^[A-Za-z]:|[\\]/

/** 路径比较用折叠：Windows 形态大小写不敏感，POSIX 敏感 */
function foldPath(p: string): string {
  return WIN_PATH_RE.test(p) ? p.toLowerCase() : p
}

/** 归一化分隔符为正斜杠（编辑器路径约定），不改变大小写 */
function toSlash(p: string): string {
  return p.replace(/[\\/]+/g, '/')
}

/** child 是否与 root 相同或位于 root 之下（Windows 形态大小写不敏感） */
export function isPathUnderPath(child: string, root: string): boolean {
  const a = foldPath(toSlash(child)).replace(/\/+$/, '')
  const b = foldPath(toSlash(root)).replace(/\/+$/, '')
  return a === b || a.startsWith(b + '/')
}

/** 绝对路径 → 项目相对路径（正斜杠）。不在 root 之下返回 null；
 *  恰为 root 本身返回空串（目录，调用方按不存在处理） */
export function toProjectRelative(absPath: string, root: string): string | null {
  const a = toSlash(absPath)
  const r = toSlash(root).replace(/\/+$/, '')
  const aFold = foldPath(a)
  const rFold = foldPath(r)
  if (aFold === rFold) return ''
  if (!aFold.startsWith(rFold + '/')) return null
  return a.slice(r.length + 1)
}

// ── 存在性探测（模块级缓存）─────────────────────────────────────────────
// file-policy = 一次服务端 stat 且带防穿越（SafeJoinProject：越界 403、缺失 404、
// 目录 400），命中即「存在且为文件」。以 Promise 为缓存值合并同路径并发探测。
// 负缓存边界：hover 时不存在、随后创建的文件要等缓存清空才可点——上限触发整表
// 清空自然翻新；对「报错路径点击」主场景无影响（报错文件必然已存在）
const existsCache = new Map<string, Promise<boolean>>()
const EXISTS_CACHE_MAX = 1000

function probeFileExists(projectId: string, relPath: string): Promise<boolean> {
  const key = projectId + '\n' + relPath
  let p = existsCache.get(key)
  if (!p) {
    p = projectApi
      .filePolicy(projectId, relPath, { silent: true })
      .then(() => true)
      .catch(() => false)
    if (existsCache.size >= EXISTS_CACHE_MAX) existsCache.clear()
    existsCache.set(key, p)
  }
  return p
}

/** 会话链接上下文：cwd + 归属项目。不属于任何已注册项目（valid）时为 null → 不启用 */
interface TerminalLinkContext {
  cwd: string
  projectId: string
  projectRoot: string
}

function resolveSessionContext(sessionId: string): TerminalLinkContext | null {
  // 会话 cwd 以服务端快照（useTerminalSessionsStore）为事实源；provideLinks
  // 惰性调用。store 无应用启动级填充（仅 terminals.changed 广播 / agent 面板
  // 触发）——恢复型 tab（uiState 还原）在页面刷新后首次 hover 会落空，这里
  // 对「未加载过」做一次性自愈拉取，本次返回空、之后的 hover 即可解析
  const sessionsStore = useTerminalSessionsStore()
  if (!sessionsStore.loaded) {
    if (!contextRefreshInFlight) {
      contextRefreshInFlight = sessionsStore.refresh().finally(() => { contextRefreshInFlight = null })
    }
    return null
  }
  const session = sessionsStore.sessions.find(s => s.id === sessionId)
  if (!session?.path) return null
  // 项目归属按创建 dir（path）稳定判——agent cd 进其他目录不改变会话的注册
  // 项目，相对路径的解析 cwd 才是实时值（sessionWorkingDir 回落语义收口）
  const project = useProjectStore().projects.find(p => p.valid !== false && isPathUnderPath(session.path, p.path))
  if (!project) return null
  return { cwd: sessionWorkingDir(session), projectId: project.id, projectRoot: project.path }
}

// 惰性自愈拉取的去重句柄（并发 hover 只发一次列表请求）
let contextRefreshInFlight: Promise<boolean> | null = null

/** 在缓冲行内把「字符索引区间」换算为「缓冲单元格区间」：前缀可能含宽字符
 *  （中文输出），字符索引 ≠ 单元格索引，逐格累计 chars 长度定位起点，再按
 *  格宽累计链接长度。换算失败返回 null（该候选放弃，不影响其余候选） */
function cellRangeFor(
  term: Terminal,
  bufferLineNumber: number,
  startCharIdx: number,
  length: number,
): IBufferRange | null {
  const line = term.buffer.active.getLine(bufferLineNumber)
  if (!line) return null
  let charIdx = 0
  let startCell = -1
  for (let x = 0; x < term.cols; x++) {
    if (charIdx >= startCharIdx) {
      startCell = x
      break
    }
    const cell = line.getCell(x)
    if (!cell) break
    charIdx += cell.getChars().length
  }
  if (startCell < 0) return null
  let width = 0
  let consumed = 0
  for (let x = startCell; x < term.cols && consumed < length; x++) {
    const cell = line.getCell(x)
    if (!cell) break
    width += cell.getWidth()
    consumed += cell.getChars().length
  }
  if (consumed < length) width = length // 兜底：格宽信息异常时按 ASCII 宽度
  return {
    start: { x: startCell + 1, y: bufferLineNumber },
    end: { x: startCell + width, y: bufferLineNumber },
  }
}

/** 注册终端文件路径链接层（每个 xterm 实例一次，随 term.dispose 释放）。
 *  返回 IDisposable（xterm 早版本无此 API 时返回 null，调用方忽略即可） */
export function registerTerminalFileLinks(term: Terminal, sessionId: string): { dispose(): void } | null {
  if (typeof term.registerLinkProvider !== 'function') return null
  return term.registerLinkProvider({
    provideLinks: (bufferLineNumber, callback) => {
      provideFileLinks(term, sessionId, bufferLineNumber)
        .then(links => callback(links.length > 0 ? links : undefined))
        .catch(() => callback(undefined))
    },
  })
}

async function provideFileLinks(
  term: Terminal,
  sessionId: string,
  bufferLineNumber: number,
): Promise<ILink[]> {
  const ctx = resolveSessionContext(sessionId)
  if (!ctx) return []
  const line = term.buffer.active.getLine(bufferLineNumber)
  if (!line) return []
  const text = line.translateToString(true)
  if (!text) return []
  const matches = matchPathCandidates(text)
  if (matches.length === 0) return []

  const settled = await Promise.all(matches.map(async (m): Promise<ILink | null> => {
    // 相对形态按会话目录折叠；绝对形态原样。统一再折算项目相对路径——
    // 落在项目外（agent 终端指向其他目录等）即不渲染，范围收敛
    const abs = isAbsolutePath(m.core) ? toSlash(m.core) : resolveAgainstCwd(ctx.cwd, m.core)
    const rel = toProjectRelative(abs, ctx.projectRoot)
    if (rel === null || rel === '') return null
    if (!await probeFileExists(ctx.projectId, rel)) return null
    const range = cellRangeFor(term, bufferLineNumber, m.start, m.text.length)
    if (!range) return null
    const detail: OpenFileAtDetail = { path: rel, projectId: ctx.projectId, line: m.line, col: m.col }
    return {
      range,
      text: m.text,
      // xterm ILink.activate 自带触发鼠标事件：Ctrl（mac Cmd/Meta）按住才派发，
      // 裸单击落回终端既有语义（聚焦/光标定位），路径文本不劫持
      activate: (event) => {
        if (!event.ctrlKey && !event.metaKey) return
        window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, { detail }))
      },
    }
  }))
  return settled.filter((x): x is ILink => x !== null)
}
