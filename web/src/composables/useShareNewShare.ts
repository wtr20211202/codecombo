import { useMessage } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { useI18n } from './useI18n'
import { useEditorTreeLocate } from './useEditorTreeLocate'

/**
 * 分享管理器「新建分享」CTA（P-20261020-8）：管理器从只读列表变成可发起。
 *
 * 不直接造路径输入框——分享目标必须是项目内真实存在的文件/目录，凭空输路径
 * 既要重复路径校验又会把用户带进「输了不存在的文件才报错」的坑。有项目时
 * 打开文件树并回到项目根（复用 useEditorTreeLocate 的定位事件链：切 files
 * 视图/退最大化/清搜索/滚动到根 + 焦点交给树），由用户自己选；无项目时
 * 就地提示先打开项目（管理器可能在项目被删/未选中的残态下可达）。
 *
 * 返回是否已发起跳转，false = 无项目被拦（单测断言 + 调用方无需再判）。
 */
export function useShareNewShare() {
  const projectStore = useProjectStore()
  const message = useMessage()
  const { t } = useI18n()
  const { revealProjectRoot } = useEditorTreeLocate()

  async function startNewShare(): Promise<boolean> {
    if (!projectStore.currentProjectId) {
      message.warning(t('share.newShare.noProject'))
      return false
    }
    await revealProjectRoot()
    return true
  }

  return { startNewShare }
}
