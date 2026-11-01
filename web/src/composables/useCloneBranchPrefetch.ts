import { computed, ref } from 'vue'
import { cloneApi } from '../api/client'
import { AppError } from '../api/error-types'

/**
 * 克隆前远端分支预取（P-20261003-93）：URL 填写后「拉取分支」小钮 →
 * POST /api/clone/branches（服务端 ls-remote --heads，凭据注入语义同克隆）
 * → 分支下拉可选。CloneModal 与 AddProjectDialog 两个克隆入口共用。
 *
 * 可选能力不设闸门：预取失败只在表单行内提示（服务端 502 稳定标记
 * 「remote branch prefetch failed: <类别>」映射本地化文案），分支仍可
 * 手填/留空走默认分支——拉不到列表的远端对克隆同样可用。
 */

// 服务端稳定标记 → 行内提示 i18n key（标记原文即 server/api/gitops/clone.go
// lsRemoteBranchesErrPrefix + classifyLsRemoteError 类别，改动须两侧同步）
export function branchErrorI18nKey(raw: string): string {
  if (/remote branch prefetch failed: authentication failed/i.test(raw)) return 'clone.branches.failedAuth'
  if (/remote branch prefetch failed: remote unreachable/i.test(raw)) return 'clone.branches.failedUnreachable'
  if (/remote branch prefetch failed: repository not found/i.test(raw)) return 'clone.branches.failedNotFound'
  return 'clone.branches.failedGeneric'
}

export function useCloneBranchPrefetch() {
  const branches = ref<string[]>([])
  const loadingBranches = ref(false)
  const branchErrorKey = ref('')

  const branchOptions = computed(() => branches.value.map(b => ({ label: b, value: b })))

  async function fetchBranches(url: string, sshKeyId?: string) {
    const trimmed = url.trim()
    if (!trimmed || loadingBranches.value) return
    loadingBranches.value = true
    branchErrorKey.value = ''
    try {
      // silent：失败由本表单行内提示，不弹全局 toast（不阻断克隆主流程）
      const res = await cloneApi.branches({ url: trimmed, sshKeyId }, { silent: true })
      branches.value = res?.data ?? []
    } catch (e) {
      branches.value = []
      branchErrorKey.value = branchErrorI18nKey(e instanceof AppError ? e.rawMessage : '')
    } finally {
      loadingBranches.value = false
    }
  }

  function resetBranches() {
    branches.value = []
    loadingBranches.value = false
    branchErrorKey.value = ''
  }

  return { branches, branchOptions, loadingBranches, branchErrorKey, fetchBranches, resetBranches }
}
