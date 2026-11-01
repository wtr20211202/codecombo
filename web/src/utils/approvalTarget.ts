/**
 * 审批卡 target 路径形态探测与卡面展示（P-20261003-47/P-20261003-201/
 * P-20261003-231，纯函数供单测）：target 是 agent 自由文本——文件写入类
 * 审批传项目相对路径，命令类审批传命令行（git push 等）。形态守卫只认
 * 「长得像项目相对路径」的 target：命中 → 卡上渲染可点态（点击预览
 * 文件/差异），否则保持纯文本（既有呈现零变化）。探测是纯形态启发式，
 * 不保证文件真实存在——agent 可能引用将新建的路径，落空由点击链静默兜底
 * （不弹错）；探测命中已存在目录时点击改派文件树定位（P-201，
 * isDirectoryProbeError）。路径形态的卡面展示文本走 middleEllipsis 中段
 * 省略（P-231：CSS ellipsis 尾裁对长路径恰裁掉文件名，中段省略保首尾）。
 */

/** 相对路径匹配口径归一化：反斜杠统一正斜杠 + 去多余 ./ 前缀。仅用于
 *  点击链的 git status 比对，不做大小写归一（Linux 大小写敏感，误并更糟） */
export function normRelPath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\/+/, '')
}

/** git status 清单条目的最小结构（结构与 stores/changes.FileStatus 对齐，
 *  纯函数不依赖 store） */
export interface PathStatusLike {
  path: string
  status: string
}

/** target 是否路径形态（项目相对路径：含分隔符，或单段命中常见文件形态）。
 *  守卫从严判定（宁降级纯文本勿误渲染可点态）：空白 = 命令行形态（git push
 *  origin main / reset --hard）；以 / 开头或盘符开头 = 绝对路径——agentguard
 *  服务端强制面的 target 就是 /api/... 形态；:// = URL。单段无扩展名（分支名
 *  main、Makefile）同样判非——漏判只是少一个可点态（提案④静默降级可接受） */
export function isPathLikeTarget(target: string): boolean {
  const s = target.trim()
  if (!s || s.length > 512) return false // 空 / 超服务端 target 512 上限
  if (/\s/.test(s)) return false // 空白 = 命令行形态
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false // 绝对路径 / API 路径
  if (s.includes('://')) return false // URL
  if (/[/\\]/.test(s)) return true // 含分隔符 = 路径形态（src/main.go、a\b.js）
  return /\.[A-Za-z0-9]{1,16}$/.test(s) // 单段常见文件形态（README.md、main.go）
}

/** 路径在 git status 清单里是否有未提交差异（vs HEAD）：Untracked 是尚无
 *  HEAD 基线的新文件（点击直接打开看内容），其余 Modified/Added/Deleted/
 *  Renamed 不论 staged 与否都相对 HEAD 有差异 → 点击直开差异视图 */
export function hasUncommittedDiff(files: PathStatusLike[], target: string): boolean {
  const t = normRelPath(target)
  return files.some(f => normRelPath(f.path) === t && f.status !== 'Untracked')
}

/** filePolicy 探测错误是否「路径是已存在目录」（P-20261003-201 目录判定）：
 *  服务端 GetFilePolicy 对目录的专属 400 响应（稳定原文 "path is a directory"，
 *  server/api/files/file.go），与 404（不存在，将新建路径）/403（越出项目根）
 *  相区分——目录类审批（mkdir/写入目录等）target 点击据此改派树定位
 *  （OPS_LOCATE_IN_TREE）。结构化窄取而非 instanceof AppError：本模块保持
 *  零依赖纯函数（与同文件守卫同族），点击链的错误恒为拦截器抛出的 AppError
 *  （web/src/api/http.ts 响应拦截器统一包装，status/rawMessage 字段稳定） */
export function isDirectoryProbeError(err: unknown): boolean {
  const e = err as { status?: unknown; rawMessage?: unknown } | null | undefined
  return typeof e?.status === 'number' && e.status === 400
    && typeof e.rawMessage === 'string' && /path is a directory/i.test(e.rawMessage)
}

// ---- 卡面展示中段省略（P-20261003-231）：长路径保首尾，文件名恒可见 ----

/** 中段省略的首/尾保留码点数：路径的辨识信息两头分布——头段是目录前缀
 *  （形态可辨）、尾段是文件名（目标可辨），中段深目录层级冗余度最高。
 *  CSS ellipsis 单行尾裁对长路径恰裁掉文件名（目录前缀吞文件名），路径
 *  形态 target 的卡面展示由此改走 JS 中段截断 */
export const TARGET_ELLIPSIS_HEAD = 20
export const TARGET_ELLIPSIS_TAIL = 24

/** 长路径中段省略：超过 head+tail+1 码点时保留前 head + 后 tail，中段以
 *  … 收口（阈值取 +1：省略号恰替一中段字符，不超时截断不省任何信息量，
 *  短路径原样返回）。按码点（Array.from）切而非 UTF-16 码元 slice——
 *  文件名可含 emoji 等增补平面字符，码元切会腰斩代理对出乱码。全量文本
 *  恒由调用方留在 title tooltip（悬停核对），本函数只管展示面 */
export function middleEllipsis(s: string): string {
  const chars = Array.from(s)
  if (chars.length <= TARGET_ELLIPSIS_HEAD + TARGET_ELLIPSIS_TAIL + 1) return s
  return chars.slice(0, TARGET_ELLIPSIS_HEAD).join('') + '…'
    + chars.slice(-TARGET_ELLIPSIS_TAIL).join('')
}
