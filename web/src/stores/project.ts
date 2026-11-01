import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { projectApi } from '../api/client'
import { removeProjectDrafts } from '../utils/draftDb'
import { OPS_PROJECTS_CHANGED } from '../utils/opsEvents'

// 项目切换前的确认回调（P-20261003-105，openfiles/core 域注册）：有未保存草稿时
// 确认「有 N 份未保存草稿将丢弃」，返回 false 取消切换。与实例切换的
// registerBeforeSwitchHook（stores/instance.ts）同构的模块级注册点
let _beforeProjectSwitch: (() => boolean | Promise<boolean>) | null = null

/** 注册项目切换守卫，返回注销函数（仅当当前守卫仍是自己时才摘除——后创建的
 *  Layout 实例已覆盖注册，先创建的实例卸载时不得误摘后者的守卫） */
export function registerBeforeProjectSwitchHook(hook: () => boolean | Promise<boolean>): () => void {
  _beforeProjectSwitch = hook
  return () => {
    if (_beforeProjectSwitch === hook) _beforeProjectSwitch = null
  }
}

export interface Project {
  id: string
  name: string
  path: string
  currentBranch: string
  remoteURL: string
  /** 路径仍然存在且可访问（目录被删/移动后为 false） */
  valid: boolean
  /** 是否 git 仓库（false = 非 git 工作区：文件/终端可用，Git 功能降级） */
  gitRepo?: boolean
  /** 项目冻结（P-20261003-9）：首页折入尾部弱化分区（可搜索/解冻），
   * 并跳过 ahead/behind 批量探测；功能面不变 */
  frozen?: boolean
  /** 项目硬锁（P-20261004-3）：归档不可变档——写族端点 403、读面放行 */
  locked?: boolean
}

export const useProjectStore = defineStore('project', () => {
  const projects = ref<Project[]>([])
  const currentProjectId = ref<string>('')
  const loading = ref(false)

  const currentProject = computed(() =>
    projects.value.find((p) => p.id === currentProjectId.value),
  )

  async function fetchProjects(opts?: { silent?: boolean }) {
    // silent（P-20261004-143）：ops 广播驱动的后台保鲜不翻 loading——首页骨架
    // 屏等 loading 消费方只应跟随用户显式进入首页的拉取闪烁，后台对账静默
    if (!opts?.silent) loading.value = true
    try {
      const res = await projectApi.list()
      projects.value = res.data || []
      // 如果没有选中的项目且有项目列表，选中第一个有效项目。
      // 列表首位可能是路径已失效的项目（目录被删/移动后 valid=false）：
      // 选中它会立刻触发文件树等请求 → 500 + 通用错误 toast，而随后的
      // uiState 恢复又纠正回真实项目——首屏错误闪现纯属自动选中的竞态噪音
      if (!currentProjectId.value && projects.value.length > 0) {
        const firstUsable =
          projects.value.find(p => p.valid !== false) ?? projects.value[0]
        currentProjectId.value = firstUsable?.id || ''
      }
    } finally {
      if (!opts?.silent) loading.value = false
    }
  }

  async function addProject(name: string, path: string) {
    const res = await projectApi.add({ name, path })
    const project = res.data
    projects.value.push(project)
    currentProjectId.value = project.id
    return project
  }

  /** closeAgentSessions（P-20261006-36）：确认框勾选「一并关闭驻留智能体
   *  会话」时携带——服务端据 Path 前缀匹配级联 CloseSession；缺省保留 */
  async function removeProject(id: string, closeAgentSessions = false) {
    await projectApi.remove(id, closeAgentSessions)
    projects.value = projects.value.filter((p) => p.id !== id)
    if (currentProjectId.value === id) {
      currentProjectId.value = projects.value[0]?.id || ''
    }
    // 项目删除即清其编辑器草稿（IndexedDB）：项目没了草稿无落点，
    // 静默 fire-and-forget（draftDb 环境不可用时内部自行降级）
    void removeProjectDrafts(id)
  }

  // 重新定位项目路径（目录搬家恢复）：ID/名称不变仅更新 path，
  // 本地列表同步替换为服务端回传的最新态（含 valid/gitRepo 现查结果）
  async function relocateProject(id: string, path: string) {
    const res = await projectApi.relocate(id, path)
    const updated = res.data as Project
    const idx = projects.value.findIndex((p) => p.id === id)
    if (idx !== -1) projects.value[idx] = updated
    return updated
  }

  // 冻结/解冻（P-20261003-9）：布尔开关，本地列表同步替换为服务端回传的最新态
  async function setProjectFrozen(id: string, frozen: boolean) {
    const res = await projectApi.setFrozen(id, frozen)
    const updated = res.data as Project
    const idx = projects.value.findIndex((p) => p.id === id)
    if (idx !== -1) projects.value[idx] = { ...projects.value[idx], ...updated }
    return updated
  }

  // 硬锁锁定/解锁（P-20261004-3）：布尔开关，本地列表同步替换为服务端回传的最新态
  async function setProjectLocked(id: string, locked: boolean) {
    const res = await projectApi.setLocked(id, locked)
    const updated = res.data as Project
    const idx = projects.value.findIndex((p) => p.id === id)
    if (idx !== -1) projects.value[idx] = { ...projects.value[idx], ...updated }
    return updated
  }

  function applySwitch(id: string, explicit: boolean) {
    currentProjectId.value = id
    if (explicit) explicitSelectId.value = id
  }

  /** 切换族（selectProject/selectProjectExplicit）共用的守卫管道：同项目重入
   *  与未注册守卫时同步放行（赋值语义与历史一致）；守卫同步裁决（无草稿放行）
   *  同样保持同步赋值——深链「切完即开」等既有同步时序零变化；异步裁决
   *  （草稿确认弹窗）期间不落定，取消 = 维持原项目。返回是否已（或将）切换 */
  function guardedSwitch(id: string, explicit: boolean): boolean | Promise<boolean> {
    if (id === currentProjectId.value || !_beforeProjectSwitch) {
      applySwitch(id, explicit)
      return true
    }
    const verdict = _beforeProjectSwitch()
    if (verdict === true) {
      applySwitch(id, explicit)
      return true
    }
    if (verdict === false) return false
    return verdict.then((ok) => {
      if (ok) applySwitch(id, explicit)
      return ok
    })
  }

  function selectProject(id: string): boolean | Promise<boolean> {
    return guardedSwitch(id, false)
  }

  // 用户显式选择的项目 id（消费一次即清）：首页点击进入项目时打标，
  // Layout 挂载恢复流程据此跳过 uiState 历史值覆盖——否则上次会话
  // auto-save 的 projectId 会迟到覆盖用户刚点的项目（"进 A 跳 B"根因）
  const explicitSelectId = ref('')

  function selectProjectExplicit(id: string): boolean | Promise<boolean> {
    return guardedSwitch(id, true)
  }

  function consumeExplicitSelectId(): string {
    const id = explicitSelectId.value
    explicitSelectId.value = ''
    return id
  }

  // ops 通道锁态保鲜（P-20261004-143）：锁定/解锁经服务端 projects.changed 广播
  // （server/api/project/lock.go），此前只有首页宿主消费——用户停在项目内/终端域
  // 时本 store 的 locked 字段会陈旧，终端域锁徽标（tab/会话行）随之失真。锁定
  // 广播携 {action:'locked', id, locked} 三键：本地直补零网络零闪动；项目不在
  // 本地清单（本标签页未加载）或其余形态（项目增删、useRemoveProjectUndo 的无
  // detail 广播）回落静默全量刷新对账。terminal-sessions 同款 store 内订阅先例
  if (typeof window !== 'undefined') {
    window.addEventListener(OPS_PROJECTS_CHANGED, (e) => {
      const payload = (e as CustomEvent<{ action?: string; id?: string; locked?: boolean }>).detail
      if (payload?.action === 'locked' && payload.id && typeof payload.locked === 'boolean') {
        const idx = projects.value.findIndex(p => p.id === payload.id)
        if (idx >= 0) {
          projects.value[idx] = { ...projects.value[idx]!, locked: payload.locked }
          return
        }
      }
      void fetchProjects({ silent: true })
    })
  }

  return {
    projects,
    currentProjectId,
    currentProject,
    loading,
    fetchProjects,
    addProject,
    relocateProject,
    setProjectFrozen,
    setProjectLocked,
    removeProject,
    selectProject,
    selectProjectExplicit,
    consumeExplicitSelectId,
  }
})
