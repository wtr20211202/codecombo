import { defineStore } from 'pinia'
import { ref, watch, type WatchStopHandle } from 'vue'
import { updateApi, settingsApi } from '../api/client'
import { useInstanceStore } from './instance'
import { useNotificationStore } from './notification'
import { useLockStore } from './lock'
import i18n from '../i18n'
import { safeStorage } from '../utils/storage'
import { isNewerVersion } from '../utils/version'

// 更新可用性检查中心（业界主流模式：启动/周期性静默检查 → 版本入口角标 +
// 每版本一次通知 → 用户自行决定是否更新，绝不自动安装）：
//   github → 本机更新分发源（/api/updates/check，需已配置 updateURL）
//   center → 所属中心实例的当前版本（实例健康探测带回的版本做 semver 对比）
// 两条路径互不影响；检查失败静默（未配源/网络不可达不打扰），
// 发现更新按「路径 + 版本」去重通知（localStorage 记录已提醒版本）。
// 本 store 是前端唯一的自动检查电路（首页挂载即查的旁路已并入，P-20261109-6）。
//
// 开关门控（P-20261109-6）：周期电路受「自动检查更新」开关（服务端 settings
// updateChecks，版本面板开关）门控，与服务端 24h 定时检查同一开关同一语义——
// 关 = 停表、零自动检查请求（手动检查与面板内按需复评不受影响）；开 = 按冷启动
// 节律重新起表（5s 首查 + 6h 周期）。热切换即时生效（服务端 ApplySource 同款）：
// 本页保存同帧应用（applyAutoCheckSetting）/ 他端与 agent 改动经 settings.changed
// 广播重读 / 解锁重读（锁定期 ops 通道断开，广播收不到）。每跳发检查请求前再
// 实读一次开关（服务端 autoCheck 每 tick 实读同款）——ops 通道断线窗口漏收广播
// 时，旧的「开」镜像也越不过开关承诺。

// 启动后延迟首查：避开首屏请求高峰；周期默认 6 小时（Chrome/VS Code 量级）
export const AUTO_CHECK_FIRST_DELAY_MS = 5000
export const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 开关读法与版本面板同口径：仅显式 false 为关（缺字段 = 旧服务端/出厂默认开） */
export function isAutoCheckOn(data: { updateChecks?: boolean } | null | undefined): boolean {
  return data?.updateChecks !== false
}

export const useUpdateCheckStore = defineStore('updateCheck', () => {
  // github：分发源检查结果；center：所属中心有更新的版本号（null=无更新/不可知）
  const github = ref<{ hasUpdate: boolean; latestVersion: string } | null>(null)
  const center = ref<{ version: string } | null>(null)
  const checking = ref(false)
  // 「自动检查更新」开关镜像：null = 尚未读到（首读在解锁后）
  const autoCheckEnabled = ref<boolean | null>(null)

  // started = App 已表达「本页自动检查」意图（startAutoCheck）；真正起表看 reconcile
  let started = false
  let firstTimer: ReturnType<typeof setTimeout> | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let stopLockWatch: WatchStopHandle | null = null
  // 开关写入序号：本页保存 / 广播与解锁重读 / 每跳实读多路写镜像，晚到的旧读数
  // 不得覆盖更新的值（读在途时本页刚保存「关」，旧读数「开」回来不能把表重新起上）
  let settingSeq = 0

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

  // ---- 自动检查电路（开关门控，P-20261109-6） ----

  function isArmed(): boolean {
    return firstTimer !== null || timer !== null
  }

  function arm() {
    firstTimer = setTimeout(() => {
      firstTimer = null
      void autoTick()
    }, AUTO_CHECK_FIRST_DELAY_MS)
    timer = setInterval(() => { void autoTick() }, AUTO_CHECK_INTERVAL_MS)
  }

  function disarm() {
    if (firstTimer) {
      clearTimeout(firstTimer)
      firstTimer = null
    }
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  // 起停表对账。停表只看开关：关即停（锁定不停表——周期节律不因锁屏重置，锁定期
  // 各跳自行跳过）。起表还须已解锁：首查不落进锁定期被 423 吞掉，解锁时补起。
  // 开关未知（首读在途/读失败）照常起表：每跳先实读，读不到不发检查请求（autoTick）
  function reconcile() {
    if (!started || autoCheckEnabled.value === false) {
      disarm()
      return
    }
    if (!isArmed() && !useLockStore().isLocked) arm()
  }

  // 实读开关并对账起停表。skipInflightDedupe：广播/解锁重读都是「读后写」场景，
  // 不得并入写前发起的同键在途 GET 拿回旧快照（http.ts in-flight 去重的豁免口）。
  // 读失败（网络/锁定 423）静默保持镜像——下一跳/下次广播/下次解锁再读
  async function syncAutoCheckSetting(): Promise<void> {
    const seq = ++settingSeq
    try {
      const res = (await settingsApi.get({ silent: true, skipInflightDedupe: true })) as unknown as {
        data?: { updateChecks?: boolean }
      }
      if (seq !== settingSeq) return
      autoCheckEnabled.value = isAutoCheckOn(res?.data)
      reconcile()
    } catch { /* 静默 */ }
  }

  // 本页确知的新值（版本面板保存成功）同帧应用：不等 settings.changed 广播往返
  //（ops 通道断线时广播不到达，「开」会迟迟不恢复）
  function applyAutoCheckSetting(on: boolean) {
    settingSeq++
    autoCheckEnabled.value = on
    reconcile()
  }

  // 单跳：锁定期不打请求（/api/settings 与检查端点皆 423）；先实读开关，仍为开
  // 且仍在表（读期间未被关闭/停表）才发检查请求。读失败时镜像不变：未知（null）
  // 不发，「最后已知为开」照发（检查本身失败同样静默）
  async function autoTick() {
    if (useLockStore().isLocked) return
    await syncAutoCheckSetting()
    if (autoCheckEnabled.value !== true || !isArmed()) return
    await checkAll(true)
  }

  // 启动周期性静默检查（App 挂载时调用一次，幂等）：表达意图，起表受开关门控。
  // 开关首读与每次解锁重读挂在锁态上：锁定期 /api/settings 必 423，且 ops 通道
  // 随锁断开、锁定期间他端改开关的广播收不到
  function startAutoCheck() {
    if (started) return
    started = true
    const lock = useLockStore()
    stopLockWatch = watch(() => lock.isLocked, (locked) => {
      if (locked) return
      reconcile()
      void syncAutoCheckSetting()
    }, { immediate: true })
  }

  function stopAutoCheck() {
    started = false
    if (stopLockWatch) {
      stopLockWatch()
      stopLockWatch = null
    }
    disarm()
  }

  return {
    github, center, checking, autoCheckEnabled,
    checkGithub, checkCenter, checkAll,
    startAutoCheck, stopAutoCheck,
    syncAutoCheckSetting, applyAutoCheckSetting,
  }
})
