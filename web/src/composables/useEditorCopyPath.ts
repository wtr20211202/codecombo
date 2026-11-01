import { computed } from 'vue'
import { createDiscreteApi } from 'naive-ui'
import { useThemeStore } from '../stores/theme'
import { useProjectStore } from '../stores/project'
import { useI18n } from './useI18n'
import { copyText } from '../utils/clipboard'

/**
 * 编辑器 tab 右键「复制路径 / 复制文件名 / 复制绝对路径」（P-20261002-88）：
 * 把当前文件路径贴给 agent 或外部工具免手动拼。
 * - 相对路径反斜杠归一为 /（useFileDeepLink 同口径，跨平台一致）
 * - 绝对路径 = 项目根 + 相对路径（useFileTreeContext copy-abs 同款拼接：
 *   Windows 风格根（含 \）输出原生反斜杠；无项目根时不动作）
 * 「复制引用（路径:行）」（P-20261006-17）：精确定位形态，编辑器右键与 tab
 * 右键共用本实现（行号来源随入口不同，见两处调用点）
 * EditorGroupPane tab 右键直调本组合式（不走 emit 链，同 useEditorAskAgent 口径）
 */
export function useEditorCopyPath() {
  const projectStore = useProjectStore()
  const themeStore = useThemeStore()
  const { t } = useI18n()
  // 离散 message（useFileDeepLink 同范式）：本组合式在组件 setup 期调用一次，
  // 事件回调里发提示不依赖祖先 NMessageProvider
  const { message } = createDiscreteApi(['message'], {
    configProviderProps: computed(() => ({
      theme: themeStore.naiveTheme,
      themeOverrides: themeStore.naiveOverrides,
    })),
  })

  /** 复制项目相对路径（正斜杠归一） */
  async function copyFilePath(path: string): Promise<void> {
    const rel = path.replace(/\\/g, '/')
    if (!rel) return
    // copyText 带 execCommand 降级（非安全上下文下 navigator.clipboard 不可用）
    if (await copyText(rel)) {
      message.success(t('layout.pathCopied'))
    } else {
      message.error(t('common.copyFailed'))
    }
  }

  /** 复制文件名（路径末段） */
  async function copyFileName(path: string): Promise<void> {
    const name = path.replace(/\\/g, '/').split('/').pop() || ''
    if (!name) return
    if (await copyText(name)) {
      message.success(t('layout.fileNameCopied'))
    } else {
      message.error(t('common.copyFailed'))
    }
  }

  /** 复制绝对路径（项目根拼接；无项目根时不动作，同文件树 copy-abs 口径） */
  async function copyAbsoluteFilePath(path: string): Promise<void> {
    const root = (projectStore.currentProject?.path || '').replace(/[\\/]+$/, '')
    const rel = path.replace(/\\/g, '/')
    if (!root || !rel) return
    const sep = root.includes('\\') ? '\\' : '/'
    const abs = root + sep + rel.replace(/\//g, sep)
    if (await copyText(abs)) {
      message.success(t('layout.absPathCopied'))
    } else {
      message.error(t('common.copyFailed'))
    }
  }

  /** 复制引用（路径:行，P-20261006-17）：复制路径的精确定位形态——格式与 Quick
   *  Open 行号直达语法（utils/fileLineQuery 的消费格式）严格一致，粘贴进
   *  palette 即行级直达（「路径:行」直达生态的产出侧补位）。line 缺省/<1（无
   *  光标态：内容未装载过无 viewState 快照）降级纯路径——缺行号仍是 palette
   *  合法输入 */
  async function copyFileReference(path: string, line?: number): Promise<void> {
    const rel = path.replace(/\\/g, '/')
    if (!rel) return
    const ref = line !== undefined && line >= 1 ? `${rel}:${line}` : rel
    if (await copyText(ref)) {
      message.success(t('layout.referenceCopied'))
    } else {
      message.error(t('common.copyFailed'))
    }
  }

  return { copyFilePath, copyFileName, copyAbsoluteFilePath, copyFileReference }
}
