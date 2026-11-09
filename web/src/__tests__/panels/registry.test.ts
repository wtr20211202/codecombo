import { describe, it, expect, afterEach } from 'vitest'
import {
  registerPanel, unregisterPanel, getPanel, panelList, toggleablePanelIds,
  moveRailPanel, restoreRailTopOrder, railTopIds,
} from '../../panels/registry'
import { usePanelLayout, resetPanelLayout } from '../../composables/usePanelLayout'

describe('panelRegistry', () => {
  // 手动序是模块级单例状态：每例后归一，防污染同文件的自然序断言
  afterEach(() => {
    restoreRailTopOrder(null)
  })

  it('内置面板已注册：活动栏顺序稳定', () => {
    const rail = panelList('rail-top').map(p => p.id)
    expect(rail).toEqual(['files', 'changes', 'todos', 'git', 'terminal', 'notes', 'stream', 'agent-terminal', 'share-manager', 'dsh-console', 'remote-console', 'dashboard', 'env', 'sync'])
  })

  it('内置底部 Tab 已注册且顺序稳定', () => {
    const tabs = panelList('bottom-tab').map(p => p.id)
    expect(tabs).toEqual(['terminal', 'git', 'preview', 'problems', 'console'])
  })

  it('registerPanel 注册的新面板出现在组内（新面板 = 一次注册即出现）', () => {
    registerPanel({ id: 'test-panel', group: 'bottom-tab', order: 15, labelRaw: 'T' })
    const tabs = panelList('bottom-tab').map(p => p.id)
    expect(tabs).toEqual(['terminal', 'test-panel', 'git', 'preview', 'problems', 'console'])
    unregisterPanel('test-panel', 'bottom-tab')
    expect(panelList('bottom-tab').map(p => p.id)).not.toContain('test-panel')
  })

  it('toggleablePanelIds：panel 事件白名单与注册表联动', () => {
    expect(toggleablePanelIds()).toEqual(new Set(['files', 'changes', 'git', 'terminal']))
    const original = getPanel('files')
    registerPanel({ id: 'files', group: 'rail-top', order: 99, titleKey: 'x' })
    // 重复注册同名不产生重复白名单项
    expect(toggleablePanelIds().size).toBe(4)
    if (original) registerPanel(original) // 还原，避免影响后续断言
  })

  it('getPanel 返回已注册定义（跨组同名取先注册的活动栏定义）', () => {
    expect(getPanel('files')?.titleKey).toBe('layout.projectFiles')
    expect(getPanel('nope')).toBeUndefined()
  })

  // 笔记独立视图（P-20261108-2）：notes 项 re-target 为主区视图形态——无 controls
  //（agent-terminal/dashboard 同款），激活态跟随 showNotesView 而非侧栏 sideView
  it('notes 面板为主区视图形态：无 controls，激活态跟随 showNotesView', () => {
    const notes = getPanel('notes')
    expect(notes?.controls).toBeUndefined()
    const layout = usePanelLayout()
    resetPanelLayout()
    expect(notes?.active?.()).toBe(false)
    layout.openNotesView()
    expect(notes?.active?.()).toBe(true)
    // 侧栏开合/视图与笔记无关（sideView 'notes' 已退役）
    expect(layout.sideView.value).toBe('files')
    resetPanelLayout()
    expect(notes?.active?.()).toBe(false)
  })
})

describe('panelRegistry 活动栏手动序（P-20261003-252）', () => {
  afterEach(() => {
    restoreRailTopOrder(null)
  })

  it('moveRailPanel：drag 移到 target 之前（从后往前拖）', () => {
    expect(moveRailPanel('terminal', 'files')).toBe(true)
    const rail = railTopIds()
    expect(rail[0]).toBe('terminal')
    expect(rail[1]).toBe('files')
    // 其余面板相对次序保持
    expect(rail.slice(2)).toEqual(['changes', 'todos', 'git', 'notes', 'stream', 'agent-terminal', 'share-manager', 'dsh-console', 'remote-console', 'dashboard', 'env', 'sync'])
  })

  it('moveRailPanel：从前往后拖的 insert-before（移除后 target 前移一位）', () => {
    // files(0) 拖到 git(3) 之前：期望 files 紧贴 git 前，而非 git 之后
    expect(moveRailPanel('files', 'git')).toBe(true)
    expect(railTopIds().slice(0, 4)).toEqual(['changes', 'todos', 'files', 'git'])
  })

  it('moveRailPanel：相邻后继拖拽 = 现状不变，no-op 不产生假变更', () => {
    const before = railTopIds()
    expect(moveRailPanel('files', 'changes')).toBe(false)
    expect(railTopIds()).toEqual(before)
  })

  it('moveRailPanel：拖到自己/未注册 id no-op', () => {
    expect(moveRailPanel('files', 'files')).toBe(false)
    expect(moveRailPanel('files', 'nope')).toBe(false)
    expect(moveRailPanel('nope', 'files')).toBe(false)
  })

  it('panelList rail-top 随手动序；bottom-tab 不受影响', () => {
    moveRailPanel('notes', 'files')
    expect(panelList('rail-top').map(p => p.id)[0]).toBe('notes')
    expect(panelList('bottom-tab').map(p => p.id)).toEqual(['terminal', 'git', 'preview', 'problems', 'console'])
  })

  it('未收录手动序的面板按内置 order 续尾（定制不吞新注册面板）', () => {
    moveRailPanel('terminal', 'files')
    // 手动表只含当时全量 id；新注册面板不在表内 → 续尾而非按 order 插中间
    registerPanel({ id: 'test-rail', group: 'rail-top', order: 15, titleKey: 't' })
    const rail = railTopIds()
    expect(rail[0]).toBe('terminal')
    expect(rail[rail.length - 1]).toBe('test-rail')
    unregisterPanel('test-rail', 'rail-top')
  })

  it('restoreRailTopOrder：合法快照恢复（含未注册 id 剔除/去重/非字符串剔除）', () => {
    restoreRailTopOrder({ railOrder: { railTop: ['git', 'git', 'files', 'gone-panel', 42, 'changes'] } })
    expect(railTopIds().slice(0, 3)).toEqual(['git', 'files', 'changes'])
    // 未收录的尾部面板按内置序
    expect(railTopIds().slice(3)).toEqual(['todos', 'terminal', 'notes', 'stream', 'agent-terminal', 'share-manager', 'dsh-console', 'remote-console', 'dashboard', 'env', 'sync'])
  })

  it('restoreRailTopOrder：脏形状/空表回落内置序（null 清定制）', () => {
    moveRailPanel('terminal', 'files')
    expect(railTopIds()[0]).toBe('terminal')
    restoreRailTopOrder({ railOrder: { railTop: 'not-an-array' } })
    expect(railTopIds()[0]).toBe('files')
    restoreRailTopOrder({ railOrder: { railTop: [] } })
    expect(railTopIds()[0]).toBe('files')
    restoreRailTopOrder(undefined)
    moveRailPanel('terminal', 'files')
    restoreRailTopOrder(null)
    expect(railTopIds()[0]).toBe('files')
  })
})
