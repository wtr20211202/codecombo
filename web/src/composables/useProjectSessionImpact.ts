import { computed, type Ref } from 'vue'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import { useAssistantTaskStore } from '../stores/assistantTask'
import { useProjectStore } from '../stores/project'
import { pathResidesIn } from '../utils/pathResidency'

/**
 * 项目删除影响面读数（P-20261003-145）：删除项目会级联 Kill 该项目全部终端
 * 会话（服务端 DeleteProject 对 ProjectID==id 的会话逐个 CloseSession，见
 * server/api/project/project.go 级联清理段），而确认框此前只显项目名——
 * agent 跑一半的活跃工作台被静默终结。本 composable 把「将终止几个会话、
 * 几个仍在运行」做成两个删除确认入口（首页项目卡 / 项目内更多菜单）共用的
 * 响应式读数，确认文案据 total/running 追加知会并升级警示。
 *
 * 驻留智能体会话（P-20261006-36）：kind=agent 会话免项目绑定（projectId 恒
 * 空），不随项目删除级联，但常在项目目录里启动（创建 dir 在项目根内）——
 * 据会话 path 对项目注册根做前缀匹配补计入 residentTotal，删除知情从「部分
 * 真实」到「全貌」。驻留计数刻意不带运行态：agent 会话几乎恒运行，报「M 个
 * 运行中」是噪音不是信息。匹配边界与服务端一致（词法前缀，失配=不计入），
 * 前端侧不做大小写折叠（全平台纪律，见 pathResidency.ts 头注）。
 *
 * 「运行中」取会话粒度运行信号——OSC 133 C 命令运行态 或 assistant task
 * running 上报，两者任一命中即计入。确认框本为知情报，计数是打开瞬间的
 * 快照，容忍轻微漂移。
 */
export function useProjectSessionImpact(projectId: Ref<string | undefined>) {
  const sessionsStore = useTerminalSessionsStore()
  const taskStore = useAssistantTaskStore()
  const projectStore = useProjectStore()

  /** 删除将级联终止的会话清单（该项目绑定会话） */
  const sessions = computed(() =>
    sessionsStore.sessions.filter(s => s.projectId !== '' && s.projectId === projectId.value),
  )
  /** 将终止的会话数 */
  const total = computed(() => sessions.value.length)
  /** 其中仍在运行的（命令运行中或 agent 任务 running 上报） */
  const running = computed(() => sessions.value.filter(
    s => sessionsStore.runningMap[s.id] === true || taskStore.bySession[s.id]?.status === 'running',
  ).length)

  /** 目标项目的注册根路径（列表未含目标时为空 = 驻留计数为 0） */
  const projectPath = computed(() =>
    projectStore.projects.find(p => p.id === projectId.value)?.path,
  )

  /** 驻留该项目的智能体会话：kind=agent、免项目绑定、创建目录在项目根内。
   *  external 接管会话不参与——其「关闭」= 解除接管（用户自管 tmux 会话，
   *  项目删除不该碰），与服务端 ResidentAgentSessions 同口径 */
  const residentAgents = computed(() => {
    const root = projectPath.value
    if (!root) return []
    return sessionsStore.sessions.filter(s =>
      s.kind === 'agent'
      && s.projectId === ''
      && s.origin !== 'external'
      && pathResidesIn(s.path, root),
    )
  })
  /** 驻留智能体会话数（知情补计，不随删除级联——除非用户勾选「一并关闭」） */
  const residentTotal = computed(() => residentAgents.value.length)

  /** 打开确认框时拉一次服务端会话快照（首页等未挂终端面的宿主 store 可能
   *  尚未加载过；一开框一请求，非热路径），失败保留现状（知情报不阻断删除） */
  function refreshSnapshot(): void {
    void sessionsStore.refresh()
  }

  return { sessions, total, running, residentAgents, residentTotal, refreshSnapshot }
}
