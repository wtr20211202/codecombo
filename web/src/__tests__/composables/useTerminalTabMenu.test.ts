import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { useTerminalTabMenu } from '@/composables/useTerminalTabMenu'
import type { TermTab } from '@/composables/useTerminalTabs'

// 终端 tab 右键菜单动作派发（P-20261004-103 新增 replayShare 分支）：
// 菜单开合/目标 tab 选择/新增动作回调接线——渲染与真实入口由 e2e 覆盖

const tab: TermTab = { id: 't1', name: 'shell', projectId: 'p1' }

function makeMenu() {
  const selectTab = vi.fn()
  const replayShareTab = vi.fn()
  const frozenShareTab = vi.fn()
  const api = useTerminalTabMenu({
    tabs: ref([tab]),
    selectTab,
    startRename: vi.fn(),
    requestCloseTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    closeRightTabs: vi.fn(),
    closeAllTabs: vi.fn(),
    toggleFloatTab: vi.fn(),
    replayShareTab,
    frozenShareTab,
  })
  return { api, selectTab, replayShareTab, frozenShareTab }
}

describe('useTerminalTabMenu 回放分享动作', () => {
  it('右键记录目标 tab，replayShare 派发到回调并关闭菜单', async () => {
    const { api, selectTab, replayShareTab } = makeMenu()
    api.showTabContextMenu(
      { preventDefault: vi.fn(), clientX: 10, clientY: 20 } as unknown as MouseEvent,
      tab,
    )
    expect(selectTab).toHaveBeenCalledWith('t1')
    expect(api.tabContextMenu.value?.tabId).toBe('t1')

    await api.handleTabContextAction('replayShare')
    expect(replayShareTab).toHaveBeenCalledWith(tab)
    expect(api.tabContextMenu.value).toBeNull()
  })

  it('既有 frozenShare 动作不受新分支影响', async () => {
    const { api, frozenShareTab } = makeMenu()
    api.showTabContextMenu(
      { preventDefault: vi.fn(), clientX: 0, clientY: 0 } as unknown as MouseEvent,
      tab,
    )
    await api.handleTabContextAction('frozenShare')
    expect(frozenShareTab).toHaveBeenCalledWith(tab)
  })
})
