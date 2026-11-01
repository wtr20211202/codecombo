import { defineStore } from 'pinia'
import { ref } from 'vue'
import { updateApi, settingsApi } from '../api/client'
import { useInstanceStore } from './instance'
import { useNotificationStore } from './notification'
import i18n from '../i18n'
import { safeStorage } from '../utils/storage'
import { isNewerVersion } from '../utils/version'

// 更新可用性检查中心（业界主流模式：启动/周期性静默检查 → 版本入口角标 +
// 每版本一次通知 → 用户自行决定是否更新，绝不自动安装）：
//   github → 本机更新分发源（/api/updates/check，需已配置 updateURL）
//   center → 所属中心实例的当前版本（实例健康探测带回的版本做 semver 对比）
// 两条路径互不影响；检查失败静默（未配源/网络不可达不打扰），
// 发现更新按「路径 + 版本」去重通知（localStorage 记录已提醒版本）。

// 启动后延迟首查：避开首屏请求高峰；周期默认 6 小时（Chrome/VS Code 量级）
const AUTO_CHECK_FIRST_DELAY_MS = 5000
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export const useUpdateCheckStore = defineStore('updateCheck', () => {
  // github：分发源检查结果；center：所属中心有更新的版本号（null=无更新/不可知）
  const github = ref<{ hasUpdate: boolean; latestVersion: string } | null>(null)
  const center = ref<{ version: string } | null>(null)
  const checking = ref(false)

  let started = false
  let timer: ReturnType<typeof setInterval> | null = null

  function notifyOnce(source: 'github' | 'center', version: string) {
    if (!version) return
    const key = `updateNotified.${source}`
    if (safeStorage.getItem(key) === version) return
    safeStorage.setItem(key, version)
    useNotificationStore().add({
      type: 'info',
      category: 'system',
      title: i18n.global.t('update.updateAvailableTitle'),
      body: `v${version}`,
    })
  }

  // 分发源检查：未配置 updateURL / GitHub 不可达时静默失败
  async function checkGithub(silent = true) {
    try {
      const res: any = await updateApi.check({ silent })
      const data = res?.data || res || {}
      github.value = { hasUpdate: !!data.hasUpdate, latestVersion: data.latestVersion || '' }
      if (github.value.hasUpdate) notifyOnce('github', github.value.latestVersion)
    } catch { /* 静默 */ }
  }

  // 中心检查：本机当前版本 vs 所属中心实例的健康探测版本。
  // 本机版本来自 settings（实例列表接口不出本机 version）；中心版本来自
  // checkBatch 探测（TTL 内复用，不制造探测风暴）。任一版本未知则不判定
  async function checkCenter(_silent = true) {
    try {
      const res: any = await settingsApi.get({ silent: true })
      const localVersion = res?.data?.version || ''
      await useInstanceStore().ensureInstancesFresh()
      const insts = useInstanceStore().instances
      const local = insts.find(i => i.isLocal)
      const parent = local?.parentId ? insts.find(i => i.id === local.parentId) : undefined
      if (!localVersion || !parent?.version) {
        center.value = null
        return
      }
      if (isNewerVersion(parent.version, localVersion)) {
        center.value = { version: parent.version }
        notifyOnce('center', parent.version)
      } else {
        center.value = null
      }
    } catch { /* 静默 */ }
  }

  async function checkAll(silent = true) {
    if (checking.value) return
    checking.value = true
    try {
      await Promise.allSettled([checkGithub(silent), checkCenter(silent)])
    } finally {
      checking.value = false
    }
  }

  // 启动周期性静默检查（App 挂载时调用一次，幂等）
  function startAutoCheck() {
    if (started) return
    started = true
    setTimeout(() => { void checkAll(true) }, AUTO_CHECK_FIRST_DELAY_MS)
    timer = setInterval(() => { void checkAll(true) }, AUTO_CHECK_INTERVAL_MS)
  }

  function stopAutoCheck() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    started = false
  }

  return {
    github, center, checking,
    checkGithub, checkCenter, checkAll,
    startAutoCheck, stopAutoCheck,
  }
})
