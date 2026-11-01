import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { settingsApi } from '../api/client'
import { useI18n } from '../composables/useI18n'
import { copyText } from '../utils/clipboard'

/**
 * 首页版本信息：后台拉取构建信息 + 弹窗开关 + commit 复制。
 * 失败静默（buildInfo 为 null 时入口不显示）。从 HomeView.vue 抽出。
 */
export function useHomeBuildInfo() {
  const { t } = useI18n()
  const message = useMessage()

  const buildInfo = ref<{
    version: string
    commit: string
    buildTime: string
    goVersion: string
    platform: string
  } | null>(null)
  const showVersionModal = ref(false)

  async function fetchBuildInfo() {
    try {
      // 后台启动请求：失败仅写 Console，不打扰用户
      const res: any = await settingsApi.get({ silent: true })
      buildInfo.value = {
        version: res.data?.version || 'dev',
        commit: res.data?.commit || 'none',
        buildTime: res.data?.buildTime || 'unknown',
        goVersion: res.data?.goVersion || '',
        platform: res.data?.platform || '',
      }
    } catch { /* silent */ }
  }

  async function copyCommitId() {
    if (buildInfo.value?.commit) {
      const ok = await copyText(buildInfo.value.commit)
      if (ok) message.success(t('settings.copied'))
      else message.error(t('common.copyFailed'))
    }
  }

  return { buildInfo, showVersionModal, fetchBuildInfo, copyCommitId }
}
