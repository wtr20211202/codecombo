// 远程控制台输入域命令历史——行缓冲纯函数（P-20261005-188）。
// 远程 shell（SSH PTY）无 shell integration（无 OSC 133 标记），输出侧精确域
// （命令+exitCode+时长）天然无效；采集退路是输入域：onData 收口截获按键流做
// 行缓冲，回车分条提交、粘贴多行逐条切分。语义诚实边界：记录的是「提交的
// 输入行」——补全由远端展开，Tab 键不改变缓冲（记录补全前字面形态）；交互
// 程序（vim/htop）的按键流靠控制字符占比启发丢弃；↑ 历史召回的字面在远端
// 输出侧、输入流不可见（召回后追加的按键记为孤立片段）——精度局限由条目
// 来源徽标自明，不假装精确。

/** 单行长度上限：与服务端 terminalHistoryCommandMax（8KB）对齐，超长即污染本行 */
export const REMOTE_INPUT_LINE_MAX = 8 * 1024

/** 噪声启发阈值：单 chunk 控制字符（\r\n 除外）占比过半视为非命令输入流 */
const NOISE_CTRL_RATIO = 0.5
/** 噪声启发最小样本：短 chunk（常规单按键/小粘贴）不做占比判定，零常规开销 */
const NOISE_MIN_LEN = 8

/** 输入域行缓冲状态（采集器持有，feed 原地变更） */
export interface RemoteInputBuffer {
  /** 当前行缓冲（尚未回车提交的已键入字符） */
  line: string
  /** 本行已超长污染：继续吞字节但不提交，回车后复位（残缺命令不落盘） */
  poisoned: boolean
}

export function newRemoteInputBuffer(): RemoteInputBuffer {
  return { line: '', poisoned: false }
}

// bracketed paste 包裹标记（commandRisk.ts 同款常量形态——no-control-regex 红线
// 下不用正则承载控制字符）：现代 shell 开 2004 模式时 xterm term.paste 包裹粘贴段
const BRACKET_ON = '\x1b[200~'
const BRACKET_OFF = '\x1b[201~'

/** 剥离 bracketed-paste 包裹标记，内容中的 \r 逐条切分 */
function stripBracketedPaste(data: string): string {
  return data.split(BRACKET_ON).join('').split(BRACKET_OFF).join('')
}

/** 判断 chunk 是否噪声流：控制字节（C0/\x7f，及整段 ESC 序列）占比过半视为
 * 非命令输入流。ESC 序列整体计入——方向键 mash 的裸 ESC 占比仅 ~1/3，按序列
 * 计数才能命中交互程序按键风暴；\r\n 是提交边界不算控制 */
function isNoisyChunk(data: string): boolean {
  if (data.length < NOISE_MIN_LEN) return false
  let ctrl = 0
  for (let i = 0; i < data.length; ) {
    const c = data.charCodeAt(i)
    if (c === 0x1b) {
      const len = escapeSeqLen(data, i)
      ctrl += len
      i += len
      continue
    }
    if ((c < 0x20 && c !== 0x0d && c !== 0x0a) || c === 0x7f) ctrl++
    i++
  }
  return ctrl / data.length > NOISE_CTRL_RATIO
}

/**
 * 喂入一个 onData chunk，行缓冲原地推进，返回本次提交的完整行（0..n 条，
 * 已 trim、去空行）。返回的行即「提交的输入行」——回车是提交边界：从无回车
 * 的流不产生条目（半截命令随会话结束被丢弃，不假装完整）。
 */
export function feedRemoteInputChunk(buf: RemoteInputBuffer, raw: string): string[] {
  const data = stripBracketedPaste(raw)
  if (data.length === 0 || isNoisyChunk(data)) return []

  const lines: string[] = []
  let i = 0
  while (i < data.length) {
    const c = data[i]!
    const code = c.charCodeAt(0)
    if (c === '\r' || c === '\n') {
      // 提交边界：trim 后非空才入列；污染行（超长截断的残缺命令）静默丢弃
      const line = buf.line.trim()
      if (line !== '' && !buf.poisoned) lines.push(line)
      buf.line = ''
      buf.poisoned = false
      i++
      continue
    }
    if (code === 0x1b) {
      // ESC 序列整段跳过（方向键/编辑键——远端行编辑不可见，字面不属输入流）
      i += escapeSeqLen(data, i)
      continue
    }
    if (code === 0x7f || code === 0x08) {
      // 退格：删最后一个字符（Array.from 按 code point，防代理对切半）
      if (buf.line) {
        const chars = Array.from(buf.line)
        chars.pop()
        buf.line = chars.join('')
      }
      i++
      continue
    }
    if (code === 0x15 || code === 0x03) {
      // Ctrl+U 清行 / Ctrl+C 放弃本行：缓冲清空不提交（放弃的半截命令不入史）
      buf.line = ''
      buf.poisoned = false
      i++
      continue
    }
    if (code < 0x20) {
      // 其余 C0 控制字符（含 \t 补全、Ctrl+D EOF）不改变字面缓冲
      i++
      continue
    }
    if (!buf.poisoned) {
      buf.line += c
      if (buf.line.length >= REMOTE_INPUT_LINE_MAX) buf.poisoned = true
    }
    i++
  }
  return lines
}

/** ESC 序列长度：CSI（\x1b[ 参数+终字节）/[ EO（\x1bO 单字符）/两字符短转义 */
function escapeSeqLen(data: string, start: number): number {
  const next = data[start + 1]
  if (next === '[') {
    let j = start + 2
    while (j < data.length) {
      const cc = data.charCodeAt(j)
      // 终字节 @-~（0x40-0x7e）收束 CSI 序列
      if (cc >= 0x40 && cc <= 0x7e) return j - start + 1
      j++
    }
    return data.length - start
  }
  if (next === 'O') return Math.min(3, data.length - start)
  return next === undefined ? 1 : 2
}
