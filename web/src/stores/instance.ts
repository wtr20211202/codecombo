import { defineStore } from 'pinia'
import { ref, computed, nextTick } from 'vue'
import router from '../router'
import { instanceApi, setInstanceContext, cancelAllRequests } from '../api/client'
import { useProjectStore } from './project'
import { useChangesStore } from './changes'
import { useConsoleStore } from './console'
import { useErrorLogStore } from './errorLog'
import { useNotificationStore } from './notification'
import { matchEquivalentProject } from '../utils/projectMatch'

export interface Instance {
  id: string
  name: string
  url: string
  token?: string
  isLocal: boolean
  parentId?: string
  role?: string
  /** invalid = 地址可达但响应不是 Codecombo 服务（如误指向 gitea/nginx） */
  status: 'online' | 'offline' | 'unknown' | 'invalid'
  version?: string
  createdAt: string
  updatedAt: string
}

// 实例切换前的确认回调（由 Layout.vue 注册）
let _beforeSwitch: (() => boolean | Promise<boolean>) | null = null

export function registerBeforeSwitchHook(hook: () => boolean | Promise<boolean>) {
  _beforeSwitch = hook
}

// 切换遮罩淡出延迟：等新视图首帧渲染后再收起（叠加遮罩自身 200ms 淡出）
const SWITCH_OVERLAY_LINGER_MS = 150
// 状态探测 TTL：打开菜单/面板是高频动作，避免每次都触发后端全量健康探测
const PROBE_TTL_MS = 30_000

export const useInstanceStore = defineStore('instance', () => {
  const instances = ref<Instance[]>([])
  const currentInstanceId = ref<string>('local')
  const loading = ref(false)
  // 切换进行中（全屏遮罩）与目标实例 id（遮罩文案经 getInstanceDisplayName 推导）
  const switching = ref(false)
  const switchTargetId = ref('local')
  // 切换代数：连续切换时旧的遮罩收起定时器作废，避免中途收起露出脏 UI
  let switchSeq = 0
  // smart-stay 目标项目：切换前项目在新实例上的等价物 id，
  // 由 Layout 恢复流程在 uiState 恢复之后一次性消费（优先于 uiState 里记录的旧项目）
  const pendingProjectId = ref<string | null>(null)

  // 会话跳转意图（多实例总览「去操作」）：set 后由「目标实例」侧的 watcher 消费——
  // agent 会话在 AgentTerminalView（attach + 选中），shell 会话在 Layout
  // （选项目 + 底部终端 tab）。Pinia 状态跨实例切换的视图 remount 存活；
  // instanceId 必检：意图设置时旧实例树仍在挂载态，其 watcher 不得抢消费
  const pendingSessionJump = ref<{ instanceId: string; sessionId: string; projectId: string; kind: string } | null>(null)
  function setSessionJump(intent: { instanceId: string; sessionId: string; projectId: string; kind: string }): void {
    pendingSessionJump.value = intent
  }
  function consumeSessionJump(): { instanceId: string; sessionId: string; projectId: string; kind: string } | null {
    const j = pendingSessionJump.value
    pendingSessionJump.value = null
    return j
  }

  const currentInstance = computed<Instance>(() =>
    instances.value.find(i => i.id === currentInstanceId.value) || { id: 'local', name: 'Local', url: '', isLocal: true, status: 'unknown' as const, createdAt: '', updatedAt: '' }
  )

  const isRemote = computed(() => !currentInstance.value.isLocal)

  // 展示顺序：本机置顶，远程按名称字典序
  const orderedInstances = computed(() =>
    [...instances.value].sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1
      return a.name.localeCompare(b.name)
    }),
  )

  // 一次性领取 smart-stay 目标项目（读清原子化，避免消费方漏清）
  function consumePendingProjectId(): string | null {
    const v = pendingProjectId.value
    pendingProjectId.value = null
    return v
  }

  // in-flight 去重：多个触发点（App 启动 / 菜单打开 / 面板打开 / Layout 恢复守卫）
  // 并发调用时共用同一次请求，避免叠加重复 list + 批量探测
  let _instancesReq: Promise<void> | null = null

  function fetchInstances(): Promise<void> {
    if (_instancesReq) return _instancesReq
    _instancesReq = (async () => {
      loading.value = true
      try {
        // 后台拉取实例列表：失败仅写 Console，不打扰用户
        const res = await instanceApi.list({ silent: true })
        instances.value = (res.data || []).map((inst: Record<string, unknown>) => ({
          ...inst,
          status: (['online', 'offline', 'unknown', 'invalid'].includes(inst.status as string) ? inst.status : 'unknown') as Instance['status'],
        }))
        // 列表加载后静默批量探测远程实例状态（fire-and-forget）——
        // 否则新添加的实例无人探测，状态一直停在 unknown（黄点）
        void checkAllInstances(true)
      } catch { /* silent */ }
      finally { loading.value = false }
    })().finally(() => { _instancesReq = null })
    return _instancesReq
  }

  async function selectInstance(id: string) {
    const inst = instances.value.find(i => i.id === id)
    // 幂等守卫：目标不存在或已是当前实例时直接返回。
    // RouterView 以 currentInstanceId 为 key，remount 后 Layout 恢复流程会再次
    // 调用 selectInstance(同 id)——没有这个守卫会无限 remount
    if (!inst || id === currentInstanceId.value) return

    // 切换前确认（如有未保存内容）
    if (_beforeSwitch && !await _beforeSwitch()) return

    const seq = ++switchSeq
    switching.value = true
    switchTargetId.value = id
    pendingProjectId.value = null

    try {
      // 取消所有未完成请求，后续 API 走新实例的代理路径
      cancelAllRequests()
      setInstanceContext(id, !inst.isLocal)

      // 清理旧实例残留的全局 store 数据（组件作用域状态由 remount 销毁）
      const changesStore = useChangesStore()
      changesStore.files = []
      useConsoleStore().clear()
      useErrorLogStore().clear()

      // 项目列表：先清空再拉新实例——失败时显示空态而非残留旧实例项目。
      // 这里的拉取仅用于等价项目匹配与路由决策；remount 后的视图会按自己的
      // onMounted 流程再拉一次（保持视图自包含，接受这一次重复 RTT）
      const projectStore = useProjectStore()
      const oldProject = projectStore.currentProject
      const inProjectSpace = router.currentRoute.value.name === 'project'
      projectStore.currentProjectId = ''
      projectStore.projects = []
      try { await projectStore.fetchProjects() } catch { /* 拦截器已提示 */ }

      // smart-stay：项目空间内切换时找新实例上的等价项目（同 id / 同仓库同分支 / 同名），
      // 找到则记入 pendingProjectId 由 Layout 恢复流程消费，否则回首页
      if (inProjectSpace && oldProject) {
        const matched = matchEquivalentProject(oldProject, projectStore.projects)
        if (matched) pendingProjectId.value = matched.id
      }

      // 实例 id 最后置位：App.vue 的 RouterView 以它为 key，
      // 置位瞬间当前视图整树 remount，等于"重新进入"新实例
      currentInstanceId.value = id

      if (inProjectSpace && !pendingProjectId.value) {
        await router.push('/')
      }

      // 通知中心切换到新实例：清旧数据 + WS 重连 + 拉新实例历史
      useNotificationStore().switchInstance()

      // 等新视图首帧渲染后再收起遮罩；代数校验防止被上一次切换的定时器抢先收起
      await nextTick()
      setTimeout(() => { if (seq === switchSeq) switching.value = false }, SWITCH_OVERLAY_LINGER_MS)
    } catch {
      // 切换中途失败也要收起遮罩，避免全屏卡死
      if (seq === switchSeq) switching.value = false
    }
  }

  async function addInstance(data: { name: string; url: string; token?: string; parentId?: string }) {
    await instanceApi.add(data)
    await fetchInstances()
  }

  async function removeInstance(id: string) {
    await instanceApi.remove(id)
    await fetchInstances()
    if (currentInstanceId.value === id) {
      selectInstance('local')
    }
  }

  async function updateInstance(id: string, data: { name?: string; url?: string; token?: string; parentId?: string | null }) {
    await instanceApi.update(id, data)
    await fetchInstances()
  }

  async function checkInstance(id: string): Promise<Instance['status'] | null> {
    try {
      // 后台健康探测：失败仅写 Console，不打扰用户
      const res = await instanceApi.check(id, { silent: true })
      const status = (res.data as { status?: string } | undefined)?.status
      const inst = instances.value.find(i => i.id === id)
      if (inst && status) {
        inst.status = (['online', 'offline', 'unknown', 'invalid'].includes(status) ? status : 'unknown') as Instance['status']
      }
      return (inst?.status ?? null)
    } catch {
      const inst = instances.value.find(i => i.id === id)
      if (inst) inst.status = 'offline' as Instance['status']
      return 'offline'
    }
  }

  // 语义化刷新入口：列表为空（或强制）时重拉列表，否则仅按 TTL 探测状态。
  // 收敛"菜单打开 / 面板打开 / 手动刷新 / Layout 恢复守卫"的取数策略到一处
  function ensureInstancesFresh(force = false): Promise<void> {
    if (!instances.value.length || force) return fetchInstances()
    return checkAllInstances(force)
  }

  // 上次批量探测结束时间（TTL 内的非强制探测直接复用上次结果；
  // in-flight 去重与 fetchInstances 对称，避免探测 fan-out 叠加）
  let _lastProbeAt = 0
  let _probeReq: Promise<void> | null = null

  function checkAllInstances(force = false): Promise<void> {
    if (!force && Date.now() - _lastProbeAt < PROBE_TTL_MS) return Promise.resolve()
    if (_probeReq) return _probeReq
    _probeReq = (async () => {
      try {
        // 后台批量健康探测：失败仅写 Console，不打扰用户
        const res = await instanceApi.checkBatch({ silent: true })
        const results: Array<{ id: string; status: string; version?: string }> = res.data || []
        // 将数组转为 Map 以便快速查找
        const statusMap = new Map(results.map(r => [r.id, r]))
        for (const inst of instances.value) {
          if (!inst.isLocal) {
            const info = statusMap.get(inst.id)
            inst.status = (info?.status || 'unknown') as Instance['status']
            inst.version = info?.version || ''
          }
        }
      } catch { /* silent */ }
      finally {
        // 打点在结束后：探测耗时不占用 TTL 窗口；失败也计入，避免失败重试风暴
        _lastProbeAt = Date.now()
        _probeReq = null
      }
    })()
    return _probeReq
  }

  return {
    instances,
    orderedInstances,
    currentInstanceId,
    currentInstance,
    isRemote,
    loading,
    switching,
    switchTargetId,
    consumePendingProjectId,
    pendingSessionJump,
    setSessionJump,
    consumeSessionJump,
    fetchInstances,
    ensureInstancesFresh,
    selectInstance,
    addInstance,
    removeInstance,
    updateInstance,
    checkInstance,
    checkAllInstances,
  }
})
