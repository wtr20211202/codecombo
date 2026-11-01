// 片段变量最小子集（P-20261006-1）：VS Code snippet 语法的最小替换面，插入时由
// 客户端展开（片段库存原文，车道 1 纯文本不变——API 直取片段的调用方如 agent 不经
// 此层，按需自拼变量值，ops 手册 snippets 节已注）。
//
// 支持的变量（$NAME 与 ${NAME} 两种拼法等价，与 VS Code 一致）：
//   ${CLIPBOARD}  剪贴板文本（未提供/读取失败 → 原样保留，clipboardMissing 兜底提示）
//   ${DATE}       当日本地日期 YYYY-MM-DD
//   ${TIME}       当日本地时间 HH:mm（最小格式令牌，固定不开放自定义格式串）
//   $0 / ${0}     光标终位：编辑器域从文本剔除、插入后光标落该处（末次出现优先）；
//                 终端域无光标概念，keepFinalTabstop 时原样保留
//
// 未识别的 $TOKEN / ${TOKEN}（$1 待补位、${FOO} 用户自留占位符等）一律原样保留，
// 宽容不炸——与 utils/textTemplate 刻意不把 ${VAR} 当 {参数} 占位符的口径互认：
// 两套语法（{参数} 运行时填值 / $变量 插入时替换）在同一段片段文本上不冲突。
// VS Code 的 \$ 转义不在本最小子集内：终端域 $0 本就不替换，编辑器域遇字面 $0
// 属边缘（表单说明行已注明语义），不为此引入转义层。

export interface SnippetVarContext {
  /** 剪贴板文本；缺省（未提供/读取失败）时 ${CLIPBOARD} 原样保留 */
  clipboardText?: string
  /** 时钟注入（单测定档）；缺省取当前时刻，本地时区（与 agentcron 变量同口径） */
  now?: Date
  /** true = $0 原样保留（终端域无光标概念）；缺省剔除并把位置记入 cursorOffset */
  keepFinalTabstop?: boolean
}

export interface SnippetExpandResult {
  /** 替换后的文本 */
  text: string
  /** $0 剔除处在新文本中的 UTF-16 偏移；keepFinalTabstop / 无 $0 时为 null */
  cursorOffset: number | null
  /** 出现了 ${CLIPBOARD} 但没有可用剪贴板文本（调用方可就地提示降级） */
  clipboardMissing: boolean
}

const VAR_DATE = 'DATE'
const VAR_TIME = 'TIME'
const VAR_CLIPBOARD = 'CLIPBOARD'

/** 文本是否引用了剪贴板变量：调用方据此决定要不要真的读剪贴板——读取有权限/
 *  焦点面（Firefox readText 弹粘贴确认），无变量的插入不该触碰（命中 $CLIPBOARDS
 *  前缀误报无害，展开层不识别即原样保留，只是多读一次） */
export function referencesClipboard(text: string): boolean {
  return text.includes('${CLIPBOARD}') || /\$CLIPBOARD/.test(text)
}

/** 裸名变量：$ 后最大吞入的合法名（VS Code 同款 [A-Za-z_][A-Za-z0-9_]*） */
const BARE_NAME_RE = /[A-Za-z_][A-Za-z0-9_]*/y

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 当日本地日期（YYYY-MM-DD） */
export function formatSnippetDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** 当日本地时间（HH:mm） */
export function formatSnippetTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 变量值解析：命中返回替换文本；不认识的变量名返回 null（调用方原样保留） */
function varValue(name: string, ctx: SnippetVarContext, now: Date): string | null {
  if (name === VAR_DATE) return formatSnippetDate(now)
  if (name === VAR_TIME) return formatSnippetTime(now)
  if (name === VAR_CLIPBOARD) return ctx.clipboardText ?? null
  return null
}

/**
 * 插入时变量替换（纯函数）：扫描 $ 序列——`${NAME}` 括号形式（含 ${0} 终位）、
 * `$NAME` 裸名形式（最大吞名，$CLIPBOARDS 整名不识别即整段保留）；未识别/不完整
 * 序列按字面输出。多次 $0 以末次出现为光标终位（VS Code final cursor 语义）。
 */
export function expandSnippetVars(input: string, ctx: SnippetVarContext = {}): SnippetExpandResult {
  const now = ctx.now ?? new Date()
  let out = ''
  let cursorOffset: number | null = null
  let clipboardMissing = false
  let i = 0
  while (i < input.length) {
    const ch = input[i]
    if (ch !== '$') {
      out += ch
      i++
      continue
    }
    if (input[i + 1] === '{') {
      // ${NAME} 括号形式：闭括号缺失/名字不识别 → 整段按字面
      const end = input.indexOf('}', i + 2)
      if (end !== -1) {
        const name = input.slice(i + 2, end)
        if (name === '0') {
          i = end + 1
          if (ctx.keepFinalTabstop) {
            out += '$0'
          } else {
            cursorOffset = out.length
          }
          continue
        }
        const v = varValue(name, ctx, now)
        // CLIPBOARD 令牌在场即对可用性记账（读取失败原样保留 / 剪贴板为空替换成
        // 空串，两种形态都该提示，终端 sendMode 直发前尤甚）
        if (name === VAR_CLIPBOARD && !ctx.clipboardText) clipboardMissing = true
        if (v !== null) {
          out += v
          i = end + 1
          continue
        }
      }
      out += ch
      i++
      continue
    }
    // $0 裸名终位（$ 后紧随数字不进 BARE_NAME_RE，须在裸名分支前单独接住；
    // $01 之类非本子集，仅认 $ 后恰一个 0 且再无数字跟随）
    if (input[i + 1] === '0' && !/[0-9]/.test(input[i + 2] ?? '')) {
      i += 2
      if (ctx.keepFinalTabstop) {
        out += '$0'
      } else {
        cursorOffset = out.length
      }
      continue
    }
    // $NAME 裸名形式：最大吞名匹配；不识别整名保留（防 $CLIPBOARDS 被 $CLIPBOARD 截胡）
    BARE_NAME_RE.lastIndex = i + 1
    const m = BARE_NAME_RE.exec(input)
    if (m) {
      const v = varValue(m[0], ctx, now)
      if (m[0] === VAR_CLIPBOARD && !ctx.clipboardText) clipboardMissing = true
      if (v !== null) {
        out += v
        i = m.index + m[0].length
        continue
      }
    }
    out += ch
    i++
  }
  return { text: out, cursorOffset, clipboardMissing }
}
