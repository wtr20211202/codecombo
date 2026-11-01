import { defineStore } from 'pinia'
import { ref } from 'vue'
import { deployConfigApi, deployApi, type DeployConfig, type DeployerInfo, type PlatformBinary } from '../api/client'

// axios interceptor 已展平 AxiosResponse，运行时返回 server body 本身
type Resp<T> = { data?: T }

export const useDeployConfigStore = defineStore('deployConfig', () => {
  const config = ref<DeployConfig | null>(null)
  const deployers = ref<DeployerInfo[]>([])
  const binaries = ref<PlatformBinary[]>([])
  const loading = ref(false)

  async function fetchConfig() {
    const res = (await deployConfigApi.get()) as unknown as Resp<DeployConfig>
    config.value = res.data || null
  }

  async function updateConfig(input: Partial<{
    anthropicToken: string
    anthropicBaseUrl: string
    model: string
    binaryDir: string
  }>) {
    await deployConfigApi.update(input)
    await fetchConfig()
  }

  async function fetchDeployers() {
    const res = (await deployApi.listDeployers()) as unknown as Resp<DeployerInfo[]>
    deployers.value = res.data || []
  }

  async function fetchBinaries() {
    loading.value = true
    try {
      const res = (await deployApi.scanBinaries()) as unknown as Resp<PlatformBinary[]>
      binaries.value = res.data || []
    } finally {
      loading.value = false
    }
  }

  return {
    config,
    deployers,
    binaries,
    loading,
    fetchConfig,
    updateConfig,
    fetchDeployers,
    fetchBinaries,
  }
})
