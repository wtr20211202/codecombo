import { watch } from 'vue'
import { useProjectStore } from '../stores/project'
import { useInstanceStore } from '../stores/instance'
import { useChangesStore } from '../stores/changes'
import { useLogStore } from '../stores/log'
import { useBranchStore } from '../stores/branch'
import { useConsoleStore, type CommandLog } from '../stores/console'
import { getCurrentInstanceContext } from '../api/client'
import { useWebSocketBase } from './useWebSocketBase'
import { GIT_PANEL_AUTO_REFRESH } from './useGitPanelAutoRefresh'
import { registerReconnectRefetch, runReconnectRefetches } from './reconnectRefetch'
import { useLockStore, getUnlockToken } from '../stores/lock'

// 前端防抖：避免短时间内多次 file.changed 触发大量 API 请求
let fileChangedTimer: ReturnType<typeof setTimeout> | null = null
let pendingFileChanged = false

/** 项目文件变更广播（file.changed 防抖后派发的 window 事件，无 payload）：
 *  供文件树 Agent 改动标记等轻量消费方订阅，避免各自直连 WS */
export const PROJECT_FILE_CHANGED = 'sc:project-file-changed'
// branch/log.changed 同款防抖（批量提交/rebase 期间高频）
let branchChangedTimer: ReturnType<typeof setTimeout> | null = null
let pendingBranchChanged = false
let logChangedTimer: ReturnType<typeof setTimeout> | null = null
let pendingLogChanged = false

// 项目域重连补拉（P-20261001-19 原 refetchAfterReconnect 迁入集中注册表，
// P-20261003-236）：断线窗口期的 file/branch/log.changed 广播不可回放，重连
// 后一次性重拉三 store + 项目列表，休眠唤醒/网络切换后不再停留在旧世界。
// 复用各 store 自带 loading 态的幂等 fetch，与 300ms 防抖 timer 无关——那是
// 事件路径的合并器。重连风暴下随每次重连触发，但重连本身有 3s 起步指数退避
// 兜底，4 个幂等 GET 可接受，不再加节流（全表量级注记见 reconnectRefetch.ts）
registerReconnectRefetch('project', () => {
  const pid = useProjectStore().currentProjectId
  if (!pid) return
  // allSettled：重连窗口期后端可能仍在恢复，任一失败不拖累其余、也不产生
  // 未处理 rejection——下一轮断线重连会再补
  void Promise.allSettled([
    useChangesStore().fetchStatus(pid),
    useBranchStore().fetchBranches(pid),
    useLogStore().fetchLog(pid),
    useProjectStore().fetchProjects(),
  ])
})

export function useWebSocket() {
  const projectStore = useProjectStore()
  const instanceStore = useInstanceStore()
  const lockStore = useLockStore()

  function getUrl(): string {
    const projectId = projectStore.currentProjectId
    if (!projectId) return ''
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const { isRemote, instanceId } = getCurrentInstanceContext()
    if (isRemote && instanceId) {
      return `${protocol}//${location.host}/ws/proxy/${instanceId}/projects/${projectId}`
    }
    return `${protocol}//${location.host}/ws/projects/${projectId}`
  }

  function handleMessage(event: MessageEvent) {
    try {
      const msg = JSON.parse(event.data)
      dispatchMessage(msg)
    } catch {
      // 忽略无效消息
    }
  }

  function dispatchMessage(msg: { type: string; data?: unknown }) {
    const projectId = projectStore.currentProjectId
    if (!projectId) return

    switch (msg.type) {
      case 'file.changed':
        // 300ms 防抖，合并高频文件变更事件
        pendingFileChanged = true
        if (fileChangedTimer) return
        fileChangedTimer = setTimeout(() => {
          fileChangedTimer = null
          if (!pendingFileChanged) return
          pendingFileChanged = false
          const pid = useProjectStore().currentProjectId
          if (!pid) return
          const store = useChangesStore()
          store.fetchStatus(pid)
          if (store.selectedFile) {
            store.fetchFileDiff(pid, store.selectedFile)
          }
          // 广播给无 WS 依赖的轻量消费方（如文件树的 Agent 改动标记）——
          // 复用本处 300ms 防抖，消费方自行决定是否再节流
          window.dispatchEvent(new CustomEvent(PROJECT_FILE_CHANGED))
        }, 300)
        break
      case 'branch.changed':
        // 300ms 尾沿防抖（同 file.changed）：rebase/批量提交期间每个分支事件
        // 都直触 fetchBranches+fetchProjects 会形成 git 子进程风暴
        pendingBranchChanged = true
        if (branchChangedTimer) return
        branchChangedTimer = setTimeout(() => {
          branchChangedTimer = null
          if (!pendingBranchChanged) return
          pendingBranchChanged = false
          const pid = useProjectStore().currentProjectId
          if (!pid) return
          useBranchStore().fetchBranches(pid)
          useProjectStore().fetchProjects()
        }, 300)
        break
      case 'log.changed':
        // 防抖理由同上（log.changed 在批量提交期间高频）
        pendingLogChanged = true
        if (logChangedTimer) return
        logChangedTimer = setTimeout(() => {
          logChangedTimer = null
          if (!pendingLogChanged) return
          pendingLogChanged = false
          const pid = useProjectStore().currentProjectId
          if (!pid) return
          useLogStore().fetchLog(pid)
        }, 300)
        break
      case 'git.command':
        useConsoleStore().addLog(msg.data as CommandLog)
        break
      case 'git.activity':
        // TUI 运行时 git 写活动的服务端感知（P-20261004-81）：会话内子进程
        // git（TUI/脚本，无 OSC 133）由服务端 readLoop 嗅探命中经 busbridge
        // 定向广播到本项目 WS。并轨 sc:git-panel-autorefresh 既有链——面板侧
        // 1s 去抖 / in-flight 去重 / 3.3s TTL 兜底拉取全部复用，此处只做转发
        //（载荷 {kind,ref,sessionId,projectId,at} 面板不消费，agent 订阅面见
        // ops 手册 git 节）
        window.dispatchEvent(new CustomEvent(GIT_PANEL_AUTO_REFRESH))
        break
    }
  }

  // 上一次成功 onopen 时的项目 id（本装配实例内）。补拉判别规则：
  //   pid === lastOpenedProjectId（同项目重连）或 lastOpenedProjectId 为空
  //   （本实例首个成功 onopen——含「离线进入项目后首开迟到到恢复重连」，
  //   此时进入链的拉取早已落定，缺的正是断线窗口）→ 补拉；
  //   pid 变化（项目切换）→ 不补拉，切换链自会全量拉取。
  // 不能用 base 的 attempts>0 判别（提案原案）：handleRecovery（切回标签页/
  // 网络恢复，正是休眠唤醒的主恢复路径）会先把 attempts 归零再立即重连，
  // onOpen 收到 0，补拉会在最需要它的场景被整个跳过。也不能「跳过首个成功
  // onopen」：离线态进入项目时 WS 首开被截胡，首个成功 onopen 就是恢复重连
  // 本身（e2e 实测抓出该漏补），跳过它=离线进入场景永远不补
  let lastOpenedProjectId = ''

  // 重连触发点：本通道 onOpen 按下方判别决定是否全表补拉（集中注册表遍历，
  // 不再只是项目域——同一次断网里各通道同生共死，任一恢复即全量补拉一遍；
  // 各域 fn 幂等，重复执行无害）。项目切换（id 变化）不触发：切换链自会全量拉取
  const base = useWebSocketBase({
    getUrl,
    // 子协议携带 unlock token（内存态，P-20261019-2）：内存缺省时握手不带
    // 子协议，由浏览器自动携带的 HttpOnly cookie 兜底
    getProtocols: () => {
      const token = getUnlockToken()
      return token ? [token] : undefined
    },
    onMessage: handleMessage,
    onOpen: () => {
      const pid = projectStore.currentProjectId
      // 补拉判别（原语义）：同项目再开（真重连）或本实例尚无成功 onopen（含
      // 离线进入后首开迟到到恢复重连）；仅项目切换（pid 变化）不补拉
      const shouldRefetch = !!pid && (pid === lastOpenedProjectId || !lastOpenedProjectId)
      if (shouldRefetch) runReconnectRefetches()
      if (pid) lastOpenedProjectId = pid
      // git 面板顺带刷新（P-20261005-7）：分支树/变更面板不读 branch/changes
      // store（GitBranchesSection.fetchBranchesAndTags 是独立 fetch 链），store
      // 补拉惠及不到它们——与补拉同谓词并轨派发 sc:git-panel-autorefresh 既有
      // 窗口事件，面板侧 1s 去抖/in-flight 去重/3.3s TTL 兜底全复用，零新机制。
      // 与补拉同点同步派发即可，不必等补拉完成：面板 fetch 自带数据源（不消费
      // store 结果），且分支/标签端点无服务端缓存（3s TTL 只罩 status，
      // status_cache.go 仅 /status 与文件树消费）。在线首开的派发是冗余幂等
      // GET（挂载链已首拉，面板侧去抖合并）——与「离线进入必须补拉」共用谓词
      // 的代价，同 P-19 对四 store 的既有裁决；项目切换不派发（切换链自会拉取）
      if (shouldRefetch) window.dispatchEvent(new CustomEvent(GIT_PANEL_AUTO_REFRESH))
    },
    // 门控：锁定状态下不连接，避免握手被中间件拒绝后陷入重连死循环
    shouldConnect: () => !lockStore.isLocked,
  })

  function disconnect() {
    if (fileChangedTimer) {
      clearTimeout(fileChangedTimer)
      fileChangedTimer = null
    }
    pendingFileChanged = false
    // branch/log.changed 防抖 timer 一并清理（模块级状态，漏清会在断开后
    // 仍触发一次对旧项目的拉取）
    if (branchChangedTimer) {
      clearTimeout(branchChangedTimer)
      branchChangedTimer = null
    }
    pendingBranchChanged = false
    if (logChangedTimer) {
      clearTimeout(logChangedTimer)
      logChangedTimer = null
    }
    pendingLogChanged = false
    base.disconnect()
  }

  function connect() {
    // 锁定时不连接：避免握手被中间件拒绝后陷入重连循环
    if (lockStore.isLocked) return
    base.connect()
  }

  // 监听项目或实例切换，自动连接对应 WebSocket
  watch(
    () => [projectStore.currentProjectId, instanceStore.currentInstanceId] as const,
    ([newId]) => {
      if (newId) {
        connect()
      } else {
        disconnect()
      }
    },
    { immediate: true },
  )

  // 锁定状态联动：锁定 → 断开；解锁 → 重连当前项目
  watch(() => lockStore.isLocked, (locked) => {
    if (locked) {
      disconnect()
    } else if (projectStore.currentProjectId) {
      connect()
    }
  })

  return {
    connected: base.connected,
    disconnect,
  }
}
