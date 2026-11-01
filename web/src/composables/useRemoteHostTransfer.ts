import { ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { useRemoteHostStore } from '../stores/remoteHost'
import { remoteHostApi } from '../api/client'
import { promptDialog } from './useDialog'
import { isWeakExportPassphrase } from '../utils/passStrength'

// 远程主机导入 / 导出（自 RemoteConsoleView 原样搬运，P-20261002-27）：
// 换机迁移与备份；导出文件为口令加密信封，导入兼容旧版明文数组。
// 文件选择 input 由宿主（RemoteConsoleHeader 工具条）持有，选中后经
// onImportFile(File) 进入本管线。
export function useRemoteHostTransfer() {
  const { t } = useI18n()
  const message = useMessage()
  const remoteHostStore = useRemoteHostStore()

  const importing = ref(false)

  /** 信封格式标识，与后端 config.EnvelopeFormat 一致 */
  const ENVELOPE_FORMAT = 'simple-coding.crypt-envelope'

  async function exportHosts() {
    // 口令两次输入防手误；validate 不通过时 promptDialog 自身拦截并提示。
    // 弱口令实时警示（P-20261003-101）：黄色提示不阻断——自托管用户自由度，
    // 警示后仍可继续导出（8 位下限仍由 validate 把关）；强口令零提示零打扰
    const pass = await promptDialog({
      title: t('remoteConsole.exportPassTitle'),
      label: t('remoteConsole.exportPassHint'),
      placeholder: t('remoteConsole.passPlaceholder'),
      inputType: 'password',
      validate: (v) => (v.length >= 8 ? null : t('remoteConsole.passTooShort')),
      liveHint: (v) => (isWeakExportPassphrase(v) ? { text: t('remoteConsole.exportPassWeakHint'), type: 'warning' } : null),
    })
    if (pass === null) return
    const pass2 = await promptDialog({
      title: t('remoteConsole.exportPassTitle'),
      label: t('remoteConsole.exportPassConfirmHint'),
      placeholder: t('remoteConsole.passConfirmPlaceholder'),
      inputType: 'password',
      validate: (v) => (v === pass ? null : t('remoteConsole.passMismatch')),
    })
    if (pass2 === null) return
    try {
      const blob = await remoteHostApi.exportAll(pass) as unknown as Blob
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `remotehosts-export-${new Date().toISOString().slice(0, 10)}.json`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 10_000)
      message.warning(t('remoteConsole.exportWarn'))
    } catch (e: unknown) {
      const err = e as { rawMessage?: string; message?: string; userMessage?: string }
      message.error(err?.userMessage || t('remoteConsole.exportFailed'))
    }
  }

  async function onImportFile(file?: File | null) {
    if (!file) return
    let parsed: unknown
    try {
      parsed = JSON.parse(await file.text())
    } catch {
      message.error(t('remoteConsole.importFailed'))
      return
    }
    if (Array.isArray(parsed)) {
      // 旧版明文导出：直接导入（向后兼容）
      await doImport(parsed)
      return
    }
    if (parsed && typeof parsed === 'object' && (parsed as { format?: string }).format === ENVELOPE_FORMAT) {
      // 加密信封：需输入导出时设置的口令解密
      const pass = await promptDialog({
        title: t('remoteConsole.importPassTitle'),
        label: t('remoteConsole.importPassHint'),
        placeholder: t('remoteConsole.passPlaceholder'),
        inputType: 'password',
        validate: (v) => (v ? null : t('remoteConsole.passRequired')),
      })
      if (pass === null) return
      await doImport(parsed, pass)
      return
    }
    message.error(t('remoteConsole.importFailed'))
  }

  async function doImport(file: unknown, passphrase?: string) {
    importing.value = true
    try {
      const res = await remoteHostApi.importAll(file, passphrase) as unknown as {
        data?: { imported?: number; legacy?: boolean; failed?: { name: string; error: string }[] }
      }
      const imported = res.data?.imported || 0
      const failed = res.data?.failed || []
      if (imported > 0) {
        message.success(t('remoteConsole.imported', { n: imported }))
        await remoteHostStore.fetch()
      }
      if (failed.length > 0) message.warning(t('remoteConsole.importPartial', { n: failed.length }))
      if (res.data?.legacy && imported > 0) message.info(t('remoteConsole.legacyImported'))
    } catch (e: any) {
      // userMessage 为拦截器本地化后的友好文案（含"口令错误"映射），兜底通用失败提示
      message.error(e?.userMessage || t('remoteConsole.importFailed'))
    } finally {
      importing.value = false
    }
  }

  return {
    importing,
    exportHosts,
    onImportFile,
  }
}
