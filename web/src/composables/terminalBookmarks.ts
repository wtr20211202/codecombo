import type { IDecoration, IMarker, Terminal } from '@xterm/xterm'
import { ref } from 'vue'
import { termInstances } from './useTerminalInstances'

// 终端 scrollback 书签（P-20261004-16）：右键「标记此行」把任意回滚行钉成书签，
// 书签列表浮层按「行号 + 行文本摘要」列出，点击滚动定位。锚定机制与命令成败
// 装饰（terminalCommandMarks）/命令块锚点（terminalCommandBlocks）同族——
// xterm registerMarker 随 scrollback 重排（resize/折行）自动跟随行号，滚出
// scrollback 上限的行被环形淘汰时 xterm 依 marker 裁剪自动连带 dispose 装饰
// （DecorationService 挂 marker.onDispose），书签随内容消亡即诚实失效——
// 诚实边界：MVP 不做持久化（buffer 是易失视口态，重连重放后行世界已重建）。
// 纯视口层，不写 PTY 字节流，输出/复制/命令历史零污染。

// 单会话书签上限：与装饰（MAX_MARKS_PER_SESSION=50）同哲学——数组轻量，但
// 无上限的 marker 会在 xterm 重排时线性放大代价；50 条覆盖数十屏对照面。
// 超限裁最旧（书签是「暂时回去看一下」的短命态，不是收藏夹）
export const MAX_BOOKMARKS_PER_SESSION = 50

// 列表摘要快照上限（字符）：书签列表显示行文本摘要，超长行（宽表/长路径拼接）
// 截断存快照——内存有界（50 条 × 200 字符），显示层再按 CSS ellipsis 收口
const SUMMARY_MAX = 200

/** 书签列表条目（行号为 marker.line 实时值，随重排/淘汰自动跟随） */
export interface TerminalBookmarkInfo {
  line: number
  text: string
}

interface SessionBookmark {
  marker: IMarker
  // 装饰引用（上限裁剪簿记用）；装饰本体挂 marker 存亡，marker.dispose 即连带消亡
  deco: IDecoration | undefined
  // 标记时刻的行文本快照：行被淘汰后 marker 一起消亡，列表存活期内文本恒在缓冲
  text: string
}

// 会话 → 书签表（push 序即标记序，列表展示按行号排序）。pane 卸载/接管时经
// resetBookmarks 清账，防跨重挂残留指向已消亡的 xterm 实例
const sessionBookmarks = new Map<string, SessionBookmark[]>()

// 书签变更版本号（模块级单调递增）：加/删/环形淘汰失效都会自增。书签列表面板
// watch 它重读列表——不轮询、不把非响应式 Map 接进响应式系统；跨会话共享一个
// 版本号（面板刷新是 O(≤50) 纯内存读，多会话并发变更时的多刷一次可忽略）
export const bookmarkVersion = ref(0)

function bumpVersion(): void {
  bookmarkVersion.value++
}

/**
 * 指针纵坐标 → 缓冲绝对行号（右键「标记此行」的目标行解析）。
 * 几何源 = .xterm-screen 元素：DOM 渲染器下行高 = .xterm-rows 内容高，WebGL
 * 渲染器下 WebglRenderer 直接把 screenElement 撑到 canvas 尺寸——两种渲染器
 * 下 screen 高度都等于 rows × cellHeight，除以 term.rows 即行高（公开 DOM
 * 类名，不触渲染器内部）。clientY 换算屏内行序号 + 视口顶（viewportY）=
 * 缓冲绝对行；越界（pointer 在终端外/预备区）返回 null。
 */
export function bufferLineFromPointer(term: Terminal, clientY: number): number | null {
  // 鸭式探活（不做 instanceof）：xterm 未 open / display:none 环境下元素可能缺失，
  // 任何形态异常一律按「解析失败」处理，调用方降级为无行级动作
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null | undefined
  if (!screen || typeof screen.getBoundingClientRect !== 'function') return null
  const rect = screen.getBoundingClientRect()
  if (rect.height <= 0 || term.rows <= 0) return null
  const cellHeight = rect.height / term.rows
  const row = Math.floor((clientY - rect.top) / cellHeight)
  if (row < 0 || row >= term.rows) return null
  const buf = term.buffer.active
  const line = buf.viewportY + row
  if (line < 0 || line > buf.length - 1) return null
  return line
}

/** 该缓冲行是否已有书签（marker.line 实时比对——重排后书签行号跟随，同线去重） */
export function isLineBookmarked(sessionId: string, line: number): boolean {
  return (sessionBookmarks.get(sessionId) ?? []).some(b => b.marker.line === line)
}

/**
 * 在指定缓冲行加书签（marker + gutter 装饰小旗）。已存在同线书签时幂等返回
 * true（不重复建旗）；实例缺失/行越界/marker 注册失败返回 false（宁缺勿错，
 * 与命令块锚点同口径）。行文本快照在注册前读取——书签列表的摘要即标记时刻
 * 的行内容
 */
export function addBookmarkAtLine(sessionId: string, line: number): boolean {
  const inst = termInstances.get(sessionId)
  if (!inst) return false
  const buf = inst.term.buffer.active
  if (line < 0 || line > buf.length - 1) return false
  if (isLineBookmarked(sessionId, line)) return true
  const text = (buf.getLine(line)?.translateToString(true) ?? '')
    .replace(/[ \t]+$/, '')
    .slice(0, SUMMARY_MAX)
  const marker = inst.term.registerMarker(line - (buf.baseY + buf.cursorY))
  if (!marker || marker.line < 0) return false
  // 小旗装饰：锚定书签行 cell 0 的 1 cell 宽左缘条（P-150 成败装饰同款形态，
  // 换暖黄语义色区分成败绿红）。刻意 anchor 左缘而非行内文本——装饰覆盖的 cell
  // 在 DOM 渲染器下被排除出 span 合并（DomRendererRowFactory !isDecorated 分支），
  // 只孤立 cell 0 首字符、不切割行内完整标记词（P-150 同款约束注记）
  const deco = inst.term.registerDecoration({
    marker,
    anchor: 'left',
    x: 0,
    width: 1,
    height: 1,
    layer: 'bottom',
  })
  if (deco) {
    // 样式必须走 class：装饰元素被渲染器持久复用，行内样式会在重绘被重写
    deco.onRender((el) => el.classList.add('sc-bookmark'))
  }
  const bm: SessionBookmark = { marker, deco, text }
  const list = sessionBookmarks.get(sessionId) ?? []
  // 环形淘汰失效清理：书签行滚出 scrollback 上限时 xterm dispose marker，
  // 就地摘除引用并 bump 版本（列表/计数即时反映）；装饰由 DecorationService
  // 连带 dispose，无需单独处理
  marker.onDispose(() => {
    const l = sessionBookmarks.get(sessionId)
    if (!l) return
    const idx = l.indexOf(bm)
    if (idx >= 0) l.splice(idx, 1)
    bumpVersion()
  })
  list.push(bm)
  while (list.length > MAX_BOOKMARKS_PER_SESSION) {
    const oldest = list.shift()
    if (oldest) {
      // dispose marker 即连带 dispose 装饰并触发上面的 onDispose 摘除
      try {
        oldest.marker.dispose()
      } catch {
        /* 已随实例 dispose 的 marker 忽略 */
      }
    }
  }
  sessionBookmarks.set(sessionId, list)
  bumpVersion()
  return true
}

/**
 * 摘除指定行上的书签（有则 true）。dispose marker 即可：装饰随 DecorationService
 * 的 marker.onDispose 连带消亡，onDispose 回调同步摘除列表引用
 */
export function removeBookmarkAtLine(sessionId: string, line: number): boolean {
  const list = sessionBookmarks.get(sessionId)
  if (!list) return false
  const bm = list.find(b => b.marker.line === line)
  if (!bm) return false
  try {
    bm.marker.dispose()
  } catch {
    /* 已随实例 dispose 的 marker 忽略 */
  }
  return true
}

/**
 * 标记/取消标记切换（右键「标记此行」单项动作）：返回切换后该行是否带书签，
 * 供文案翻转与 toast 反馈
 */
export function toggleBookmarkAtLine(sessionId: string, line: number): boolean {
  if (isLineBookmarked(sessionId, line)) {
    removeBookmarkAtLine(sessionId, line)
    return false
  }
  return addBookmarkAtLine(sessionId, line)
}

/**
 * 书签列表（按行号升序）：line 为 marker.line 实时值（重排自动跟随），
 * text 为标记时刻快照。行被环形淘汰的书签已从表内摘除，不出现
 */
export function listBookmarks(sessionId: string): TerminalBookmarkInfo[] {
  return (sessionBookmarks.get(sessionId) ?? [])
    .filter(b => b.marker.line >= 0)
    .map(b => ({ line: b.marker.line, text: b.text }))
    .sort((a, b) => a.line - b.line)
}

/**
 * 滚动定位到书签行（书签行落视口顶）：纯视口操作，不写 PTY 字节流。行号越界
 * 钳入缓冲界内（重排/清屏后列表快照行号与实时 marker.line 的固有近似兜底）。
 * 实例缺失返回 false（面板提示未连接），滚动成功返回 true
 */
export function scrollToBookmark(sessionId: string, line: number): boolean {
  const inst = termInstances.get(sessionId)
  if (!inst) return false
  const buf = inst.term.buffer.active
  inst.term.scrollToLine(Math.min(Math.max(0, line), Math.max(0, buf.length - 1)))
  return true
}

/** 会话书签数（计数徽标/单测用） */
export function bookmarkCount(sessionId: string): number {
  return (sessionBookmarks.get(sessionId) ?? []).length
}

/** 会话释放对账（pane 卸载/接管重挂）：清簿记引用并 dispose marker——装饰随
 *  xterm 实例 dispose 一并消亡，与 resetCommandMarks 同口径 */
export function resetBookmarks(sessionId: string): void {
  const list = sessionBookmarks.get(sessionId)
  if (!list) return
  sessionBookmarks.delete(sessionId)
  for (const bm of list) {
    try {
      bm.marker.dispose()
    } catch {
      /* 已随实例 dispose 的 marker 忽略 */
    }
  }
  bumpVersion()
}
