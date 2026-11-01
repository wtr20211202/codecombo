/**
 * Monaco 内容变更 → 上抛值的增量拼接纯函数（P-20261004-140 自 MonacoEditor.vue
 * 抽出可单测）。编辑器 onDidChangeModelContent 的事件有两类形态，处理策略不同：
 * - 常规文本编辑：changes 携带 rangeOffset/rangeLength/text，按 offset 从后向
 *   前拼进上次上抛值即可，免整文 getValue（打字热路径 O(changes) 而非 O(n)）；
 * - EOL 原语变更（model.setEOL/pushEOL 的 ModelRawEOLChanged）等合成事件：
 *   isEolChange 标记位成立，changes 可能是缺 range 字段的单段（0.55.1 的
 *   EOLChanged）或空数组（其他版本/形态的防御面）——不保证可拼接，须采模型
 *   权威序列化值。EOL 即行序列化分隔符，转换后 getValue 全文即新行尾；
 *   拼接基线（上次上抛值）与合成 change 的 rangeLength 不保证等长（混合行尾
 *   文件打开时已被规范化），强行拼接会把尾巴差错位复制——静默损坏。
 */

/** 编辑器内容变更事件的结构化切片（IModelContentChangedEvent 消费子集）：
 *  纯函数不 import monaco 命名空间，jsdom 单测零 monaco 依赖 */
export interface ContentChangeEventLike {
  isEolChange?: boolean
  changes: Array<{ rangeOffset?: number; rangeLength?: number; text?: string }>
}

/** 单段可拼接内容变更（IModelContentChange 的消费子集） */
export interface ContentChangeLike {
  rangeOffset: number
  rangeLength: number
  text: string
}

/** 事件是否不可增量拼接：EOL 原语变更（isEolChange）、changes 空数组、或
 *  任一段缺 rangeOffset/text（ModelRawEOLChanged 形态）。判定宁滥勿缺——
 *  误判安全侧 = 多做一次 O(n) 整文重取（一次性动作可接受）；漏判侧 =
 *  差位拼接静默损坏全文 */
export function isSpliceUnsafeEvent(e: ContentChangeEventLike): boolean {
  if (e.isEolChange) return true
  if (!Array.isArray(e.changes) || e.changes.length === 0) return true
  return e.changes.some(c => typeof c.rangeOffset !== 'number' || typeof c.text !== 'string')
}

/** 增量拼接：按 rangeOffset 从后向前应用本轮变更（多光标多段变更一并处理；
 *  输入须已过 isSpliceUnsafeEvent 守卫，与 MonacoEditor 既有内联实现逐字节
 *  等价——抽出的只是测试缝，行为零变化） */
export function applyContentChanges(lastEmitted: string, changes: ContentChangeLike[]): string {
  let value = lastEmitted
  const sorted = [...changes].sort((a, b) => b.rangeOffset - a.rangeOffset)
  for (const c of sorted) {
    value = value.slice(0, c.rangeOffset) + c.text + value.slice(c.rangeOffset + c.rangeLength)
  }
  return value
}
