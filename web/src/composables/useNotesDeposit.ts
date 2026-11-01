import { useMessage } from 'naive-ui'
import { projectApi } from '../api/client'
import { useAssistantTaskStore } from '../stores/assistantTask'
import { useProjectStore } from '../stores/project'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { NOTES_EXTERNAL_UPDATE, type NotesExternalUpdateDetail } from '../utils/opsEvents'
import { appendDepositSection, buildDepositSection, isDepositStatus, localDateStr } from '../utils/notesDeposit'
import { usePanelLayout } from './usePanelLayout'
import { useI18n } from './useI18n'

/**
 * 「沉淀到笔记」次级入口（P-20261003-292）：任务终态（done/failed）把结论
 * 追加进项目笔记的人机共享约定——agent 侧约定登记在 ops 手册 projnotes 节
 * （GET 读 → 追加 `## <日期> <任务简称>` 节 → PUT 整份写回），本 composable
 * 是人侧助力：agent 忘了约定时，人在悬浮球条/管理页头部一键补写预填模板，
 * 再在笔记面板编辑补充（面板防抖自动保存）。
 *
 * 落项目解析顺序：会话 projectId（项目会话）→ 会话 cwd 匹配注册项目路径
 * （agent 会话免项目绑定但 dir=项目根的常态）→ 当前项目（人正在看的上下文）。
 * 写入遵循手册同款约定：GET 读现笔记 → 末尾追加一节 → PUT 整份写回
 * （last-writer-wins；写后广播 NOTES_EXTERNAL_UPDATE 让已挂载的笔记面板
 * 重读，防面板旧内容随下次防抖保存把沉淀节覆盖掉）。
 */

// 模块级在途防重入：双击/两宿主并发点击只落一节（追加写幂等性靠它兜住；
// 完成后释放，再次点击是显式意图、允许再追加一节）
let depositInFlight = false

export function useNotesDeposit() {
  const { t } = useI18n()
  const message = useMessage()
  const projectStore = useProjectStore()

  /** 会话 → 项目 id：projectId 直取（项目会话）；agent 会话按 cwd 匹配注册
   *  项目路径（两侧路径都来自服务端，同命名空间可直接比对）；都落空回当前项目 */
  function resolveProjectId(sessionId?: string): string {
    const sessionsStore = useTerminalSessionsStore()
    if (sessionId) {
      const s = sessionsStore.sessions.find(x => x.id === sessionId)
      if (s?.projectId) return s.projectId
      if (s?.path) {
        const hit = projectStore.projects.find(p => p.path === s.path)
        if (hit) return hit.id
      }
    }
    return projectStore.currentProjectId || ''
  }

  /** 打开/确保笔记面板可见（被最大化面板覆盖时先还原——「点啥显示啥」前置） */
  function revealNotesPanel(): void {
    const layout = usePanelLayout()
    layout.restoreFromMaximized()
    layout.sideView.value = 'notes'
    layout.showSidePanel.value = true
  }

  /** 沉淀一节结论到指定上下文的项目笔记。失败就地 toast 并返回 false，
   *  成功 toast 后在当前项目语境下顺带打开笔记面板供人编辑补充 */
  async function depositToNotes(input: { sessionId?: string; task?: string; status?: string }): Promise<boolean> {
    if (depositInFlight) return false
    const pid = resolveProjectId(input.sessionId)
    if (!pid) {
      message.warning(t('notes.deposit.noProject'))
      return false
    }
    const status = input.status === 'failed' ? 'failed' : 'done'
    const task = (input.task || '').trim() || t('notes.deposit.untitledTask')
    depositInFlight = true
    try {
      const res = (await projectApi.projectNotes(pid)) as { data?: { content?: string } }
      const next = appendDepositSection(
        res.data?.content ?? '',
        buildDepositSection(localDateStr(), task, status, {
          result: t('notes.deposit.fieldResult'),
          what: t('notes.deposit.fieldWhat'),
          decisions: t('notes.deposit.fieldDecisions'),
          leftovers: t('notes.deposit.fieldLeftovers'),
          done: t('monitorBoard.statusDone'),
          failed: t('monitorBoard.statusFailed'),
        }),
      )
      await projectApi.saveProjectNotes(pid, next)
      message.success(t('notes.deposit.saved'))
      // 当前项目语境才开面板：跨项目/首页点击开不出可见面板，toast 已足够
      if (projectStore.currentProjectId === pid) {
        revealNotesPanel()
        // 先设 refs 再广播：面板已挂载时立即重读；未挂载时挂载 load() 自取最新
        window.dispatchEvent(new CustomEvent<NotesExternalUpdateDetail>(NOTES_EXTERNAL_UPDATE, { detail: { projectId: pid } }))
      }
      return true
    } catch (e) {
      message.error((e as { userMessage?: string }).userMessage || t('notes.deposit.failed'))
      return false
    } finally {
      depositInFlight = false
    }
  }

  /** 沉淀「当前任务」（悬浮球条/管理页头部终态入口共用）：任务名/状态取
   *  assistantTask 的归属会话优先投影（displayTask），会话 id 作落项目解析锚点 */
  async function depositCurrentTask(): Promise<boolean> {
    const taskStore = useAssistantTaskStore()
    const sid = taskStore.latestSessionId || undefined
    const cur = sid ? taskStore.bySession[sid] : undefined
    const status = cur?.status || taskStore.status
    return depositToNotes({
      sessionId: sid,
      task: taskStore.displayTask || cur?.task || taskStore.task,
      status: isDepositStatus(status) ? status : 'done',
    })
  }

  return { depositToNotes, depositCurrentTask }
}
