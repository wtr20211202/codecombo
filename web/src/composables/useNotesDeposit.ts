import { useMessage } from 'naive-ui'
import { GLOBAL_NOTES_SCOPE, notesGlobalApi, type MultiNoteMeta } from '../api/client'
import { useAssistantTaskStore } from '../stores/assistantTask'
import { useProjectStore } from '../stores/project'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { NOTES_EXTERNAL_UPDATE, type NotesExternalUpdateDetail } from '../utils/opsEvents'
import { appendDepositSection, buildDepositSection, handoverNoteTitle, isDepositStatus, localDateStr } from '../utils/notesDeposit'
import { usePanelLayout } from './usePanelLayout'
import { useI18n } from './useI18n'

/**
 * 「沉淀到笔记」次级入口（P-20261003-292 → P-20261108-3 单库化改道）：任务终态
 * （done/failed）把结论追加进笔记库的人机共享约定——agent 侧约定登记在 ops 手册
 * notes-global 节（找「[项目名] 交接」篇 → 追加 `## <日期> <任务简称>` 节 → 携
 * baseUpdatedAt 整份写回），本 composable 是人侧助力：agent 忘了约定时，人在
 * 悬浮球条/管理页头部一键补写预填模板，再在笔记视图编辑补充（防抖自动保存）。
 *
 * 单库化（P-20261108-3）：笔记只剩项目无关的 /api/notes 一个库（项目兼容端点
 * 退役）。沉淀 = **find-or-create 单篇**——每项目一篇「[项目名] 交接」（标题前缀
 * 承载项目归属，接手项目按前缀即可找到），找到即追加节、没有才新建；刻意不按
 * 任务新建篇（笔记库 100 篇上限会被任务数吃满）。
 *
 * 落项目解析顺序（决定标题里的项目名）：会话 projectId（项目会话）→ 会话 cwd
 * 匹配注册项目路径（agent 会话免项目绑定但 dir=项目根的常态）→ 当前项目（人正
 * 在看的上下文）。写入：读现文 → 末尾追加一节 → 携 baseUpdatedAt 写回（409 =
 * 期间被人/agent 改过，重读再追加一次；写后广播 NOTES_EXTERNAL_UPDATE 带 focus
 * 让笔记视图聚焦该篇——防面板旧内容随下次防抖保存把沉淀节覆盖掉）。
 *
 * 诚实边界：标题用当前界面语言的「交接」词（en 界面为 Handover）——不同界面语言
 * 的人与 agent（手册约定中文「交接」）可能各落一篇，两篇同带「[项目名]」前缀，
 * 前缀搜索与会话启动上下文注入两条发现路径仍覆盖。
 */

// 模块级在途防重入：双击/两宿主并发点击只落一节（追加写幂等性靠它兜住；
// 完成后释放，再次点击是显式意图、允许再追加一节）
let depositInFlight = false

export function useNotesDeposit() {
  const { t } = useI18n()
  const message = useMessage()
  const projectStore = useProjectStore()

  /** 会话 → 项目：projectId 直取（项目会话）；agent 会话按 cwd 匹配注册项目路径
   *  （两侧路径都来自服务端，同命名空间可直接比对）；都落空回当前项目 */
  function resolveProject(sessionId?: string): { id: string; name: string } | null {
    const sessionsStore = useTerminalSessionsStore()
    let pid = ''
    if (sessionId) {
      const s = sessionsStore.sessions.find(x => x.id === sessionId)
      if (s?.projectId) pid = s.projectId
      else if (s?.path) pid = projectStore.projects.find(p => p.path === s.path)?.id ?? ''
    }
    if (!pid) pid = projectStore.currentProjectId || ''
    const p = pid ? projectStore.projects.find(x => x.id === pid) : undefined
    return p ? { id: p.id, name: p.name } : null
  }

  /** 打开/确保笔记视图可见（P-20261108-2 起笔记是独立视图：项目页主区 / 首页
   *  overlay；openNotesView 幂等且内含最大化还原前置——「点啥显示啥」，docked
   *  管理页由 AgentTerminal 两宿主的反向 watch 收起） */
  function revealNotesPanel(): void {
    usePanelLayout().openNotesView()
  }

  /** 找交接篇：清单（updatedAt 降序，元数据面）里标题完全一致的最近一篇 */
  async function findHandover(title: string): Promise<MultiNoteMeta | undefined> {
    const res = await notesGlobalApi.list()
    return (res.data ?? []).find(n => n.title === title)
  }

  function isConflict(e: unknown): boolean {
    const err = e as { response?: { status?: number; data?: { code?: string } } }
    return err?.response?.status === 409 && err.response.data?.code === 'notes.conflict'
  }

  /** find-or-create 单篇追加：返回落盘篇 id。追加写携 baseUpdatedAt——期间被改
   *  （409）即重读再追加一次，二次仍冲突上抛（不盲目覆盖他人写入） */
  async function appendToHandover(title: string, section: string): Promise<string> {
    const target = await findHandover(title)
    if (!target) {
      const res = await notesGlobalApi.create({ title, content: section })
      return res.data.id
    }
    for (let attempt = 0; ; attempt++) {
      const cur = (await notesGlobalApi.get(target.id)).data
      try {
        await notesGlobalApi.save(target.id, {
          content: appendDepositSection(cur.content, section),
          baseUpdatedAt: cur.updatedAt,
        })
        return target.id
      } catch (e) {
        if (attempt === 0 && isConflict(e)) continue
        throw e
      }
    }
  }

  /** 沉淀一节结论到会话归属项目的交接篇。失败就地 toast 并返回 false；成功
   *  toast 后打开笔记视图并聚焦该篇供人编辑补充 */
  async function depositToNotes(input: { sessionId?: string; task?: string; status?: string }): Promise<boolean> {
    if (depositInFlight) return false
    const project = resolveProject(input.sessionId)
    if (!project) {
      message.warning(t('notes.deposit.noProject'))
      return false
    }
    const status = input.status === 'failed' ? 'failed' : 'done'
    const task = (input.task || '').trim() || t('notes.deposit.untitledTask')
    const title = handoverNoteTitle(project.name, t('notes.deposit.handoverTitle'))
    depositInFlight = true
    try {
      const noteId = await appendToHandover(title, buildDepositSection(localDateStr(), task, status, {
        result: t('notes.deposit.fieldResult'),
        what: t('notes.deposit.fieldWhat'),
        decisions: t('notes.deposit.fieldDecisions'),
        leftovers: t('notes.deposit.fieldLeftovers'),
        done: t('monitorBoard.statusDone'),
        failed: t('monitorBoard.statusFailed'),
      }))
      message.success(t('notes.deposit.saved', { title }))
      // 笔记是项目无关的单库：任何语境都开视图并聚焦刚写的篇（首页 overlay 同样
      // 可见，P-20261108-2）。先开视图再广播：面板已挂载时立即重拉并聚焦；未挂载
      // 时挂载 loadList 自取最新（刚写的篇 updatedAt 最新居首即默认选中）
      revealNotesPanel()
      window.dispatchEvent(new CustomEvent<NotesExternalUpdateDetail>(NOTES_EXTERNAL_UPDATE, {
        detail: { projectId: GLOBAL_NOTES_SCOPE, noteId, action: 'deposit', focus: true },
      }))
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
