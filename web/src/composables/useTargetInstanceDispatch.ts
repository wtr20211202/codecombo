import { computed, ref } from 'vue'
import type { Ref } from 'vue'
import { useMessage } from 'naive-ui'
import { useI18n } from '@/composables/useI18n'
import { instanceApi } from '@/api/client'
import type { Instance } from '@/stores/instance'
import { useInstanceStore } from '@/stores/instance'

/**
 * 新建会话对话框的目标实例域状态（自 NewSessionDialog 按表单区拆分，纯搬运
 * 零逻辑改动，P-20261004-101 联邦派发）：'local' = 本实例直建（既有路径）；
 * 其余值 = 注册实例 id → dispatch 转发创建。实例可用态徽标：online 后缀 ●，
 * offline/invalid 后缀原因并禁用——派发必失败的入口直接给不可选反馈
 * （unknown = 尚未探测，放行由服务端裁决）；状态文案复用 instance.status* 既有键。
 */
export interface DispatchPayloadRefs {
  name: Ref<string>
  runtime: Ref<string>
  dir: Ref<string>
  /** 组装后的任务指令（promptAssembly.text；空串不携带保持既有请求形状） */
  launchArgsText: () => string
  /** 派发成功同样是创建成功：清草稿（P-20261004-89） */
  clearDraft: () => void
  /** 成功反馈后关弹层 */
  close: () => void
}

export function useTargetInstanceDispatch(payload: DispatchPayloadRefs) {
  const { t } = useI18n()
  const message = useMessage()
  const instanceStore = useInstanceStore()

  // 'local' = 本实例直建（既有路径）；其余值 = 注册实例 id → dispatch 转发创建
  const LOCAL_INSTANCE = 'local'
  const targetInstance = ref<string>(LOCAL_INSTANCE)

  /** 是否派发到从实例（转发创建路径） */
  const dispatching = computed(() => targetInstance.value !== LOCAL_INSTANCE)

  /** 实例可用态徽标：online 后缀 ●，offline/invalid 后缀原因并禁用——
   *  派发必失败的入口直接给不可选反馈（unknown = 尚未探测，放行由服务端裁决）；
   *  状态文案复用 instance.status* 既有键 */
  function instanceOptionLabel(i: Instance): string {
    if (i.status === 'online') return `${i.name} ●`
    if (i.status === 'offline') return `${i.name}（${t('instance.statusOffline')}）`
    if (i.status === 'invalid') return `${i.name}（${t('instance.statusInvalid')}）`
    return i.name
  }

  const targetInstanceOptions = computed(() => [
    { label: t('agentTerminal.targetInstance.local'), value: LOCAL_INSTANCE },
    ...instanceStore.instances
      .filter(i => !i.isLocal)
      .map(i => ({
        label: instanceOptionLabel(i),
        value: i.id,
        disabled: i.status === 'offline' || i.status === 'invalid',
      })),
  ])

  function instanceDisplayName(id: string): string {
    if (id === LOCAL_INSTANCE) return t('agentTerminal.targetInstance.local')
    return instanceStore.instances.find(i => i.id === id)?.name || id
  }

  /** 联邦派发（P-20261004-101）：POST /api/instances/:id/dispatch 转发创建。
   *  对端 400 预检原文透传（KNOWN_ERROR_I18N 跨实例同文案，拦截器已 toast），
   *  弹层与已填内容保留供修正重试；成功反馈就地呈现并关弹层 */
  async function dispatchRemote(): Promise<void> {
    try {
      // 45s 请求超时：服务端最坏 20s×2（scheme 翻转重试）+ 对端创建耗时，
      // axios 默认 30s 会先到——派发是跨机慢路径，调用侧给足
      const res = await instanceApi.dispatch(targetInstance.value, {
        name: payload.name.value.trim() || undefined,
        runtime: payload.runtime.value,
        dir: payload.dir.value.trim() || undefined,
        ...(payload.launchArgsText() ? { launchArgs: payload.launchArgsText() } : {}),
      }, { timeout: 45_000 })
      const r = res.data
      if (!r) {
        message.error(t('agentTerminal.dispatchFailed'))
        return
      }
      message.success(t('agentTerminal.dispatched', {
        instance: instanceDisplayName(targetInstance.value),
        session: r.remoteSessionName,
      }))
      payload.clearDraft() // 派发成功同样是创建成功：清草稿（P-20261004-89）
      payload.close()
    } catch {
      // 拦截器已弹映射文案；保持弹层打开可修正重试
    }
  }

  return {
    LOCAL_INSTANCE,
    targetInstance,
    dispatching,
    targetInstanceOptions,
    instanceDisplayName,
    dispatchRemote,
  }
}
