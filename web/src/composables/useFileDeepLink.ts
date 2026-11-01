import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useI18n } from './useI18n'
import { copyText } from '../utils/clipboard'
import { buildFileDeepLinkQuery } from '../utils/presentAtoms'

/**
 * 编辑器「复制文件链接」（P-20261002-49）：拼当前 origin + /project?project=<id>
 * &file=<项目相对路径> 深链入剪贴板。对方（或跨设备的自己）打开链接即直达编辑器
 * 激活该文件（消费端 useLayoutViews.consumeFileQuery：项目就绪后先行切项目再打开）。
 * 路径反斜杠归一为 / ——URL 语义跨平台一致，消费端 openFileByPath 直接可用。
 * EditorGroupPane tab 右键直调本组合式（不走 emit 链，同 useEditorAskAgent 口径）。
 * query 拼装收口 utils/presentAtoms.buildFileDeepLinkQuery（P-20261022-3：产出
 * 与消费同参同形 + 与服务端深链表镜像对账）
 */
export function useFileDeepLink() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useEditorAskAgent 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 复制当前文件的深链（project id 必带：跨设备打开时消费端先行切到该项目） */
  async function copyFileLink(path: string): Promise<void> {
    const pid = projectStore.currentProjectId
    if (!pid || !path) return
    const rel = path.replace(/\\/g, '/')
    const link =
      `${window.location.origin}/project?` +
      new URLSearchParams(buildFileDeepLinkQuery({ file: rel, project: pid })).toString()
    if (await copyText(link)) {
      message.success(t('layout.copyFileLinkDone'))
    } else {
      message.error(t('common.copyFailed'))
    }
  }

  return { copyFileLink }
}
