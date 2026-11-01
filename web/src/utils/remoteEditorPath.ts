// 远程文件编辑伪路径（P-20261003-15，VS Code Remote 式）：远程主机文件以
// `remote:<hostId>:<远端绝对路径>` 形态挂进编辑器标签（diff:/untitled:// 同款
// 内部键先例）。解析/构造/判定收敛在此——useOpenFiles 的远程打开/保存分支、
// Breadcrumb 的键展示、EditorGroupPane 的离线横幅都只认这一处格式定义。
// hostId 用稳定 ID 而非主机名：主机重命名不撕毁已开标签的保存目标。

/** 伪路径前缀（内部键；首段含冒号不与真实项目相对路径冲突） */
export const REMOTE_PATH_PREFIX = 'remote:'

export interface RemotePathParts {
  /** 远程主机 ID（保存回写的寻址键） */
  hostId: string
  /** 远端绝对路径（POSIX） */
  rpath: string
  /** 文件名（路径末段，tab 标签展示用） */
  name: string
}

/** 是否远程编辑伪路径（持久化/关闭栈/最近文件等按 path 落地的消费方据此分流） */
export function isRemoteEditorPath(path: string): boolean {
  return path.startsWith(REMOTE_PATH_PREFIX)
}

/** 解析伪路径；形态不符（缺 hostId/缺路径）返回 null，调用方按非远程兜底 */
export function parseRemoteEditorPath(path: string): RemotePathParts | null {
  if (!path.startsWith(REMOTE_PATH_PREFIX)) return null
  const rest = path.slice(REMOTE_PATH_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const hostId = rest.slice(0, sep)
  const rpath = rest.slice(sep + 1)
  if (!hostId || !rpath) return null
  return { hostId, rpath, name: rpath.split('/').pop() || rpath }
}

/** 构造伪路径（右键「在编辑器打开」入口用） */
export function buildRemoteEditorPath(hostId: string, rpath: string): string {
  return `${REMOTE_PATH_PREFIX}${hostId}:${rpath}`
}

/**
 * 敏感系统路径判定（写入警示确认，安全补强）：/etc 与 /boot 是远程主机的
 * 系统配置/引导目录，误写影响整机行为——保存前前端弹确认（不硬禁：编辑
 * 远端配置本就是这个功能的核心场景）。
 */
export function isSensitiveRemotePath(rpath: string): boolean {
  const p = rpath.replace(/\/+$/, '')
  return p === '/etc' || p.startsWith('/etc/') || p === '/boot' || p.startsWith('/boot/')
}

/** 编辑器内容（UTF-8 字符串）→ base64：PUT 回写请求体形态（内容不经 JSON
 *  转义直传字节）。TextEncoder 保 UTF-8 语义；分块拼接防大文件
 *  String.fromCharCode(...spread) 爆参数栈 */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const CHUNK = 0x8000
  let bin = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

// ── hostId → 主机名展示缓存 ──
// Breadcrumb 首段展示主机名比裸 ID 可读；主机列表无 Pinia store（远程管理页
// 自拉），此处维护一份模块级响应式缓存：首读触发一次静默 list()，之后同步命中。
// 拉不到（离线/无主机）回退显示 hostId——展示层降级，不影响保存寻址
import { reactive } from 'vue'
import { remoteHostApi } from '../api/client'

const hostNameMap = reactive<Record<string, string>>({})
let hostNamesFetchStarted = false

/** 主机展示名（未命中时异步拉一次列表，先返回 hostId 兜底） */
export function remoteHostDisplayName(hostId: string): string {
  if (hostNameMap[hostId]) return hostNameMap[hostId]
  if (!hostNamesFetchStarted) {
    hostNamesFetchStarted = true
    void remoteHostApi.list().then((res) => {
      // 拦截器直回 body：AxiosResponse 外壳已剥，按仓内惯例 as unknown as 收窄
      const hosts = (res as unknown as { data?: { id: string; name: string }[] }).data || []
      for (const h of hosts) hostNameMap[h.id] = h.name
    }).catch(() => { /* 列表不可达：展示层回退 hostId */ })
  }
  return hostId
}
