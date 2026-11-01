import { maskSensitive } from './sensitiveMask'

/**
 * 选区内联 AI 编辑的结构化指令组装（P-20261005-206，纯函数）：文件路径+行号
 * 区间+选区内容+指令收进「单条排队指令」的形状——发送通道是运行中会话的指令
 * 队列（P-20261003-248 enqueue），服务端 sanitizeInstruction 把控制字符（含
 * 换行）折叠为空格并按 rune 计上限 2000（server/store/agentsessionqueue.go
 * AgentQueueItemMaxRunes），组装必须先于服务端收敛：
 * - 单行化：选区/指令内的换行与连续空白折叠为单空格（换行会让 TUI 提前提交
 *   半条指令，与 sanitizeInstruction 同语义，前端先做保证装箱度量诚实）
 * - maskSensitive 兜底：选区可能贴着令牌/口令（P-108 模式集），出域前遮蔽
 *   ——真值遮掉不影响「改写此段」的意图表达（agent 不需要密钥原文即可重构）
 * - 装箱方向：指令在前（agent 读到意图）、定位次之、选区保头裁尾（选中起点
 *   价值密度高，P-122 fitSelectionPrompt 同取向；此处 rune 计数非字节——
 *   服务端上限是 rune 不是字节，度量轴必须同源）
 * i18n 渲染面（location/codePrefix 文案）由调用方经 t() 渲染后传入，本模块
 * 保持零 vue-i18n 依赖可直测。
 */

/** 服务端单条排队指令上限（rune），与 AgentQueueItemMaxRunes 对齐 */
export const QUEUE_ITEM_MAX_RUNES = 2000

/** 组装所需的本地化片段（调用方渲染）：location = 「路径 第 n-m 行」文案 */
export interface InlineEditInstructionParts {
  /** 用户输入的修改指令（一句话意图） */
  instruction: string
  /** 目标定位文案（已含路径与行号区间，如「src/a.ts 第 1-2 行」） */
  location: string
  /** 选区引语前缀（如「原代码：」） */
  codePrefix: string
}

/** rune（Unicode 码点）计数：上限轴与服务端 utf8.RuneCountInString 同源 */
function runeLength(s: string): number {
  return Array.from(s).length
}

/** 按 rune 保头截取 */
function sliceRunes(s: string, n: number): string {
  return Array.from(s).slice(0, n).join('')
}

/** 单行化：控制字符（含换行）与连续空白折叠为单空格，去首尾 */
export function foldInlineText(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** 组装结构化指令（单行、≤max rune）：`{指令}（{定位}；{引语}{选区}）`。
 *  超限时只从选区段裁（… 尾缀标注省略）；指令+定位自身把配额吃光的极端形态
 *  退化为「指令+定位」保头裁剪（定位信息不能丢，指令开头即意图）。空选区
 *  （折叠后空串）允许——纯指令指令也成立（agent 按行号自取上下文） */
export function buildInlineEditInstruction(
  parts: InlineEditInstructionParts,
  code: string,
  max = QUEUE_ITEM_MAX_RUNES,
): string {
  const instruction = maskSensitive(foldInlineText(parts.instruction))
  const location = maskSensitive(foldInlineText(parts.location))
  const codeFolded = maskSensitive(foldInlineText(code))
  const full = `${instruction}（${location}；${parts.codePrefix}${codeFolded}）`
  if (runeLength(full) <= max) return full
  // 选区段先让位：预算 = max - 指令/定位/引语/包裹符（含收尾「）」与 … 余量）。
  // （选区为空串时 full 必 ≤max，走到这里选区段必在场）
  const head = `${instruction}（${location}；${parts.codePrefix}`
  const headRunes = runeLength(head) + 2
  if (headRunes < max) {
    return `${head}${sliceRunes(codeFolded, max - headRunes)}…）`
  }
  // 指令/定位自身超长：保头整体裁剪（丢引语与选区，保意图开头+定位）
  return `${sliceRunes(`${instruction}（${location}`, max - 1)}…`
}
