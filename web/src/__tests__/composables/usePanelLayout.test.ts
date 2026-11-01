import { describe, it, expect, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { usePanelLayout, resetPanelLayout } from '@/composables/usePanelLayout'

describe('usePanelLayout', () => {
  beforeEach(() => {
    resetPanelLayout()
  })

  it('初始状态', () => {
    const panel = usePanelLayout()
    expect(panel.sideView.value).toBe('files')
    expect(panel.showSidePanel.value).toBe(true)
    expect(panel.showBottomPanel.value).toBe(false)
    expect(panel.bottomTab.value).toBe('terminal')
    expect(panel.commitLocation.value).toBe('sidebar')
    expect(panel.sidePanelWidth.value).toBe(280)
    expect(panel.bottomPanelHeight.value).toBe(260)
    expect(panel.bottomPanelMaximized.value).toBe(false)
    expect(panel.bottomPanelEditorMaximized.value).toBe(false)
  })

  it('togglePanel files 打开侧面板', () => {
    const panel = usePanelLayout()
    panel.showSidePanel.value = false
    panel.togglePanel('files')
    expect(panel.showSidePanel.value).toBe(true)
    expect(panel.sideView.value).toBe('files')
  })

  it('togglePanel files 关闭已激活的侧面板', () => {
    const panel = usePanelLayout()
    // 初始已显示 files，再次调用应关闭
    panel.togglePanel('files')
    expect(panel.showSidePanel.value).toBe(false)
  })

  it('togglePanel terminal 打开底部面板', () => {
    const panel = usePanelLayout()
    panel.togglePanel('terminal')
    expect(panel.showBottomPanel.value).toBe(true)
    expect(panel.bottomTab.value).toBe('terminal')
  })

  it('togglePanel terminal 关闭已激活的底部面板', () => {
    const panel = usePanelLayout()
    panel.togglePanel('terminal') // 打开
    panel.togglePanel('terminal') // 关闭
    expect(panel.showBottomPanel.value).toBe(false)
  })

  it('togglePanel git 打开底部 Git 面板', () => {
    const panel = usePanelLayout()
    panel.togglePanel('git')
    expect(panel.showBottomPanel.value).toBe(true)
    expect(panel.bottomTab.value).toBe('git')
  })

  it('togglePanel git 关闭已激活的底部面板', () => {
    const panel = usePanelLayout()
    panel.togglePanel('git') // 打开
    panel.togglePanel('git') // 关闭
    expect(panel.showBottomPanel.value).toBe(false)
  })

  it('maximizeBottomPanel 切换最大化', () => {
    const panel = usePanelLayout()
    expect(panel.bottomPanelMaximized.value).toBe(false)
    panel.maximizeBottomPanel()
    expect(panel.bottomPanelMaximized.value).toBe(true)
    panel.maximizeBottomPanel()
    expect(panel.bottomPanelMaximized.value).toBe(false)
  })

  it('maximizeBottomPanelEditor 切换编辑器区域最大化', () => {
    const panel = usePanelLayout()
    expect(panel.bottomPanelEditorMaximized.value).toBe(false)
    panel.maximizeBottomPanelEditor()
    expect(panel.bottomPanelEditorMaximized.value).toBe(true)
    panel.maximizeBottomPanelEditor()
    expect(panel.bottomPanelEditorMaximized.value).toBe(false)
  })

  it('全屏与编辑器区域最大化互斥', () => {
    const panel = usePanelLayout()
    // 开启全屏后开启编辑器：全屏应被关闭
    panel.maximizeBottomPanel()
    expect(panel.bottomPanelMaximized.value).toBe(true)
    panel.maximizeBottomPanelEditor()
    expect(panel.bottomPanelMaximized.value).toBe(false)
    expect(panel.bottomPanelEditorMaximized.value).toBe(true)
    // 反之亦然
    panel.maximizeBottomPanel()
    expect(panel.bottomPanelEditorMaximized.value).toBe(false)
    expect(panel.bottomPanelMaximized.value).toBe(true)
  })

  it('maximizeTerminal 切换终端最大化', () => {
    const panel = usePanelLayout()
    expect(panel.terminalMaximized.value).toBe(false)
    panel.maximizeTerminal()
    expect(panel.terminalMaximized.value).toBe(true)
    panel.maximizeTerminal()
    expect(panel.terminalMaximized.value).toBe(false)
  })

  it('终端最大化与其他两种互斥', () => {
    const panel = usePanelLayout()
    panel.maximizeBottomPanel()
    panel.maximizeTerminal()
    expect(panel.bottomPanelMaximized.value).toBe(false)
    expect(panel.terminalMaximized.value).toBe(true)

    panel.maximizeBottomPanelEditor()
    expect(panel.terminalMaximized.value).toBe(false)
    expect(panel.bottomPanelEditorMaximized.value).toBe(true)
  })

  it('exitMaximizedByEsc 按优先级退出最大化', () => {
    const panel = usePanelLayout()
    // 无最大化状态时返回 false
    expect(panel.exitMaximizedByEsc()).toBe(false)

    // 终端最大化优先退出
    panel.maximizeTerminal()
    expect(panel.exitMaximizedByEsc()).toBe(true)
    expect(panel.terminalMaximized.value).toBe(false)

    // 编辑器区域其次
    panel.maximizeBottomPanelEditor()
    expect(panel.exitMaximizedByEsc()).toBe(true)
    expect(panel.bottomPanelEditorMaximized.value).toBe(false)

    // 全屏最后
    panel.maximizeBottomPanel()
    expect(panel.exitMaximizedByEsc()).toBe(true)
    expect(panel.bottomPanelMaximized.value).toBe(false)
  })

  // 编辑器组临时最大化（P-20261004-64）：toggle 语义 + 与面板级不互斥
  it('toggleEditorGroupMaximized 组级 toggle 与还原', () => {
    const panel = usePanelLayout()
    expect(panel.editorGroupMaximized.value).toBeNull()
    panel.toggleEditorGroupMaximized(0)
    expect(panel.editorGroupMaximized.value).toBe(0)
    // 同组再点还原
    panel.toggleEditorGroupMaximized(0)
    expect(panel.editorGroupMaximized.value).toBeNull()
    // 换组直达（组 1 最大化中点组 0 → 目标换成组 0）
    panel.toggleEditorGroupMaximized(1)
    panel.toggleEditorGroupMaximized(0)
    expect(panel.editorGroupMaximized.value).toBe(0)
  })

  it('组/pane 最大化与面板级最大化不互清（分层退栈）', () => {
    const panel = usePanelLayout()
    panel.toggleEditorGroupMaximized(1)
    panel.maximizeTerminal()
    // 面板级开启不清内层组态（覆盖其上时自然不可见，退栈逐层回）
    expect(panel.editorGroupMaximized.value).toBe(1)
    // Esc 先退外层面板
    expect(panel.exitMaximizedByEsc()).toBe(true)
    expect(panel.terminalMaximized.value).toBe(false)
    // 再退内层组
    expect(panel.exitMaximizedByEsc()).toBe(true)
    expect(panel.editorGroupMaximized.value).toBeNull()
    // 全退后放行
    expect(panel.exitMaximizedByEsc()).toBe(false)
  })

  it('exitMaximizedByEsc 内层序：组先 pane 后（P-20261004-64 逐层退栈）', () => {
    const panel = usePanelLayout()
    panel.toggleEditorGroupMaximized(0)
    panel.toggleTerminalPaneMaximized('t1', 't1')
    expect(panel.exitMaximizedByEsc()).toBe(true)
    expect(panel.editorGroupMaximized.value).toBeNull()
    expect(panel.terminalPaneMaximized.value).not.toBeNull()
    expect(panel.exitMaximizedByEsc()).toBe(true)
    expect(panel.terminalPaneMaximized.value).toBeNull()
  })

  it('toggleTerminalPaneMaximized pane 级 toggle（P-20261004-64）', () => {
    const panel = usePanelLayout()
    expect(panel.terminalPaneMaximized.value).toBeNull()
    panel.toggleTerminalPaneMaximized('t1', 't1')
    expect(panel.terminalPaneMaximized.value).toEqual({ tabId: 't1', paneId: 't1' })
    // 同 pane 再点还原
    panel.toggleTerminalPaneMaximized('t1', 't1')
    expect(panel.terminalPaneMaximized.value).toBeNull()
    // 换 pane 直达
    panel.toggleTerminalPaneMaximized('t1', 'p2')
    expect(panel.terminalPaneMaximized.value).toEqual({ tabId: 't1', paneId: 'p2' })
  })

  it('restoreFromMaximized 全清兜底盖住组/pane 两级（P-20261004-64）', () => {
    const panel = usePanelLayout()
    panel.toggleEditorGroupMaximized(0)
    panel.toggleTerminalPaneMaximized('t1', 'p2')
    expect(panel.restoreFromMaximized()).toBe(true)
    expect(panel.editorGroupMaximized.value).toBeNull()
    expect(panel.terminalPaneMaximized.value).toBeNull()
    // 全空态再调返回 false 且保持空
    expect(panel.restoreFromMaximized()).toBe(false)
  })

  it('dismissBottomPanelByEsc 收起底栏面板（P-20261004-12 逐层退出最内层）', () => {
    const panel = usePanelLayout()
    // 面板未开：返回 false 放行（不消费）
    expect(panel.dismissBottomPanelByEsc()).toBe(false)
    expect(panel.showBottomPanel.value).toBe(false)

    // 面板开着：收起并消费一层
    panel.togglePanel('terminal')
    expect(panel.showBottomPanel.value).toBe(true)
    expect(panel.dismissBottomPanelByEsc()).toBe(true)
    expect(panel.showBottomPanel.value).toBe(false)
  })

  it('dismissBottomPanelByEsc 收起时连带清最大化态（面板隐藏 watch）', async () => {
    const panel = usePanelLayout()
    panel.togglePanel('terminal')
    // 面板开合至少跨一帧（真实使用节奏）：同 tick 内 false→true→false 会被
    // watch 的 hasChanged 去重吃掉，回调不触发——那是测试态伪象非生产行为
    await nextTick()
    panel.maximizeTerminal()
    expect(panel.terminalMaximized.value).toBe(true)
    expect(panel.dismissBottomPanelByEsc()).toBe(true)
    await nextTick()
    expect(panel.showBottomPanel.value).toBe(false)
    expect(panel.terminalMaximized.value).toBe(false)
  })

  it('面板隐藏连带清 pane 临时最大化（P-20261004-64，防不可见态隔空消费 Esc）', async () => {
    const panel = usePanelLayout()
    panel.togglePanel('terminal')
    await nextTick()
    panel.toggleTerminalPaneMaximized('t1', 'p2')
    expect(panel.terminalPaneMaximized.value).toEqual({ tabId: 't1', paneId: 'p2' })
    panel.showBottomPanel.value = false
    await nextTick()
    expect(panel.terminalPaneMaximized.value).toBeNull()
  })

  it('切换 sideView', () => {
    const panel = usePanelLayout()
    panel.sideView.value = 'changes'
    expect(panel.sideView.value).toBe('changes')
    panel.sideView.value = 'files'
    expect(panel.sideView.value).toBe('files')
  })

  // navigate {view:'changes'} 注意力引导（P-20261005-223）：focusPanel ensure
  // 语义与 togglePanel 开关语义的区分 + pendingSideView 跳转意图打标
  describe('focusPanel / pendingSideView（P-20261005-223）', () => {
    it('focusPanel 已可见时保持打开（无「收起」半程）', () => {
      const panel = usePanelLayout()
      panel.sideView.value = 'changes'
      panel.showSidePanel.value = true
      panel.focusPanel('changes')
      expect(panel.showSidePanel.value).toBe(true)
      expect(panel.sideView.value).toBe('changes')
    })

    it('focusPanel 未打开时打开并切视图', () => {
      const panel = usePanelLayout()
      panel.showSidePanel.value = false
      panel.focusPanel('changes')
      expect(panel.showSidePanel.value).toBe(true)
      expect(panel.sideView.value).toBe('changes')
    })

    it('focusPanel 被最大化覆盖时先还原再落位（togglePanel 同款规则）', () => {
      const panel = usePanelLayout()
      panel.maximizeTerminal()
      panel.focusPanel('changes')
      expect(panel.terminalMaximized.value).toBe(false)
      expect(panel.showSidePanel.value).toBe(true)
      expect(panel.sideView.value).toBe('changes')
    })

    it('focusPanel git 落底部 tab 且不触碰侧栏', () => {
      const panel = usePanelLayout()
      panel.showSidePanel.value = false
      panel.focusPanel('git')
      expect(panel.showBottomPanel.value).toBe(true)
      expect(panel.bottomTab.value).toBe('git')
      expect(panel.showSidePanel.value).toBe(false)
    })

    it('pendingSideView 消费一次 + resetPanelLayout 清账', () => {
      const panel = usePanelLayout()
      panel.pendingSideView.value = 'changes'
      expect(panel.consumePendingSideView()).toBe('changes')
      expect(panel.consumePendingSideView()).toBeNull()
      panel.pendingSideView.value = 'changes'
      resetPanelLayout()
      expect(panel.consumePendingSideView()).toBeNull()
    })
  })
})

// dshMaximized：关闭控制台 / 全局重置时必须还原（最大化跨会话残留会让下次
// 打开直接全屏，属状态泄漏）
describe('dshMaximized reset', () => {
  it('toggleDshConsole 关闭时还原 dshMaximized', async () => {
    vi.resetModules()
    const { usePanelLayout } = await import('../../composables/usePanelLayout')
    const layout = usePanelLayout()
    layout.showDshConsole.value = true
    layout.dshMaximized.value = true
    layout.toggleDshConsole()
    expect(layout.dshMaximized.value).toBe(false)
  })

  it('resetPanelLayout 还原 dshMaximized', async () => {
    vi.resetModules()
    const mod = await import('../../composables/usePanelLayout')
    const layout = mod.usePanelLayout()
    layout.dshMaximized.value = true
    mod.resetPanelLayout()
    expect(layout.dshMaximized.value).toBe(false)
  })
})

// 主区视图互斥（dsh 方向补全）：此前开远程/分享只互相关闭对方，dsh 泄漏为
// 双视图叠加；打开文件路径（showEditorMain）也依赖 closeDshConsole 切回编辑器
describe('主区视图互斥（dsh）', () => {
  it('开远程控制台关闭 dsh 控制台', () => {
    const panel = usePanelLayout()
    panel.toggleDshConsole()
    expect(panel.showDshConsole.value).toBe(true)
    panel.toggleRemoteConsole()
    expect(panel.showRemoteConsole.value).toBe(true)
    expect(panel.showDshConsole.value).toBe(false)
  })

  it('开分享管理关闭 dsh 控制台', () => {
    const panel = usePanelLayout()
    panel.toggleDshConsole()
    panel.toggleShareManager()
    expect(panel.showShareManager.value).toBe(true)
    expect(panel.showDshConsole.value).toBe(false)
  })

  it('closeDshConsole 还原 dshMaximized 且重复调用安全', () => {
    const panel = usePanelLayout()
    panel.showDshConsole.value = true
    panel.dshMaximized.value = true
    panel.closeDshConsole()
    expect(panel.showDshConsole.value).toBe(false)
    expect(panel.dshMaximized.value).toBe(false)
    panel.closeDshConsole()
    expect(panel.dshMaximized.value).toBe(false)
  })
})

// 项目仪表盘主区视图（P-20261005-224）：与远程/分享/dsh 同层级互斥 + toggle 语义 +
// resetPanelLayout 清账（测试态泄漏会让后续用例把「编辑器被盖住」误当既有态）
describe('主区视图互斥（项目仪表盘）', () => {
  beforeEach(() => {
    resetPanelLayout()
  })

  it('openDashboard 关闭远程/分享/dsh，幂等重复开零变化', () => {
    const panel = usePanelLayout()
    panel.showRemoteConsole.value = true
    panel.showShareManager.value = true
    panel.showDshConsole.value = true
    panel.openDashboard()
    expect(panel.showDashboard.value).toBe(true)
    expect(panel.showRemoteConsole.value).toBe(false)
    expect(panel.showShareManager.value).toBe(false)
    expect(panel.showDshConsole.value).toBe(false)
    panel.openDashboard()
    expect(panel.showDashboard.value).toBe(true)
  })

  it('toggleDashboard 开↔关；重开后其他主区视图被收回', () => {
    const panel = usePanelLayout()
    panel.toggleDashboard()
    expect(panel.showDashboard.value).toBe(true)
    panel.toggleDashboard()
    expect(panel.showDashboard.value).toBe(false)
    panel.showRemoteConsole.value = true
    panel.toggleDashboard()
    expect(panel.showDashboard.value).toBe(true)
    expect(panel.showRemoteConsole.value).toBe(false)
  })

  it('closeDashboard 收回；resetPanelLayout 清账', () => {
    const panel = usePanelLayout()
    panel.openDashboard()
    panel.closeDashboard()
    expect(panel.showDashboard.value).toBe(false)
    panel.openDashboard()
    resetPanelLayout()
    expect(panel.showDashboard.value).toBe(false)
  })
})
