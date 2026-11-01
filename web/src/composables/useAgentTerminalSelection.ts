import { computed, nextTick, ref, watch, type Ref } from 'vue'
import { useTerminalSessionsStore } from '../stores/terminal-sessions'
import type { AgentTermSession, AgentTerminalMode } from './useAgentTerminal'

/** AgentTerminalPanes 暴露的 refit 入口（结构化最小类型，解耦组件导入） */
export interface AgentPanesFitApi {
  fitSystemPane: (id: string) => void
  fitFor: (id: string) => void
  fitAllSystem: () => void
}

/**
 * 智能体终端选中模型（P-20261001-20 从 AgentTerminalView 拆出）：
 * 右侧渲染选中（系统会话 + 被接管项目会话统一）/ 惰性挂载集合 / docked 兜底
 * 选中 / 形态切换与选中变化驱动的 pane refit / 侧栏展示序。
 */
export function useAgentTerminalSelection(deps: {
  /** 系统会话（useAgentTerminal 的 sessions） */
  sessions: Ref<AgentTermSession[]>
  activeId: Ref<string>
  visible: Ref<boolean>
  mode: Ref<AgentTerminalMode>
  sessionsStore: ReturnType<typeof useTerminalSessionsStore>
  /** 右侧终端区组件引用（refit 经其暴露方法驱动；getter 规避 Ref 泛型不变性） */
  getPanes: () => AgentPanesFitApi | null | undefined
}) {
  const { sessions, activeId, visible, mode, sessionsStore } = deps

  /** 右侧终端区当前渲染的会话 id（agent 会话选中时同步 activeId 兼容运行点逻辑） */
  const selectedId = ref('')
  /** 最后查看的会话 id（跨折叠保留）：收起为悬浮球时 selectedId 会被清空
   *  （归还底部面板），再展开时据此恢复选中——避免「面板打开了、右侧空白」 */
  const lastViewedSessionId = ref('')
  /** 当前选中且已接管的项目会话（接管中才在本页渲染——独占挂接） */
  const selectedProjectSession = computed(() =>
    sessionsStore.projectSessions.find(s => s.id === selectedId.value && sessionsStore.managerAttached.has(s.id)))
  /** 全部被接管的项目会话（keep-alive 渲染，v-show 切换选中——按会话 id 键控，
   *  切换即换 pane，不再有单 pane 复用导致点切换无反应的问题） */
  const attachedProjectSessions = computed(() =>
    sessionsStore.projectSessions.filter(s => sessionsStore.managerAttached.has(s.id)))

  // ============== 惰性挂载（P9 打磨）：只渲染被选中过的系统会话 pane ==============
  // 全量挂载在会话多时浪费 WS 连接与内存；keep-alive 确保已选过的终端现场保留
  const touchedIds = ref(new Set<string>())
  function touch(id: string) {
    if (!touchedIds.value.has(id)) {
      touchedIds.value.add(id)
      touchedIds.value = new Set(touchedIds.value)
    }
  }
  function selectAgent(id: string) {
    touch(id)
    selectedId.value = id
    activeId.value = id
    lastViewedSessionId.value = id
  }
  /** 接管项目会话：优先渲染在本页（底部面板转挂起占位） */
  function attachProject(id: string) {
    sessionsStore.attachToManager(id)
    touch(id)
    selectedId.value = id
    activeId.value = id
    lastViewedSessionId.value = id
  }
  /** 惰性挂载集合 ∩ 全量系统会话（保持 store 排序） */
  const mountedAgentSessions = computed(() => {
    const touched = touchedIds.value
    return sessions.value.filter(s => touched.has(s.id))
  })

  // 侧栏展示序：跟随 store 排序（default=创建序）；终端 pane 区保持稳定序
  // （mountedAgentSessions 仍用 sessions——活动排序若重排 keep-alive pane 会在
  // 每次命令结束时视觉抖动）
  const displaySessions = computed(() => {
    const byId = new Map(sessions.value.map(s => [s.id, s]))
    return sessionsStore.sortedSystemSessions
      .map(s => byId.get(s.id))
      .filter((s): s is NonNullable<typeof s> => !!s)
  })

  // ============== 归还语义：本页隐藏或收为悬浮球时全量归还 ==============
  // 切到悬浮窗（float）不归还：被接管的项目会话在悬浮窗继续渲染（当前会话
  // 随形态缩小跟随，避免「悬浮窗打开后丢当前会话」）
  // 展开回 docked 时若无渲染中的会话，恢复最后查看的会话（无记忆则选第一个
  // 可用会话：系统会话优先，其次项目会话）——避免「面板打开了、右侧空白、
  // 还得再点一次会话」
  /** docked 可见且无选中时的兜底选中。抽成函数供两处复用：visible/mode 变化
   *  的 watch（展开/切回 docked），以及 boot() 拉齐会话列表之后——本 View 惰性
   *  挂载（everDocked v-if），首次打开时挂载发生在 visible 置真之后，watch 已
   *  错过状态跳变不会再触发；若 boot 里不补一次兜底，首次进入必然停在空态 */
  function ensureDockedSelection(): void {
    if (!visible.value || mode.value !== 'docked' || selectedId.value) return
    const rid = lastViewedSessionId.value
    if (rid && sessions.value.some(s => s.id === rid)) {
      selectAgent(rid)
    } else if (rid && sessionsStore.projectSessions.some(s => s.id === rid)) {
      attachProject(rid)
    } else {
      const firstAgent = displaySessions.value[0]
      if (firstAgent) {
        selectAgent(firstAgent.id)
      } else {
        const firstProject = sessionsStore.projectSessions[0]
        if (firstProject) attachProject(firstProject.id)
      }
    }
  }

  // 恢复/重新可见后强制 refit 全部 pane（xterm v6 滚动区同步自愈，fit(true)
  // 内含 refresh + 行数抖动强制滚动区重同步——与会话切换同款处理）
  watch([visible, mode], ([v, m]) => {
    if (v && m === 'docked') {
      ensureDockedSelection()
      void nextTick(() => {
        deps.getPanes()?.fitAllSystem()
      })
      return
    }
    if (!v || m === 'mini') {
      sessionsStore.returnAllToPanel()
      // 归还路径（collapse 等）先于本回调清空挂接表，selectedProjectSession 已是
      // undefined——悬空选中只能按「非系统会话 id」判定后清理，避免重开时残留
      if (selectedId.value && !sessionsStore.systemSessions.some(s => s.id === selectedId.value)) {
        selectedId.value = ''
      }
    }
  })

  // 会话切换（docked/float 内切 pane）：新显示的 pane 强制深度 refit——keep-alive
  // pane 在 v-show 隐藏期间滚动区可能失同步，切换后滚轮失灵；隐藏期写入的
  // 重放只有真实 resize 能重算滚动区（fit(true) 的行数抖动即等效 resize）
  watch([activeId, selectedId], () => {
    void nextTick(() => {
      const pid = selectedProjectSession.value?.id || activeId.value
      if (pid) deps.getPanes()?.fitSystemPane(pid)
    })
  })

  return {
    selectedId, lastViewedSessionId,
    selectedProjectSession, attachedProjectSessions, mountedAgentSessions, displaySessions,
    touch, selectAgent, attachProject, ensureDockedSelection,
  }
}
