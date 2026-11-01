import { ref } from 'vue'

/**
 * 与 HEAD 对比状态（自 CommitsPanel.vue 抽出）：
 * 给定 base commit hash，拉取 base→HEAD 的变更文件列表。
 */
export function useCommitCompare(
  currentProjectId: () => string,
  contextHash: () => string,
  listFiles: (pid: string, hash: string) => Promise<{ data?: unknown }>,
) {
  const compareBaseHash = ref('')
  const compareFiles = ref<Array<{ path: string; name: string; status: string }>>([])
  const compareLoading = ref(false)

  async function open() {
    const hash = contextHash()
    if (!currentProjectId() || !hash) return
    compareBaseHash.value = hash
    compareLoading.value = true
    compareFiles.value = []
    try {
      const res: any = await listFiles(currentProjectId(), hash)
      compareFiles.value = (res.data || []).map((f: any) => ({
        path: typeof f === 'string' ? f : f.path ?? '',
        name: (typeof f === 'string' ? f : f.path || '').split('/').pop() || '',
        status: f.status || '',
      }))
    } catch { /* 拦截器处理 */ } finally {
      compareLoading.value = false
    }
  }

  function close() {
    compareBaseHash.value = ''
    compareFiles.value = []
  }

  return { compareBaseHash, compareFiles, compareLoading, open, close }
}
