/**
 * 文件名跨平台兼容性校验（P-20261002-132）纯函数：Windows 保留设备名 +
 * 段结尾点/空格。与服务端 files 模块 namecompat.go 同清单同语义（创建入口
 * 双端兜底：前端行内输入即时红提示，服务端 400 拒绝直达 API 的调用方）。
 * 仅校验段结尾与保留名两项，不拦正常名（名字内部含点/空格、开头点等均放行）。
 */

/** Windows 保留设备名清单（大小写不敏感，主干——首个点之前——命中即保留） */
const RESERVED_DEVICES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

/** 兼容性问题类型：reservedWindowsName 保留设备名 / trailingDotSpace 段结尾点或空格 */
export type FileNameIssue = 'reservedWindowsName' | 'trailingDotSpace'

/** 判定单段是否 Windows 保留设备名：CON.txt / con.tar.gz 保留，constant.go 不受影响 */
function isReservedDevice(seg: string): boolean {
  const dot = seg.indexOf('.')
  const base = dot === -1 ? seg : seg.slice(0, dot)
  return RESERVED_DEVICES.has(base.toUpperCase())
}

/**
 * 校验名称（可为含 / 的多段路径，行内输入即单段）：逐段检查，命中返回问题类型，
 * 正常名返回 null。空段与 "."/".." 段跳过（路径越界由服务端 SafeJoinProject 管）。
 */
export function fileNameCompatIssue(name: string): FileNameIssue | null {
  for (const seg of name.split('/')) {
    if (!seg || seg === '.' || seg === '..') continue
    if (isReservedDevice(seg)) return 'reservedWindowsName'
    if (/[. ]$/.test(seg)) return 'trailingDotSpace'
  }
  return null
}
