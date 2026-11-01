import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AxiosRequestConfig } from 'axios'
import { projectApi, commitApi, diffApi, snapshotApi } from '../api/client'

export interface FileStatus {
  path: string
  status: string // Modified, Added, Deleted, Untracked, Renamed
  staged: boolean
  oldPath?: string
}

export const useChangesStore = defineStore('changes', () => {
  const files = ref<FileStatus[]>([])
  const loading = ref(false)
  const selectedFile = ref<string>('')
  const diffContent = ref<string>('')
  const diffLoading = ref(false)
  // 三路对比模式开关，仅开启时才预加载 HEAD 内容
  const threeWayEnabled = ref(false)
  const headContent = ref<string>('')
  const stagedContent = ref<string>('')
  const workingContent = ref<string>('')
  // 提交消息草稿：跨组件实例共享，避免面板位置切换时丢失输入
  const commitMessage = ref('')

  async function fetchStatus(projectId: string) {
    loading.value = true
    try {
      const res = await projectApi.status(projectId)
      files.value = res.data || []
    } finally {
      loading.value = false
    }
  }

  async function stageFiles(projectId: string, filePaths: string[]) {
    await commitApi.stage(projectId, filePaths)
    await fetchStatus(projectId)
  }

  async function unstageFiles(projectId: string, filePaths: string[]) {
    await commitApi.unstage(projectId, filePaths)
    await fetchStatus(projectId)
  }

  async function commit(projectId: string, message: string, files?: string[], amend?: boolean, signoff?: boolean, author?: string, config?: AxiosRequestConfig) {
    await commitApi.commit(projectId, message, files, amend, signoff, author, config)
    await fetchStatus(projectId)
  }

  async function rollback(projectId: string, filePaths: string[]) {
    await commitApi.rollback(projectId, filePaths)
    await fetchStatus(projectId)
  }

  async function fetchFileDiff(projectId: string, file: string, staged?: boolean) {
    selectedFile.value = file
    diffLoading.value = true
    // 重置三路内容
    headContent.value = ''
    stagedContent.value = ''
    workingContent.value = ''
    try {
      // 主diff和HEAD内容并行请求，避免串行等待
      if (threeWayEnabled.value) {
        const [diffRes, headRes] = await Promise.allSettled([
          diffApi.getFileDiff(projectId, file, staged),
          snapshotApi.showFile(projectId, 'HEAD', file),
        ])
        diffContent.value = diffRes.status === 'fulfilled' ? (diffRes.value as any).data || '' : ''
        headContent.value = headRes.status === 'fulfilled' ? (headRes.value as any).data || '' : ''
        stagedContent.value = headContent.value
      } else {
        const res = await diffApi.getFileDiff(projectId, file, staged)
        diffContent.value = res.data || ''
      }
    } finally {
      diffLoading.value = false
    }
  }

  // 按状态分组（使用 computed 缓存，避免模板中多次调用时重复 filter）
  const stagedFiles = computed(() => files.value.filter((f) => f.staged))
  const unstagedFiles = computed(() => files.value.filter((f) => !f.staged && f.status !== 'Untracked'))
  const untrackedFiles = computed(() => files.value.filter((f) => f.status === 'Untracked'))

  return {
    files,
    loading,
    selectedFile,
    diffContent,
    diffLoading,
    threeWayEnabled,
    headContent,
    stagedContent,
    workingContent,
    commitMessage,
    fetchStatus,
    stageFiles,
    unstageFiles,
    commit,
    rollback,
    fetchFileDiff,
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
  }
})
