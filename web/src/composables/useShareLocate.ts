import { nextTick } from 'vue'
import { useMessage } from 'naive-ui'
import { useProjectStore } from '../stores/project'
import { useI18n } from './useI18n'
import { useEditorTreeLocate } from './useEditorTreeLocate'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '../utils/opsEvents'
import type { ShareInfo } from '../api/domains/share'
import { shareHealth } from './useShareManagerList'

/** 「定位目标」可用性（纯函数，单测锚）：仅 file 形态、项目仍在且健康 ok。
 *  异常行没有可定位的真实目标；非 file 形态没有项目内路径可落。 */
export function shareCanLocate(s: ShareInfo, projectIds: ReadonlySet<string>): boolean {
  return s.kind === 'file' && !!s.projectId && projectIds.has(s.projectId) && shareHealth(s) === 'ok'
}

/**
 * 分享管理器「定位目标」（P-20261020-10）：把主人带回短链所指的项目内容。
 * - 文件：派发 OPS_OPEN_FILE_AT 既有打开链（消费方负责必要时切项目 + 行定位）
 * - 目录/项目根：先切到归属项目（未保存草稿守卫取消即放弃），再走
 *   OPS_LOCATE_IN_TREE 展开文件树（空路径 = 项目根）
 * 目标丢失/项目删除时只给可行动提示，不打开错误位置。
 */
export function useShareLocate() {
  const projectStore = useProjectStore()
  const message = useMessage()
  const { t } = useI18n()
  const { locateInTree, revealProjectRoot } = useEditorTreeLocate()

  async function locateTarget(s: ShareInfo): Promise<void> {
    if (s.kind !== 'file') {
      message.warning(t('share.locate.unavailable'))
      return
    }
    const ids = new Set(projectStore.projects.map((p) => p.id))
    if (!s.projectId || !ids.has(s.projectId)) {
      message.warning(t('share.locate.projectGone'))
      return
    }
    if (shareHealth(s) !== 'ok') {
      message.warning(t('share.locate.targetGone'))
      return
    }
    if (s.path && !s.isDir) {
      // 打开链自带项目切换（useLayoutViews.handleTerminalOpenFile）；这里不
      // 抢先切项目，避免与消费方重复弹草稿确认
      window.dispatchEvent(new CustomEvent<OpenFileAtDetail>(OPS_OPEN_FILE_AT, {
        detail: { path: s.path, projectId: s.projectId },
      }))
      return
    }
    if (s.projectId !== projectStore.currentProjectId) {
      if ((await projectStore.selectProject(s.projectId)) === false) return
      // 等项目切换的「清空打开文件」watcher 先落（OPS_LOCATE_IN_TREE 消费方
      // 以当前项目匹配 projectId，切换未落定时派发会被忽略）
      await nextTick()
    }
    if (!s.path) {
      await revealProjectRoot()
      return
    }
    await locateInTree(s.path)
  }

  return { locateTarget }
}
