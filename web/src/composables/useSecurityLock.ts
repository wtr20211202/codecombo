// 设置页"全局锁定"分区的全部逻辑：配置读写、密码确认弹窗、修改密码、立即锁定
import { ref, reactive, computed } from 'vue'
import { NInput, useMessage, useDialog } from 'naive-ui'
import { h } from 'vue'
import { useI18n } from 'vue-i18n'
import { lockApi, type LockConfig } from '@/api/lock'
import { useLockStore } from '@/stores/lock'

export function useSecurityLock() {
  const { t } = useI18n()
  const message = useMessage()
  const dialog = useDialog()
  const lockStore = useLockStore()

  // 锁定配置：双份比对，dirty 检测用
  const lockConfig = reactive<LockConfig>({
    enabled: true,
    autoLockEnabled: true,
    autoLockMinutes: 120,
    tokenTTLMinutes: 120,
  })
  const originalConfig = ref<LockConfig | null>(null)

  // 修改密码表单
  const pwdForm = reactive({ current: '', newPwd: '', confirm: '' })

  // 配置 dirty：任一字段变化即 true
  const configDirty = computed(() => {
    if (!originalConfig.value) return false
    return (
      lockConfig.enabled !== originalConfig.value.enabled ||
      lockConfig.autoLockEnabled !== originalConfig.value.autoLockEnabled ||
      lockConfig.autoLockMinutes !== originalConfig.value.autoLockMinutes ||
      lockConfig.tokenTTLMinutes !== originalConfig.value.tokenTTLMinutes
    )
  })

  const pwdMismatch = computed(() =>
    pwdForm.confirm !== '' && pwdForm.newPwd !== pwdForm.confirm,
  )

  const canChangePassword = computed(() =>
    pwdForm.current !== '' && pwdForm.newPwd !== '' &&
    pwdForm.confirm !== '' && !pwdMismatch.value,
  )

  // 拉取锁定配置（静默失败：未解锁或后端未启动时不报错）
  async function loadLockConfig() {
    try {
      const cfg = await lockApi.getConfig()
      Object.assign(lockConfig, cfg)
      originalConfig.value = { ...cfg }
    } catch { /* 拦截器处理 */ }
  }

  // 切换"启用全局锁定"：关闭时需要二次密码确认
  function onToggleEnabled(value: boolean) {
    if (!value) {
      dialog.warning({
        title: t('lock.settings.confirmDisable'),
        content: t('lock.settings.confirmDisableDesc'),
        positiveText: t('common.confirm'),
        negativeText: t('common.cancel'),
        onPositiveClick: async () => {
          const password = await promptPassword()
          if (!password) return
          try {
            await lockApi.updateConfig({ enabled: false }, password)
            lockConfig.enabled = false
            originalConfig.value = { ...lockConfig }
            // 服务端 RevokeAllTokens，前端切锁定页
            await lockStore.lock()
          } catch { /* 拦截器处理 */ }
        },
      })
    } else {
      lockConfig.enabled = true
    }
  }

  // 通用：弹窗收集当前密码（保存配置/关闭功能/改密码场景复用）
  function promptPassword(): Promise<string | null> {
    return new Promise(resolve => {
      let value = ''
      dialog.warning({
        title: t('lock.settings.currentPassword'),
        content: () => h(NInput, {
          value,
          type: 'password',
          'show-password-on': 'click',
          placeholder: t('lock.settings.currentPassword'),
          'onUpdate:value': (v: string) => { value = v },
        }),
        positiveText: t('common.confirm'),
        negativeText: t('common.cancel'),
        onPositiveClick: () => resolve(value || null),
        onNegativeClick: () => resolve(null),
      })
    })
  }

  // 保存配置：必须输入当前密码确认
  async function saveConfig() {
    const password = await promptPassword()
    if (!password) return
    try {
      await lockApi.updateConfig(
        {
          enabled: lockConfig.enabled,
          autoLockEnabled: lockConfig.autoLockEnabled,
          autoLockMinutes: lockConfig.autoLockMinutes,
          tokenTTLMinutes: lockConfig.tokenTTLMinutes,
        },
        password,
      )
      originalConfig.value = { ...lockConfig }
      // 服务端写成功后对账既有闲置定时器（P-20261008-13）：关 autoLock/关功能
      // 必须立即取消已武装的定时器，否则「保存成功仍在 N 分钟后被回锁」；
      // 开启/改时长则按新值重排。state 镜像同步后，下次解锁取新值
      lockStore.syncAutoLockConfig({
        enabled: lockConfig.enabled,
        autoLockEnabled: lockConfig.autoLockEnabled,
        autoLockMinutes: lockConfig.autoLockMinutes,
      })
      message.success(t('lock.settings.configUpdated'))
    } catch { /* 拦截器处理 */ }
  }

  // 修改密码：成功后服务端 RevokeAllTokens，前端切锁定页
  async function changePassword() {
    try {
      await lockApi.updatePassword(pwdForm.current, pwdForm.newPwd)
      message.success(t('lock.settings.passwordChanged'))
      pwdForm.current = ''
      pwdForm.newPwd = ''
      pwdForm.confirm = ''
      await lockStore.lock()
    } catch { /* 拦截器处理 */ }
  }

  // 立即锁定：直接调用 store.lock()
  async function lockNow() {
    await lockStore.lock()
  }

  return {
    lockStore,
    lockConfig,
    pwdForm,
    configDirty,
    pwdMismatch,
    canChangePassword,
    loadLockConfig,
    onToggleEnabled,
    saveConfig,
    changePassword,
    lockNow,
  }
}
