import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { branchApi } from '../api/client'

export interface Branch {
  name: string
  isCurrent: boolean
  isRemote: boolean
  isMerged: boolean
  upstream: string
  ahead: number
  behind: number
}

export const useBranchStore = defineStore('branch', () => {
  const branches = ref<Branch[]>([])
  const loading = ref(false)

  async function fetchBranches(projectId: string) {
    loading.value = true
    try {
      const res = await branchApi.list(projectId)
      branches.value = res.data || []
    } finally {
      loading.value = false
    }
  }

  async function createBranch(projectId: string, name: string, checkout = false) {
    await branchApi.create(projectId, name, checkout)
    await fetchBranches(projectId)
  }

  async function checkoutBranch(projectId: string, branch: string) {
    await branchApi.checkout(projectId, branch)
    await fetchBranches(projectId)
  }

  async function deleteBranch(projectId: string, name: string, force = false) {
    await branchApi.delete(projectId, name, force)
    await fetchBranches(projectId)
  }

  async function mergeBranch(projectId: string, source: string, strategy?: string, message?: string) {
    await branchApi.merge(projectId, source, strategy, message)
    await fetchBranches(projectId)
  }

  const localBranches = computed(() => branches.value.filter((b) => !b.isRemote))
  const remoteBranches = computed(() => branches.value.filter((b) => b.isRemote))

  return {
    branches,
    loading,
    fetchBranches,
    createBranch,
    checkoutBranch,
    deleteBranch,
    mergeBranch,
    localBranches,
    remoteBranches,
  }
})
