/**
 * diff 审阅留言（P-20261003-279）：产出 diff 的行级留言（「这里要改」）的
 * 数据形状与纯函数——持久化形状防御、行锚点漂移和解。纯函数零 Monaco/零
 * store 依赖（单测免环境）；状态与持久化在 useDiffComments（模块单例，
 * uiState `diffComments` 命名空间，bookmarks 同范式）；UI 承载在 DiffEditor
 * （产出 diff 审阅面，P-208 同热区）。
 */

/** 单条行级留言。锚点 = 文件相对路径 + line（1-based，diff 右侧=工作区版本
 *  行号，与 P-208「追问此改动」/P-57「在编辑器打开」的形态守卫同口径）；
 *  lineText 是留言时该行内容快照（trim 后比对）——行锚点漂移容忍的匹配锚
 *  （同 P-200 注记思路：内容匹配找回，找不回诚实标注而非丢弃） */
export interface DiffComment {
  id: string
  line: number
  text: string
  lineText: string
  createdAt: number
  resolved: boolean
}

/** 单条留言正文上限（字符）：留言是定位性短评（「这里要改」），超长请拆行
 *  多条或落项目笔记；与 launchArgs 的 500 字节配额无关联（本数据不走会话链） */
export const DIFF_COMMENT_MAX_TEXT = 500

/** 漂移搜索窗口：锚点行内容对不上时在 ±N 行内按内容精确匹配找回。
 *  40 行覆盖常规审阅间隔内的增删改；更大重排属内容重写，留言诚实留在
 *  原行号（渲染端按内容失配标注「可能已漂移」）而非盲目跟随 */
export const DIFF_COMMENT_DRIFT_WINDOW = 40

/** 每项目留言总条数上限（防 uiState 膨胀；bookmarks 每项目 100 行同量级） */
export const DIFF_COMMENTS_MAX_PER_PROJECT = 100

/** 留言 id：毫秒时间戳 + 短随机（同毫秒并发的区分位） */
export function newDiffCommentId(now = Date.now()): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** 单文件的留言表形状防御（uiState 读取端用，落盘 JSON 可能带脏形状）：
 *  非数组整体剔除；条目逐字段收紧——id 非空串、line 正整数、text/lineText
 *  串（lineText 允许空 = 早期数据无锚，漂移和解按「找不回」降级）、createdAt
 *  正数、resolved 布尔缺省 false；按行升序稳定排序（渲染与最旧淘汰同序） */
export function normalizeDiffComments(raw: unknown): DiffComment[] {
  if (!Array.isArray(raw)) return []
  const out: DiffComment[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object') continue
    const { id, line, text, lineText, createdAt, resolved } = c as Partial<DiffComment>
    if (typeof id !== 'string' || !id) continue
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) continue
    if (typeof text !== 'string') continue
    if (lineText !== undefined && typeof lineText !== 'string') continue
    if (typeof createdAt !== 'number' || !(createdAt > 0)) continue
    out.push({
      id,
      line,
      text,
      lineText: lineText || '',
      createdAt,
      resolved: resolved === true,
    })
  }
  return out.sort((a, b) => a.line - b.line || a.createdAt - b.createdAt)
}

/** 裁剪到上限：超出时按 createdAt 最旧先淘汰（createdAt 是本形状的天然时间轴，
 *  比 bookmarks 的插入序近似更精确）；淘汰集外保持原表相对序（行升序不因
 *  裁剪被打乱） */
export function capDiffComments(comments: DiffComment[], cap = DIFF_COMMENTS_MAX_PER_PROJECT): DiffComment[] {
  if (comments.length <= cap) return comments
  const drop = new Set(
    [...comments]
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, comments.length - cap)
      .map((c) => c.id),
  )
  return comments.filter((c) => !drop.has(c.id))
}

/**
 * 行锚点漂移和解（④）：diff 重开时右侧 model 行数与内容可能已变（工作区
 * 又被改过）。逐条处理：
 *  - 行号越界 → 收敛到 [1, lineCount]（文件被改短的重开场景，书签裁剪同款）；
 *  - 当前行内容与锚一致 → 原地不动；
 *  - 失配 → ±DRIFT_WINDOW 内由近及远按 trim 后内容精确匹配找回，命中则
 *    retarget 行号（内容一致才跟随——「同一行被挪走」而非「恰好在窗口里长得
 *    像」需内容语义等价，trim 级别已足够稳）；找不回则留原位由渲染端标注。
 * 返回新表与是否有变化（调用方据此决定重放装饰/落盘）。纯函数：getLine 由
 * 调用方注入（n 从 1 计，越界返回空串）。
 */
export function reconcileCommentDrift(
  comments: DiffComment[],
  lineCount: number,
  getLine: (n: number) => string,
  window = DIFF_COMMENT_DRIFT_WINDOW,
): { comments: DiffComment[]; changed: boolean } {
  if (lineCount < 0) lineCount = 0
  let changed = false
  const next = comments.map((c) => {
    // 行号越界先收敛（文件改短：clamp 到尾行；空文件 clamp 到 1，渲染端按
    // 内容失配标注漂移，留言本体不丢）
    const line = Math.min(Math.max(c.line, 1), Math.max(lineCount, 1))
    if (line !== c.line) changed = true
    if (!c.lineText || getLine(line).trim() === c.lineText) {
      if (line !== c.line) return { ...c, line }
      return c
    }
    // 由近及远双向搜索（先上方后下方同距），内容一致才跟随
    for (let d = 1; d <= window; d++) {
      const up = line - d
      if (up >= 1 && getLine(up).trim() === c.lineText) {
        changed = true
        return { ...c, line: up }
      }
      const down = line + d
      if (down <= lineCount && getLine(down).trim() === c.lineText) {
        changed = true
        return { ...c, line: down }
      }
    }
    return line !== c.line ? { ...c, line } : c
  })
  return { comments: next, changed }
}
