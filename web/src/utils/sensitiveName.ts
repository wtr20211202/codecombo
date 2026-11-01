/**
 * 敏感文件名匹配（P-20261005-163 回收站敏感条目标记引入的前端镜像）：
 * 单一事实源在 `server/share/scan.go` 的 sensitivePatterns（分享扫描 ScanSensitive /
 * 补丁导出警示 P-97 / 外部改动审计 P-20261005-15 同表），前端无运行时读取通道，
 * 双处硬编码以此注释互指——服务端扩/改模式必须同步此处（sensitiveMask.ts
 * 前后端互锁同纪律）；消费方（TrashModal 徽标 / 删除入站 toast）禁止就地复制
 * 模式表。判定语义与 IsSensitiveName 一致：文件名统一转小写后命中任一 glob
 * （basename 级，模式表无分隔符模式，调用方自行取 basename）。
 */

// 与 scan.go sensitivePatterns 逐条对齐（小写基准；改动两处同步）
const SENSITIVE_PATTERNS = [
  '.env*', // .env / .env.local / .env.production 等环境密钥
  'id_rsa*',
  '*.pem',
  '*.key',
  '.npmrc', // 可含 _authToken
  '.netrc',
  '.git-credentials',
  '*.kdbx', // KeePass 口令库
  'serviceaccount*.json',
  'credentials.json',
]

// glob → 正则：`*` 转非分隔符任意段（与 Go path.Match 语义一致，basename
// 输入下等价 .*），其余特殊字符字面转义；模块加载期一次编译，匹配期零构造
const SENSITIVE_RES = SENSITIVE_PATTERNS.map(pat =>
  new RegExp(`^${pat.replace(/[.*+?^${}()|[\]\\]/g, ch => (ch === '*' ? '[^/]*' : `\\${ch}`))}$`),
)

/** 文件名（大小写不敏感）命中敏感模式表任一 glob 即视为敏感 */
export function isSensitiveName(name: string): boolean {
  if (!name) return false
  const lower = name.toLowerCase()
  return SENSITIVE_RES.some(re => re.test(lower))
}

/** 项目相对路径（/ 分隔）的敏感判定：basename 级，与服务端
 * MatchSensitivePaths 同口径（路径分隔符显式兼容反斜杠，归一不依赖宿主平台
 * ——filepath.ToSlash 在 Linux 是恒等操作，三平台纪律要显式一致） */
export function isSensitivePath(p: string): boolean {
  const norm = p.trim().replace(/\\/g, '/')
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  return isSensitiveName(base)
}
