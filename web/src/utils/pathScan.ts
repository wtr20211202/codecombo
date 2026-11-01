/**
 * 自由文本中的路径候选扫描（纯函数，供单测）：终端输出链接层
 * （composables/useTerminalFileLinks）与通知正文路径链接化
 * （utils/notifPathLinks，P-20261004-61）共用同一匹配核——「输出尾部一行
 * 报错栈」两类场景的文本形态同源（编译/测试工具链输出），正则的守卫积累
 * （前置不吃长 token 中段、无灾难回溯、尾随点号不并进路径）只养一份。
 * 本模块零依赖：不 import api/store/xterm，保持可被任意渲染面安全引用
 * （终端链接层拖 xterm/api，通知面不能连带引入）。
 */

/** 行文本中的一个路径候选 */
export interface TerminalPathMatch {
  /** 完整命中文本（路径核 + :LINE[:COL] 后缀） */
  text: string
  /** 路径核（不含行/列后缀） */
  core: string
  /** 命中起始字符索引（行文本内，0-based） */
  start: number
  /** `:LINE` 行号后缀 */
  line?: number
  /** `:COL` 列号后缀 */
  col?: number
}

// 路径匹配正则（模块级复用，g 位按调用 reset）：
// - 前置守卫 (?<![...])：不吃长 token 中段——`xC:\a`、`a.b/c` 的 `b/c`、
//   `http://x` 的 `//x`、`host:8080/file` 的 `/file` 均不从中间起匹配
// - 四个分支按序尝试：Windows 盘符绝对 | POSIX 绝对 | ./ ../ 显式相对 | 纯相对。
//   除 POSIX 绝对（只认 /）外均接受 / 与 \ 两种分隔符（Windows 工具链输出的
//   server\api\file.go:18 同样可点）；纯相对要求至少一段分隔符，单文件名
//   main.go 不匹配——无工作区索引支撑时误报过多，编译报错输出的路径必然
//   带目录段或为绝对路径
// - 核内字符类排除冒号/空白/引号：C: 盘符冒号被核自身消费，尾随 :LINE 消歧天然成立；
//   末段以 [\w@-] 收尾（不吃句尾点号：`see src/x.go.` 不会把句点并进路径）
// - 尾随 (?::\d{1,5}){0,2}：行/列后缀，两个分组均可选
// 无灾难回溯：各 `+` 量词的字符类都不含分支自身的分隔符（/ 或 \），切分点唯一，
// 回溯线性于行长
const PATH_RE = new RegExp(
  '(?<![\\w.@\\-\\\\/:])' +
  '(?:' +
  '[A-Za-z]:[\\\\/](?:[\\w.@\\-]+[\\\\/])*[\\w.@\\-]*[\\w@\\-]' + // Windows 绝对
  '|/(?:[\\w.@\\-]+/)*[\\w.@\\-]*[\\w@\\-]' + // POSIX 绝对
  '|\\.{1,2}[\\\\/](?:[\\w.@\\-]+[\\\\/])*[\\w.@\\-]*[\\w@\\-]' + // ./ ../ 显式相对
  '|(?:[\\w.@\\-]+[\\\\/])+[\\w.@\\-]*[\\w@\\-]' + // 纯相对 src/x.go、src\\x.go
  ')' +
  '(?::(\\d{1,5}))?(?::(\\d{1,5}))?',
  'g',
)

/** 判定路径核是否绝对路径（Windows 盘符或 POSIX 根） */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('/')
}

/** 从行文本提取全部路径候选（含行/列后缀解析）。多行文本安全：核字符类
 *  均不含换行，候选不可能跨行；换行后首字符满足前置守卫（ preceding \n
 *  不在守卫类内），逐行语义与整段扫描一致 */
export function matchPathCandidates(text: string): TerminalPathMatch[] {
  const out: TerminalPathMatch[] = []
  PATH_RE.lastIndex = 0
  for (let m = PATH_RE.exec(text); m !== null; m = PATH_RE.exec(text)) {
    const core = m[0].replace(/(?::\d{1,5}){0,2}$/, '')
    const line = m[1] !== undefined ? parseInt(m[1], 10) : undefined
    const col = m[2] !== undefined ? parseInt(m[2], 10) : undefined
    out.push({ text: m[0], core, start: m.index, line, col })
    // exec 环游安全垫：零宽匹配（本正则不可能，防御性）手动推进防死循环
    if (m.index === PATH_RE.lastIndex) PATH_RE.lastIndex++
  }
  return out
}
