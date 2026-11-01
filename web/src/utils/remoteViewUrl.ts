/**
 * 「在平台上查看」URL 组装：项目 remote + 当前分支 + 文件相对路径
 * → 代码托管平台的 blob 页 URL（GitHub / GitLab / Gitee 及自建实例通用，
 * 三大平台 + Gitea 均支持 /blob/<ref>/<path>）。
 *
 * remote 归一化口径（对齐后端 server/api/gitops/pr.go parseRemoteURL 的三种形态）：
 *  - https://host[:port]/[subpath/]owner/repo[.git] → 原样保留 scheme/host/端口/子路径；
 *  - ssh://[user@]host[:port]/owner/repo[.git]      → https，ssh 端口与 web 端口无关，去掉；
 *  - SCP（git@host:owner/repo[.git]）               → https；
 * 其余（本地路径、file:// 等）返回 null → 入口隐藏。
 *
 * 分支/文件路径按段 encodeURIComponent（保留 /）：分支名含 /（feature/x）、
 * 文件名含空格或 # 时 URL 仍有效。
 */

export type RemotePlatform = 'github' | 'gitlab' | 'gitee' | 'generic'

export interface RemoteViewInfo {
  /** 平台页 URL：<scheme>://<host>[:port]/[subpath/]<owner>/<repo>/blob/<ref>/<file> */
  url: string
  platform: RemotePlatform
  /** 归一化后的 web 主机名（不含端口），generic 平台兜底展示用 */
  host: string
}

/** 平台展示名：三大知名平台用品牌名，generic 由调用方传本地化兜底文案 */
export function remotePlatformName(platform: RemotePlatform, genericLabel: string): string {
  switch (platform) {
    case 'github': return 'GitHub'
    case 'gitlab': return 'GitLab'
    case 'gitee': return 'Gitee'
    default: return genericLabel
  }
}

function detectPlatform(hostname: string): RemotePlatform {
  const h = hostname.toLowerCase()
  if (h === 'github.com' || h.endsWith('.github.com')) return 'github'
  if (h === 'gitlab.com' || h.endsWith('.gitlab.com')) return 'gitlab'
  if (h === 'gitee.com' || h.endsWith('.gitee.com')) return 'gitee'
  return 'generic'
}

/** 保留 / 的分段编码（分支名 feature/x → feature/x；文件名 a b.md → a%20b.md） */
function encodePathSegments(path: string): string {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/')
}

/**
 * 从 URL 路径拆出 [子路径前缀, owner, repo]：末段为仓库名（去 .git 后缀），
 * 倒数第二段为 owner，其余为平台子路径（自建 Gitea 常见）。不足两段视为无效。
 */
function splitOwnerRepo(pathname: string): { prefix: string; owner: string; repo: string } | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length < 2) return null
  const repo = segments[segments.length - 1]!.replace(/\.git$/i, '')
  const owner = segments[segments.length - 2]!
  if (!owner || !repo) return null
  return { prefix: segments.slice(0, -2).join('/'), owner, repo }
}

/** https/http：scheme/host/端口/子路径全部原样保留 */
function fromHttpUrl(raw: string): { webBase: string; hostname: string } | null {
  try {
    const u = new URL(raw)
    const ownerRepo = splitOwnerRepo(u.pathname)
    if (!ownerRepo) return null
    const webBase = [u.origin, ownerRepo.prefix, ownerRepo.owner, ownerRepo.repo]
      .filter(Boolean)
      .join('/')
    return { webBase, hostname: u.hostname }
  } catch {
    return null
  }
}

/** ssh://[user@]host[:port]/…：剥 user@ 与 ssh 端口，host 起视为 https */
function fromSshUrl(raw: string): { webBase: string; hostname: string } | null {
  let rest = raw.slice(raw.indexOf('://') + 3)
  const at = rest.lastIndexOf('@')
  if (at >= 0) rest = rest.slice(at + 1)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  // ssh 端口（host:2222）不等于 web 端口，直接剥掉走 https 默认端口
  const hostname = rest.slice(0, slash).split(':')[0]!.trim()
  const ownerRepo = splitOwnerRepo(rest.slice(slash))
  if (!hostname || !ownerRepo) return null
  const webBase = [ownerRepo.prefix, ownerRepo.owner, ownerRepo.repo].filter(Boolean).join('/')
  return { webBase: `https://${hostname}/${webBase}`, hostname }
}

/** SCP 形态（git@host:owner/repo.git）：host 段限定字符集并排除单字符——
 *  防把 Windows 本地路径 remote（D:/x、D:\x）误判为 host=D */
function fromScpUrl(raw: string): { webBase: string; hostname: string } | null {
  const m = /^(?:([^@/:\\]+)@)?([A-Za-z0-9._-]+):(.+)$/.exec(raw)
  if (!m) return null
  const hostname = m[2]!
  if (hostname.length < 2) return null // 盘符（D:/…）不是主机名
  const ownerRepo = splitOwnerRepo(`/${m[3]!.replace(/\\/g, '/')}`)
  if (!ownerRepo) return null
  const webBase = [ownerRepo.prefix, ownerRepo.owner, ownerRepo.repo].filter(Boolean).join('/')
  return { webBase: `https://${hostname}/${webBase}`, hostname }
}

/** remote + ref + 文件路径 → 平台 blob 页；任一要素缺失/不可解析返回 null（入口隐藏） */
export function buildRemoteViewUrl(input: {
  remoteUrl?: string | null
  ref?: string | null
  filePath?: string | null
}): RemoteViewInfo | null {
  const raw = (input.remoteUrl || '').trim()
  const ref = (input.ref || '').trim()
  const filePath = (input.filePath || '').trim()
  if (!raw || !ref || !filePath) return null

  let parsed: { webBase: string; hostname: string } | null = null
  if (/^https?:\/\//i.test(raw)) parsed = fromHttpUrl(raw)
  else if (/^ssh:\/\//i.test(raw)) parsed = fromSshUrl(raw)
  // 其余带 scheme 的（file://、git:// 等本地/守护进程形态）不做平台页映射
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) parsed = fromScpUrl(raw)
  if (!parsed) return null

  return {
    url: `${parsed.webBase}/blob/${encodePathSegments(ref)}/${encodePathSegments(filePath)}`,
    platform: detectPlatform(parsed.hostname),
    host: parsed.hostname,
  }
}
