import { h, ref } from 'vue'
import { useDialog, useMessage } from 'naive-ui'
import { useI18n } from './useI18n'
import { syncApi } from '../api/domains/sync'
import { useInstanceStore } from '../stores/instance'

// 文件树右键「同步到其他实例…」（P-20261023-1 方案④）：非项目目录/文件的
// 轻投递入口——选对端 + 目标相对路径即走 /api/sync/deliver 纯落位（不注册
// 项目），常用于交付脚本/配置样例。对话框形态与 useBranchCheckout 确认链
// 同款（useDialog + h() 自绘表单，在线实例才可选）。

export function useSyncDeliver(): { openSyncDeliver: (projectId: string, relPath: string, name: string, isDir: boolean) => unknown } {
  const dialog = useDialog()
  const message = useMessage()
  const { t } = useI18n()
  const instanceStore = useInstanceStore()

  const delivering = ref(false)

  return {
    openSyncDeliver,
  }

  /** 打开轻投递对话框。entry = { relPath, name, isDir }（项目相对路径正斜杠） */
  function openSyncDeliver(projectId: string, relPath: string, name: string, isDir: boolean) {
    const peerId = ref('')
    const dest = ref(name)
    void instanceStore.fetchInstances()
    const peers = () => instanceStore.instances.filter(i => !i.isLocal && i.status === 'online')

    const d = dialog.create({
      title: t('sync.deliverTitle', { name }),
      content: () => h('div', { style: 'display:flex;flex-direction:column;gap:10px;font-size:12px;' }, [
        h('div', { style: 'color:var(--text-secondary)' }, t('sync.deliverHint')),
        h('label', { style: 'display:flex;flex-direction:column;gap:4px;' }, [
          h('span', null, t('sync.deliverPeer')),
          h('select', {
            value: peerId.value,
            onChange: (e: Event) => { peerId.value = (e.target as HTMLSelectElement).value },
            style: 'padding:4px 6px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);',
          }, [
            h('option', { value: '' }, t('sync.deliverPickPeer')),
            ...peers().map(i => h('option', { value: i.id }, i.name)),
          ]),
        ]),
        h('label', { style: 'display:flex;flex-direction:column;gap:4px;' }, [
          h('span', null, t('sync.deliverDest')),
          h('input', {
            value: dest.value,
            onInput: (e: Event) => { dest.value = (e.target as HTMLInputElement).value },
            placeholder: isDir ? 'scripts/toolbox' : 'scripts/deploy.sh',
            style: 'padding:4px 6px;border:1px solid var(--border-color);border-radius:4px;background:var(--bg-primary);color:var(--text-primary);',
          }),
          h('span', { style: 'color:var(--text-tertiary);font-size:11px;' }, t('sync.deliverDestHint')),
        ]),
      ]),
      positiveText: t('sync.deliverGo'),
      negativeText: t('common.cancel'),
      onPositiveClick: async () => {
        if (!peerId.value) {
          message.warning(t('sync.selectPeerFirst'))
          return false
        }
        if (delivering.value) return false // 在途防双击重复投递
        const target = dest.value.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
        if (!target || target.includes('..')) {
          message.warning(t('sync.deliverDestInvalid'))
          return false
        }
        delivering.value = true
        try {
          await syncApi.deliver({ instanceId: peerId.value, projectId, relPath, dest: target })
          message.success(t('sync.deliverDone', { name }))
        } catch {
          message.error(t('sync.deliverFailed'))
          return false
        } finally {
          delivering.value = false
        }
        return true
      },
    })
    return d
  }
}
