import type { Project } from '../stores/project'

// 规范化 remoteURL：小写、去尾部斜杠与 .git 后缀
// （不做 SSH↔HTTPS 深度归一——同一环境内的克隆方式通常一致）
function normalizeRemoteURL(url: string): string {
  const s = (url || '').trim().toLowerCase()
  if (!s) return ''
  let t = s.replace(/\/+$/, '')
  if (t.endsWith('.git')) t = t.slice(0, -4)
  return t
}

/**
 * 跨实例等价项目匹配：切换实例时判断"新实例上的同一个项目"。
 *
 * 级联判定（同一仓库可能被多次 checkout——多分支 / worktree 场景，
 * 仅凭名称无法区分，优先用仓库身份 + 分支）：
 * 1. id 完全相同
 * 2. remoteURL 相同 && 分支相同（仓库身份 + 分支，最精确）
 * 3. 仅 remoteURL 相同（同仓库不同分支，回退）
 * 4. 名称相同（无 remote 信息时的兜底；同名多个时优先分支相同的）
 * 都不命中返回 null（调用方回首页）。
 */
export function matchEquivalentProject(old: Project, candidates: Project[]): Project | null {
  // 1. id 完全相同
  const byId = candidates.find((p) => p.id === old.id)
  if (byId) return byId

  const oldUrl = normalizeRemoteURL(old.remoteURL)

  // 2. remoteURL 相同且分支相同
  if (oldUrl && old.currentBranch) {
    const exact = candidates.find(
      (p) => normalizeRemoteURL(p.remoteURL) === oldUrl && p.currentBranch === old.currentBranch,
    )
    if (exact) return exact
  }

  // 3. 仅 remoteURL 相同（同仓库不同分支）
  if (oldUrl) {
    const byUrl = candidates.find((p) => normalizeRemoteURL(p.remoteURL) === oldUrl)
    if (byUrl) return byUrl
  }

  // 4. 名称相同（同名多个时优先分支相同的）
  const nameMatches = candidates.filter(
    (p) => p.name.toLowerCase() === old.name.toLowerCase(),
  )
  if (nameMatches.length > 0) {
    const sameBranch = nameMatches.find((p) => p.currentBranch === old.currentBranch)
    return sameBranch || nameMatches[0]!
  }

  return null
}
