// Git status utilities
import i18n from '../i18n'

const STATUS_COLOR_MAP: Record<string, string> = {
  Modified: 'var(--accent-green-dim)',
  Added: 'var(--accent-yellow)',
  Deleted: 'var(--accent-red)',
  Untracked: 'var(--text-dim)',
  Renamed: 'var(--accent-blue-light)',
  // 未合并（porcelain v2 'u' 行，服务端 Status=Unmerged）：冲突文件红橙示警，
  // 与状态过滤冲突 chip（P-20261003-136）同一聚焦语义；字母 U 与
  // useCommitAgentMsg statusLetter 同码
  Unmerged: 'var(--accent-orange)',
}

const STATUS_LABEL_MAP: Record<string, string> = {
  Modified: 'M', Added: 'A', Deleted: 'D', Untracked: '?', Renamed: 'R', Unmerged: 'U',
}

export function getStatusColor(status?: string): string {
  return STATUS_COLOR_MAP[status || ''] || 'transparent'
}

export function getStatusLabel(status?: string): string {
  return STATUS_LABEL_MAP[status || ''] || ''
}

/** 编辑器 tab git 状态着色档位（P-20261003-242）：untracked 绿，其余变更蓝 */
export type GitTabKind = 'modified' | 'untracked'

/** 构建「文件路径 → tab git 状态」查找表（P-20261003-242）。数据面 =
 *  changes store 缓存（boot/切项目/WS file.changed/保存后四路刷新，零新增
 *  请求）。口径：Untracked → untracked（未跟踪绿）；其余一切在册条目
 *  （Modified/Added/Deleted/Renamed/Unmerged，staged 与否均算）→ modified
 *  （相对 HEAD 有未提交变更即修改蓝，与 VS Code tab decorations 语义一致）。
 *  同路径多条目（staged+unstaged 并存）后写胜出——两形态同为蓝色档，结果
 *  稳定；untracked 不可能与 tracked 变更同路径并存（git 语义互斥） */
export function buildGitTabStatusMap(files: ReadonlyArray<{ path: string; status: string }>): Map<string, GitTabKind> {
  const map = new Map<string, GitTabKind>()
  for (const f of files) {
    if (!f.path) continue
    map.set(f.path, f.status === 'Untracked' ? 'untracked' : 'modified')
  }
  return map
}

// Time formatting（相对时间按当前 locale 输出）
export function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  const t = i18n.global.t
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return t('time.justNow')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return t('time.minutesAgo', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('time.daysAgo', { n: days })
  return date.toLocaleDateString(i18n.global.locale.value)
}

/** 绝对时间：本地时区 YYYY-MM-DD HH:mm:ss（提交悬浮层等需要完整时间的场景） */
export function formatDateTime(dateStr: string): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  if (isNaN(date.getTime())) return dateStr
  const p = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

// Monaco 语言检测
const EXT_LANGUAGE_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
  vue: 'html', html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  json: 'json', md: 'markdown', yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'xml',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  sql: 'sql', r: 'r', dart: 'dart', lua: 'lua', php: 'php',
  dockerfile: 'dockerfile', makefile: 'makefile', toml: 'ini', ini: 'ini', cfg: 'ini',
  gitignore: 'plaintext', env: 'plaintext',
  mjs: 'javascript', cjs: 'javascript',
  cc: 'cpp', cxx: 'cpp',
  lock: 'json',
}

export function getLanguageByPath(path?: string): string {
  if (!path) return 'plaintext'
  const name = path.split('/').pop()?.toLowerCase() || ''
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  if (name === '.gitignore') return 'plaintext'
  if (name === '.gitattributes') return 'plaintext'
  const ext = path.split('.').pop()?.toLowerCase() || ''
  return EXT_LANGUAGE_MAP[ext] || 'plaintext'
}

// 分支引用名校验（P-20261003-221 分支重命名弹窗用）：与服务端
// gitops.validateRefName 同规则镜像——单源在服务端（gitops/branch.go 的
// gitRefNamePattern），前端先行校验只为即时反馈，最终以服务端裁决为准
const BRANCH_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/

/** 校验分支名：合法返回 null，否则返回本地化错误文案（可直接作 promptDialog
 *  validate 回调结果展示） */
export function validateBranchName(name: string): string | null {
  const v = name.trim()
  if (!v) return i18n.global.t('git.branchNameRequired')
  if (v.length > 200) return i18n.global.t('git.branchNameTooLong')
  if (!BRANCH_NAME_PATTERN.test(v)) return i18n.global.t('git.branchNameInvalid')
  return null
}
