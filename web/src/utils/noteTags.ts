// 笔记标签纯函数（P-20261112-7 S2 面板标签行）：归一化语义与 S1 服务端
// normalizeNoteTags（server/store/notesmulti.go）对齐——trim 每项、空串丢弃、
// 去重保序（首现位置）、超 32 rune 丢弃、超 8 个截断保前 8。独立重写而非共享
// 代码（前后端异语言异仓段），语义一致性由双侧单测各自钉住；前端归一是编辑
// 面第一道兜底（上限/去重不依赖服务端截断），服务端写路径仍是最终真值。

/** 单篇标签数上限（与服务端 store.NotesMaxTags 同值） */
export const NOTE_TAGS_MAX = 8

/** 单个标签 rune 上限（与服务端 store.NotesMaxTagRunes 同值；rune 非字节，
 *  JS string.length 即 UTF-16 码元——中文 BMP 内两者一致，此处按 codePoint
 *  计数对齐 rune 语义） */
const NOTE_TAG_MAX_RUNES = 32

function runeLength(s: string): number {
  // 展开（[...s]）按 Unicode 码点迭代——emoji 代理对计 1，对齐 Go []rune 语义
  return [...s].length
}

/**
 * 标签归一化（编辑面写入统一入口）：trim 每项、空串丢弃、去重保序、超 32
 * rune 丢弃、超 8 个截断保前 8。输入非数组/含非字符串项时跳过该项（标签行
 * 自产数据不会出现，防御外部形态）——服务端 decode 容错同款哲学：非法 tag
 * 丢弃不报错，坏数据不阻断便签编辑
 */
export function normalizeNoteTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    if (typeof raw !== 'string') continue
    const t = raw.trim()
    if (t === '' || runeLength(t) > NOTE_TAG_MAX_RUNES) continue
    if (seen.has(t)) continue
    seen.add(t)
    out.push(t)
    if (out.length === NOTE_TAGS_MAX) break
  }
  return out
}

/**
 * 全库既有标签去重集合（标签行「+」内联输入的自动补全候选源）：按清单序
 * （updatedAt 降序——热门笔记的标签先出现）保序去重。不含回收站篇（trash
 * 清单独立按需拉取，不进常驻候选；恢复后在册清单刷新自然纳入）
 */
export function collectNoteTags(notes: ReadonlyArray<{ tags?: string[] }>): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of notes) {
    for (const t of n.tags ?? []) {
      if (seen.has(t)) continue
      seen.add(t)
      out.push(t)
    }
  }
  return out
}
