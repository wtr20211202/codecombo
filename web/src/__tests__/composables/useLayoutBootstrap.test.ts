import { describe, it, expect, vi } from 'vitest'
import { ref, type Ref } from 'vue'
import { useLayoutBootstrap } from '@/composables/useLayoutBootstrap'

// bindPendingActionWatch 的分发契约单测（P-20261003-140 补）：
// bootstrap 本体依赖宿主状态无法在 jsdom 复刻，此处只装配 pendingAction
// watch 所需的最小 deps（其余方法不被该 watch 触达）。
// 已有覆盖面：terminal/panel/url/preview 分支由 notify-jump 等 e2e 真实例
// 端到端锁定；这里补 watch-fallback 分支（通知动作 → 翻转回调）与
// consumeAction 兜底（未知 action 也要消费防悬挂）。

function makeDeps() {
  return {
    getInstanceState: () => Promise.resolve(null),
    showRemoteConsole: ref(false),
    sidePanelWidth: ref(260),
    bottomPanelHeight: ref(300),
    showSidePanel: ref(true),
    showBottomPanel: ref(true),
    sideView: ref<'files'>('files'),
    bottomTab: ref('terminal'),
    commitLocation: ref(''),
    bottomPanelMaximized: ref(false),
    bottomPanelEditorMaximized: ref(false),
    splitOpen: ref(false),
    restoreSplitFiles: () => Promise.resolve(),
    restoreUntitledDrafts: () => Promise.resolve(),
    reconcileStaleDrafts: () => Promise.resolve(),
    ensureInstancesFresh: () => Promise.resolve(),
    selectInstance: () => Promise.resolve(),
    startInstanceId: () => 'local',
    currentProjectId: () => '',
    hasProject: () => false,
    setCurrentProject: () => {},
    consumePendingProjectId: () => null,
    consumeExplicitSelectId: () => null,
    fetchProjects: () => Promise.resolve(),
    fetchAllAheadBehind: () => Promise.resolve(),
    fetchBuildInfo: () => {},
    fetchStatus: () => {},
    openFileByPath: () => Promise.resolve(),
    openFilesCount: () => 0,
    setActiveFileIndex: () => {},
    revealExpandedDirs: () => {},
    restoreGitPanel: () => {},
    restoreTerminalTab: () => {},
  }
}

function bindAction() {
  const pendingAction: Ref<{ projectId?: string; action?: string; actionPayload?: unknown; title?: string; body?: string } | null> = ref(null)
  const consumed = vi.fn()
  const handlers = {
    switchProject: vi.fn(),
    openTerminalTab: vi.fn(),
    togglePanel: vi.fn(),
    openUrl: vi.fn(),
    openPreviewPort: vi.fn(),
    watchFallbackToggle: vi.fn(),
    agentFix: vi.fn(),
    switchInstance: vi.fn(),
    monitorFleet: vi.fn(),
  }
  const { bindPendingActionWatch } = useLayoutBootstrap(makeDeps())
  bindPendingActionWatch(pendingAction, consumed, handlers)
  return { pendingAction, consumed, handlers }
}

describe('useLayoutBootstrap bindPendingActionWatch watch-fallback 分支', () => {
  it('watch-fallback 动作触发翻转回调并消费 pendingAction', async () => {
    const { pendingAction, consumed, handlers } = bindAction()
    pendingAction.value = { action: 'watch-fallback', actionPayload: 'toggle' }
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.watchFallbackToggle).toHaveBeenCalledTimes(1)
    expect(consumed).toHaveBeenCalledTimes(1)
    // 其他分发分支不误触
    expect(handlers.openTerminalTab).not.toHaveBeenCalled()
    expect(handlers.togglePanel).not.toHaveBeenCalled()
    expect(handlers.openPreviewPort).not.toHaveBeenCalled()
  })

  it('空 payload 的 watch-fallback 同样触发（翻转语义不依赖 payload）', async () => {
    const { pendingAction, handlers } = bindAction()
    pendingAction.value = { action: 'watch-fallback' }
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.watchFallbackToggle).toHaveBeenCalledTimes(1)
  })

  // agent-fix 分支（P-20261003-289）：payload=部署任务 id 整项转交修复链，
  // title/body 随行供补拉失效降级组 prompt
  it('agent-fix 动作整项转交修复链（payload+title+body）并消费 pendingAction', async () => {
    const { pendingAction, consumed, handlers } = bindAction()
    pendingAction.value = {
      action: 'agent-fix',
      actionPayload: 'sc_dt_1',
      title: '部署失败：e2e-host · simple_coding',
      body: 'ssh dial: refused',
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.agentFix).toHaveBeenCalledTimes(1)
    expect(handlers.agentFix).toHaveBeenCalledWith(
      expect.objectContaining({ actionPayload: 'sc_dt_1', title: expect.stringContaining('部署失败'), body: 'ssh dial: refused' }),
    )
    expect(consumed).toHaveBeenCalledTimes(1)
    // 其他分发分支不误触
    expect(handlers.watchFallbackToggle).not.toHaveBeenCalled()
    expect(handlers.openTerminalTab).not.toHaveBeenCalled()
  })

  it('未知 action 不触发任何分支但仍消费（防 pendingAction 悬挂）', async () => {
    const { pendingAction, consumed, handlers } = bindAction()
    pendingAction.value = { action: 'no-such-type' }
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.watchFallbackToggle).not.toHaveBeenCalled()
    expect(handlers.agentFix).not.toHaveBeenCalled()
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  // monitor-fleet 分支（P-20261005-145）：编队完成通知直达大屏聚合卡，
  // payload=编队 batchId 原样转交（路由跳转由 useLayoutShell 接线承担）
  it('monitor-fleet 动作转交编队 batchId 并消费 pendingAction', async () => {
    const { pendingAction, consumed, handlers } = bindAction()
    pendingAction.value = { action: 'monitor-fleet', actionPayload: 'fleet-1759987200000000000' }
    await Promise.resolve()
    await Promise.resolve()
    expect(handlers.monitorFleet).toHaveBeenCalledTimes(1)
    expect(handlers.monitorFleet).toHaveBeenCalledWith('fleet-1759987200000000000')
    expect(consumed).toHaveBeenCalledTimes(1)
    expect(handlers.openTerminalTab).not.toHaveBeenCalled()
  })

  // 跨项目跳转接切换守卫（P-20261003-105）：switchProject 返回裁决——
  // true（含守卫同步放行）分发后续动作；false（草稿确认选「取消」）整条放弃
  // 但仍消费（用户已裁决留在原项目，重试只会再弹一次）
  it('switchProject 放行（true）→ 分发后续动作', async () => {
    const { pendingAction, consumed, handlers } = bindAction()
    handlers.switchProject.mockResolvedValue(true)
    pendingAction.value = { projectId: 'p2', action: 'panel', actionPayload: 'changes' }
    await vi.waitFor(() => expect(handlers.togglePanel).toHaveBeenCalledTimes(1))
    expect(handlers.switchProject).toHaveBeenCalledWith('p2')
    expect(handlers.togglePanel).toHaveBeenCalledWith('changes')
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  it('switchProject 取消（false）→ 放弃后续动作但仍消费', async () => {
    const { pendingAction, consumed, handlers } = bindAction()
    handlers.switchProject.mockResolvedValue(false)
    pendingAction.value = { projectId: 'p2', action: 'terminal', actionPayload: 's1' }
    await vi.waitFor(() => expect(consumed).toHaveBeenCalledTimes(1))
    expect(handlers.openTerminalTab).not.toHaveBeenCalled()
  })

  // immediate 回放（P-20261007-15）：路由桥接链（通知 store 非 project 路由先
  // push /project）落进项目页时 pendingAction 已是存量，绑定时刻立即分发——
  // 此前 watch 非 immediate，桥接带来的存量无人回放、动作彻底丢失
  it('绑定时刻的存量 pendingAction 立即回放（immediate）', async () => {
    const pendingAction: Ref<{ projectId?: string; action?: string; actionPayload?: unknown; title?: string; body?: string } | null> =
      ref({ action: 'watch-fallback', actionPayload: 'toggle' })
    const consumed = vi.fn()
    const handlers = {
      switchProject: vi.fn(),
      openTerminalTab: vi.fn(),
      togglePanel: vi.fn(),
      openUrl: vi.fn(),
      openPreviewPort: vi.fn(),
      watchFallbackToggle: vi.fn(),
      agentFix: vi.fn(),
      switchInstance: vi.fn(),
      monitorFleet: vi.fn(),
    }
    const { bindPendingActionWatch } = useLayoutBootstrap(makeDeps())
    bindPendingActionWatch(pendingAction, consumed, handlers)
    await vi.waitFor(() => expect(handlers.watchFallbackToggle).toHaveBeenCalledTimes(1))
    expect(consumed).toHaveBeenCalledTimes(1)
  })

  // 绑定时无存量：immediate 对 null 无操作（挂载期零副作用——正常页内路径不变）
  it('绑定时刻 pendingAction 为 null 零副作用', async () => {
    const { pendingAction, consumed, handlers } = bindAction()
    // bindAction 内部绑定后同步断言：immediate 首帧（null）未触发任何分发
    expect(handlers.watchFallbackToggle).not.toHaveBeenCalled()
    expect(consumed).not.toHaveBeenCalled()
    // 后续正常 set 仍照常分发（回放不吞后续变更）
    pendingAction.value = { action: 'monitor-fleet', actionPayload: 'b1' }
    await vi.waitFor(() => expect(handlers.monitorFleet).toHaveBeenCalledTimes(1))
    expect(consumed).toHaveBeenCalledTimes(1)
  })
})

// 项目仪表盘默认落点（P-20261005-224）：bootstrap 对「显式进入项目」且偏好开启
// 时申请落位；刷新恢复（无显式标记）/偏好关闭不落。让位条件在宿主闭包内裁决，
// 本单测只锁 bootstrap 侧的触发纪律
describe('useLayoutBootstrap 项目仪表盘默认落点', () => {
  function landingDeps(opts: { explicit: boolean; landing: boolean }) {
    const openDashboardLanding = vi.fn()
    const deps = {
      ...makeDeps(),
      hasProject: () => true,
      consumeExplicitSelectId: () => (opts.explicit ? 'p1' : null),
      getDashboardLanding: () => Promise.resolve(opts.landing),
      openDashboardLanding,
    }
    return { openDashboardLanding, deps }
  }

  it('显式进入 + 偏好开启 → 申请落位', async () => {
    const { openDashboardLanding, deps } = landingDeps({ explicit: true, landing: true })
    await useLayoutBootstrap(deps).bootstrap()
    expect(openDashboardLanding).toHaveBeenCalledTimes(1)
  })

  it('刷新恢复（无显式标记）→ 不落', async () => {
    const { openDashboardLanding, deps } = landingDeps({ explicit: false, landing: true })
    await useLayoutBootstrap(deps).bootstrap()
    expect(openDashboardLanding).not.toHaveBeenCalled()
  })

  it('显式进入 + 偏好关闭 → 不落', async () => {
    const { openDashboardLanding, deps } = landingDeps({ explicit: true, landing: false })
    await useLayoutBootstrap(deps).bootstrap()
    expect(openDashboardLanding).not.toHaveBeenCalled()
  })
})
