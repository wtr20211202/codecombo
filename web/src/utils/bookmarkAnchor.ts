/**
 * 书签行内容锚（P-20261004-105）：书签从「纯行号」升级为「行号 + 行内容锚」，
 * 跨会话/外部改写（agent 批量改动后重开文件）错位的书签按锚内容自愈重定位。
 *
 * 纯函数域（utils/diffComments 同范式）：读取端（uiState.getEditorBookmarks
 * 形状防御）、写入端（useEditorBookmarks 归一）与重定位判定（装饰桥
 * relocateForCurrentFile）共享同一份 normalize/匹配实现，三处不各自漂移。
 *
 * 形状与向后兼容：旧落盘为纯行号数组（number[]），读取端原样收编为无锚记录
 * （降级——不重定位、不标失效，行为同 MVP）；新落盘为记录数组。锚取「行内容
 * 规范化串前 80 字符」而不用 hash：锚还需在弹层/悬停里可读可调试，80 字符截断
 * 已防 uiState 膨胀（每项目 ≤100 条 × 80 字符有界）。
 */

/** 锚串最大长度（规范化后截断） */
export const BOOKMARK_ANCHOR_MAX_LEN = 80

/** 重定位滑动窗口半径（锚失配时在原行 ±N 行内找唯一匹配） */
export const BOOKMARK_RELOCATE_WINDOW = 20

/** 单条书签记录：line 为 1-based 行号；anchor 缺省 = 无锚（旧数据/空行，降级不重定位） */
export interface BookmarkRecord {
  line: number
  anchor?: string
}

/** 行内容规范化：压缩连续空白为单空格 + 去首尾空白（agent 重排缩进/重排版不改
 *  变锚的语义）后截断前 80 字符。空串返回空——空行不产锚（任何空行都互相同形，
 *  锚了必多义，宁缺毋谎） */
export function normalizeBookmarkAnchor(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, BOOKMARK_ANCHOR_MAX_LEN)
}

/** 记录归一：旧纯行号（number）与记录（{ line, anchor? }）双形态收编，行号取
 *  正整数、按行去重（同行多记录合一——同行的锚由行内容派生必然相同，丢弃无损）、
 *  行升序。uiState 读取端与 useEditorBookmarks 写入端共用，不依赖对方保真 */
export function normalizeBookmarkRecords(entries: Array<BookmarkRecord | number>): BookmarkRecord[] {
  const seen = new Set<number>()
  const out: BookmarkRecord[] = []
  for (const entry of entries) {
    const line = typeof entry === 'number' ? entry : entry?.line
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1 || seen.has(line)) continue
    seen.add(line)
    const raw = typeof entry === 'object' && entry !== null ? entry.anchor : undefined
    const anchor = typeof raw === 'string' ? normalizeBookmarkAnchor(raw) : ''
    out.push(anchor ? { line, anchor } : { line })
  }
  return out.sort((a, b) => a.line - b.line)
}

export interface RelocateResult {
  /** 重定位后的记录表（无锚记录与判定保持的记录原样保留） */
  records: BookmarkRecord[]
  /** 窗口内未找回唯一匹配的锚集（去重、首现序）——消费方标「失效弱标」 */
  missingAnchors: string[]
  /** 实际重定位条数（弹「已自动重锚」弱提示的计数） */
  relocatedCount: number
}

/**
 * 重定位判定（纯函数，jsdom 可直测）：对每条带锚书签——
 *   ① 原行内容规范化后仍等于锚 → 保持（跨会话未漂移的最常见形态）；
 *   ② 失配 → 原行 ±BOOKMARK_RELOCATE_WINDOW 行滑窗找锚的唯一匹配 → 重定位；
 *   ③ 无匹配/多义 → 保持原行号 + 记入 missingAnchors（诚实降级不瞎猜——
 *      多义标失效而非猜最近的一个，猜错比不猜更伤评审信任）。
 * 无锚记录（旧数据降级/空行）原样保留不参与判定。
 *
 * 量级：单条 O(2W)（W=窗口半径，两趟扫描找唯一命中），每项目 ≤100 条，仅在
 * 打开文件/外部重读时机运行一次——非热路径。
 */
export function relocateBookmarkRecords(
  records: BookmarkRecord[],
  lineCount: number,
  lineTextAt: (line: number) => string | null,
  window: number = BOOKMARK_RELOCATE_WINDOW,
): RelocateResult {
  const out: BookmarkRecord[] = []
  const missingAnchors: string[] = []
  let relocatedCount = 0
  for (const rec of records) {
    if (!rec.anchor) {
      out.push(rec)
      continue
    }
    const here = lineTextAt(rec.line)
    if (here !== null && normalizeBookmarkAnchor(here) === rec.anchor) {
      out.push(rec)
      continue
    }
    const lo = Math.max(1, rec.line - window)
    const hi = Math.min(lineCount, rec.line + window)
    let hits = 0
    let hitLine = 0
    for (let l = lo; l <= hi; l++) {
      const text = lineTextAt(l)
      if (text !== null && normalizeBookmarkAnchor(text) === rec.anchor) {
        hits++
        if (hits > 1) break
        hitLine = l
      }
    }
    if (hits === 1) {
      out.push({ line: hitLine, anchor: rec.anchor })
      relocatedCount++
    } else {
      out.push(rec)
      if (!missingAnchors.includes(rec.anchor)) missingAnchors.push(rec.anchor)
    }
  }
  return { records: out, missingAnchors, relocatedCount }
}
