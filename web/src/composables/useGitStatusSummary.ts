import { logApi } from '../api/client'
import { useProjectStore } from '../stores/project'
import { useChangesStore } from '../stores/changes'
import { useI18n } from './useI18n'
import { buildGitStatusSummary } from '../utils/gitStatusSummary'

/**
 * 会话创建注入 git 状态摘要（P-20261003-176）取数面：把现成缓存面聚合成
 * utils/gitStatusSummary 需要的事实并拼行。消费方 = useEditorAskAgent 发起族
 * （P-28/P-122/P-7/P-109/P-55 共用 launchAskSession）与 NewSessionDialog。
 *
 * - 分支/项目名：projectStore.currentProject（服务端项目列表随带）
 * - 未提交变更数：changesStore.files（boot/切项目/WS 事件三路刷新，enter
 *   项目页即有，不另起 git 扫描——提案「缓存面现成」口径）
 * - 最近提交主题：changes/branch 有现成 store，提交清单没有可靠缓存——
 *   logStore 只在提交面板打开/广播后才有值，且可被分支切换带动成非 HEAD 视图，
 *   直接复用会注入陈旧/错位主题；故按 useCommitActions amend 回填同款先例
 *   现查 limit=1（一次 GET，用户触发的创建动作非热路径）。失败/空仓库降级
 *   为无提交段，绝不阻塞发起
 * - 无当前项目 / 非 git 工作区（无分支名）→ 空串，上游按「无摘要」不注入
 */
export function useGitStatusSummary() {
  const { t } = useI18n()

  /** 拼当前项目的 git 状态摘要行；不可用返回空串（尽力而为，绝不 reject） */
  async function buildCurrentSummary(): Promise<string> {
    const project = useProjectStore().currentProject
    if (!project) return ''
    // 非 git 工作区（无分支名）注定无摘要：提前返回，连 limit=1 现查都不发
    if (!project.currentBranch) return ''
    let subject = ''
    try {
      const res = await logApi.getLog(project.id, { limit: 1 })
      subject = (res.data?.[0]?.message || '').trim()
    } catch {
      // 取不到提交主题就省略该段（空仓库/路径失效等），不阻塞会话创建
    }
    return buildGitStatusSummary(
      {
        projectName: project.name,
        branch: project.currentBranch,
        changedCount: useChangesStore().files.length,
        lastCommitSubject: subject,
      },
      t,
    )
  }

  return { buildCurrentSummary }
}
