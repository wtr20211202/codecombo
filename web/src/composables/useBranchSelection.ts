import { ref, watch } from 'vue'
import { branchApi, projectApi } from '../api/client'

/**
 * CommitsPanel 分支选择器逻辑（自 CommitsPanel.vue 抽出）：
 * 拉取分支+标签 → 构建下拉选项 → 监听外部选中分支变化（uiState 恢复/GitPanel 联动）。
 */
export function useBranchSelection(options: {
  currentProjectId: () => string
  fetchLog: () => Promise<void>
  selectedBranch: () => string
}) {
  const { currentProjectId, fetchLog, selectedBranch } = options

  interface BranchOption { label: string; value: string }
  const branchOptions = ref<BranchOption[]>([])
  const internalBranch = ref('')
  const branchLoading = ref(false)

  async function fetchBranchesAndTags() {
    if (!currentProjectId()) return
    branchLoading.value = true
    try {
      const [branchRes, tagRes]: [any, any] = await Promise.all([
        branchApi.list(currentProjectId()),
        projectApi.tags(currentProjectId()),
      ])
      const branches: any[] = branchRes.data || []
      const tags: any[] = tagRes.data || []

      const current = branches.find((b: any) => b.isCurrent)
      internalBranch.value = current?.name || ''

      const localBranches = branches.filter((b: any) => !b.isRemote)
      const remoteMap = new Map<string, string[]>()
      for (const b of branches.filter((b: any) => b.isRemote)) {
        const parts = b.name.split('/')
        const remote = parts[0]!
        const ref = parts.slice(1).join('/')
        if (!remoteMap.has(remote)) remoteMap.set(remote, [])
        remoteMap.get(remote)!.push(ref)
      }

      const opts: BranchOption[] = []
      if (current) opts.push({ label: `⭐ ${current.name}`, value: current.name })
      for (const b of localBranches.filter((b: any) => !b.isCurrent)) {
        opts.push({ label: `📁 ${b.name}`, value: b.name })
      }
      for (const [remote, refs] of remoteMap) {
        for (const ref of refs) {
          opts.push({ label: `☁ ${remote}/${ref}`, value: `${remote}/${ref}` })
        }
      }
      for (const tg of tags) {
        opts.push({ label: `🏷 ${tg.name}`, value: `tags/${tg.name}` })
      }

      branchOptions.value = opts
    } catch {
      // 静默
    } finally {
      branchLoading.value = false
    }
  }

  async function handleBranchChange(val: string) {
    internalBranch.value = val
    await fetchLog()
  }

  // 监听外部传入的分支选择（uiState 恢复 / GitPanel 树点击）。
  // 恢复值可能来自其他项目的残留（实例切换后 uiState 串写），分支在本项目不存在时
  // 直接使用会让 git log 报错——先对照分支/tag 列表校验，非法值丢弃
  watch(selectedBranch as any, async (val) => {
    if (!val || val === internalBranch.value) return
    if (!branchOptions.value.length) await fetchBranchesAndTags()
    if (!branchOptions.value.some(o => o.value === val)) return
    internalBranch.value = val
    fetchLog()
  })

  return { branchOptions, internalBranch, branchLoading, fetchBranchesAndTags, handleBranchChange }
}
