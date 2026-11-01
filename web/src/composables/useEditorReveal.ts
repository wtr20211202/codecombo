import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useI18n } from './useI18n'
import { projectApi } from '../api/client'
import { AppError } from '../api/error-types'

/**
 * 编辑器 tab 右键「在系统中显示」（P-20261003-323）：调服务端 reveal 端点，
 * 在实例宿主的系统文件管理器中定位目标文件（win explorer /select、mac open -R、
 * linux xdg-open 退化目录语义；headless 无显示环境 501 明确报错）。
 * 成功反馈 = 宿主文件管理器窗口本身（不叠加 toast）；失败走拦截器
 * KNOWN_ERROR 映射。EditorGroupPane tab 右键直调本组合式（不走 emit 链，
 * 同 useEditorCopyPath 口径）
 */
export function useEditorReveal() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useFileDeepLink 同范式）：仅 501/headless 场景需要带一条
  // 可行动提示（拦截器 toast 之外补「为什么没有窗口弹出」的说明）
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 在系统文件管理器中显示文件（服务端打开宿主窗口） */
  async function revealInSystem(path: string): Promise<void> {
    const pid = projectStore.currentProjectId
    const rel = path.replace(/\\/g, '/')
    if (!pid || !rel) return
    try {
      await projectApi.revealInSystem(pid, rel)
    } catch (err) {
      // headless 501：拦截器已映射通用提示，此处补一句语义说明
      if (err instanceof AppError && err.status === 501) message.info(t('files.reveal.headless'))
      // 其余失败拦截器处理（Console 照常留痕）
    }
  }

  return { revealInSystem }
}
