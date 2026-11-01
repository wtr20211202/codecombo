import { defineStore } from 'pinia'
import { ref } from 'vue'
import { logApi, diffApi } from '../api/client'

export interface Commit {
  hash: string
  shortHash: string
  message: string
  author: string
  email: string
  date: string
  parents: string[]
  refs: string[]
  gpgStatus: string // G=good, B=bad, U=unknown, E=expired, N/empty=no signature
}

export interface CommitFile {
  path: string
  oldPath: string
  status: string
}

export const useLogStore = defineStore('log', () => {
  const commits = ref<Commit[]>([])
  const loading = ref(false)
  const selectedCommit = ref<string>('')
  const hasMore = ref(true)

  // 提交详情
  const commitFiles = ref<CommitFile[]>([])
  const commitDiff = ref<string>('')
  const commitDiffFile = ref<string>('')
  const detailLoading = ref(false)

  // 后端可能返回 null 而非 []
  function normalizeCommits(raw: unknown[]): Commit[] {
    return ((raw || []) as Array<Record<string, unknown>>).map((c) => ({
      ...c,
      parents: (c.parents as string[]) || [],
      refs: (c.refs as string[]) || [],
    } as unknown as Commit))
  }

  async function fetchLog(projectId: string, branch?: string, skip = 0, limit = 50) {
    loading.value = true
    try {
      const res = await logApi.getLog(projectId, { branch, limit, skip })
      const newCommits = normalizeCommits(res.data || [])
      if (skip === 0) {
        commits.value = newCommits
      } else {
        commits.value.push(...newCommits)
      }
      hasMore.value = newCommits.length >= limit
    } finally {
      loading.value = false
    }
  }

  async function searchLog(projectId: string, query: string) {
    loading.value = true
    try {
      const res = await logApi.search(projectId, query)
      commits.value = normalizeCommits(res.data || [])
    } finally {
      loading.value = false
    }
  }

  async function selectCommit(projectId: string, hash: string) {
    selectedCommit.value = hash
    commitDiff.value = ''
    commitDiffFile.value = ''
    detailLoading.value = true
    try {
      const res = await logApi.getCommitFiles(projectId, hash)
      commitFiles.value = res.data || []
    } finally {
      detailLoading.value = false
    }
  }

  // 直接从后端获取单文件diff，避免传输整个commit的完整diff再在客户端解析
  async function fetchCommitDiff(projectId: string, commit: string, file: string) {
    commitDiffFile.value = file
    detailLoading.value = true
    try {
      const res = await diffApi.getCommitDiff(projectId, commit, file)
      commitDiff.value = res.data || ''
    } finally {
      detailLoading.value = false
    }
  }

  function clearDetail() {
    selectedCommit.value = ''
    commitFiles.value = []
    commitDiff.value = ''
    commitDiffFile.value = ''
  }

  return {
    commits,
    loading,
    selectedCommit,
    hasMore,
    commitFiles,
    commitDiff,
    commitDiffFile,
    detailLoading,
    fetchLog,
    searchLog,
    selectCommit,
    fetchCommitDiff,
    clearDetail,
  }
})
