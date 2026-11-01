import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useEditorNavHistory, type NavLocation } from '../../composables/useEditorNavHistory'

/**
 * 编辑器导航历史语义（P-20261002-51；P-20261002-148 增量：锚点带列号）：
 *   - 锚点跳转（入后退栈）= 换文件，或同文件行距 ≥ 30 且当前锚点停留 ≥ 400ms
 *   - 路过（停留不足）的大跳只轻更新当前锚点，不留痕（预览连翻 / 恢复落位起点）
 *   - 后退/前进在两栈间搬运当前位置；新方向锚点作废前进历史
 *   - 列号随光标事件入栈往返保留；同点重离去重只刷新栈顶列；无列占位锚点缺省
 *   - diff 伪键 / 未命名草稿不入栈；项目切换（beginSession）整体作废
 * 模块单例：用例间以递增 projectId 重置（beginSession 变更即清栈）。
 */

const restored: NavLocation[] = []
function restore(loc: NavLocation): void {
  restored.push({ ...loc })
}

let seq = 0

describe('useEditorNavHistory', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    restored.length = 0
    const nav = useEditorNavHistory()
    nav.beginSession(`p${++seq}`)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('换文件 → 后退恢复旧文件旧行，前进回到新文件', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 1)
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 100) // 同文件大跳（停留够久）→ 锚定 {a,1}
    vi.advanceTimersByTime(500)
    nav.notifyActiveFile('b.ts') // 换文件 → 锚定 {a,100}
    expect(nav.canNavigateBack.value).toBe(true)

    nav.navigateBack(restore)
    expect(restored).toEqual([{ path: 'a.ts', line: 100 }])
    expect(nav.canNavigateForward.value).toBe(true)

    nav.navigateForward(restore)
    expect(restored[1]).toEqual({ path: 'b.ts', line: 1 })
  })

  it('同文件微动（行距 < 30）不产生锚点', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 10)
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 25)
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 39)
    expect(nav.canNavigateBack.value).toBe(false)
  })

  it('路过的远距跳变（停留 < 400ms）不留痕，停稳后的下一次大跳才锚定', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 1)
    // viewState 恢复/预览连翻式连跳：每次间隔 100ms，均为路过
    nav.reportLocation('a.ts', 100)
    vi.advanceTimersByTime(100)
    nav.reportLocation('a.ts', 200)
    vi.advanceTimersByTime(100)
    nav.reportLocation('a.ts', 300)
    expect(nav.canNavigateBack.value).toBe(false)
    // 停稳 500ms 后再大跳：300 处已驻留 → 锚定 {a,300}
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 5)
    nav.navigateBack(restore)
    expect(restored).toEqual([{ path: 'a.ts', line: 300 }])
  })

  it('后退后再跳新方向：前进历史作废', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 1)
    vi.advanceTimersByTime(500)
    nav.notifyActiveFile('b.ts')
    nav.navigateBack(restore)
    expect(nav.canNavigateForward.value).toBe(true)
    vi.advanceTimersByTime(500)
    nav.notifyActiveFile('c.ts') // 新方向导航
    expect(nav.canNavigateForward.value).toBe(false)
    expect(() => nav.navigateForward(restore)).not.toThrow()
    expect(restored).toHaveLength(1)
  })

  it('相邻同点去重：震荡跳回停留窗口内轻更新，再跳出锚点与栈顶同点不重复压栈', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 1)
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 100) // 锚定 {a,1}
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 130) // 锚定 {a,100}
    nav.reportLocation('a.ts', 100) // 跳回发生在停留窗口内 → 轻更新，不锚定
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 130) // 再跳出 → 锚点 {a,100} 与栈顶同点 → 去重
    nav.navigateBack(restore)
    expect(restored[0]).toEqual({ path: 'a.ts', line: 100 })
    nav.navigateBack(restore)
    expect(restored[1]).toEqual({ path: 'a.ts', line: 1 })
    expect(nav.canNavigateBack.value).toBe(false) // 恰两条：去重挡掉了重复的 {a,100}
  })

  it('栈上限 50：最旧锚点被挤出', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 1)
    for (let i = 0; i < 55; i++) {
      vi.advanceTimersByTime(500)
      nav.notifyActiveFile(`f${i}.ts`) // 55 次换文件 → 55 次入栈，挤出最旧 5 个
    }
    let popped = 0
    while (nav.canNavigateBack.value) {
      nav.navigateBack(restore)
      popped++
    }
    expect(popped).toBe(50)
    expect(restored[restored.length - 1]).toEqual({ path: 'f4.ts', line: 1 }) // 栈底 = f4（a、f0..f3 已被挤出）
  })

  it('diff 伪键与未命名草稿不入栈', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 1)
    vi.advanceTimersByTime(500)
    nav.reportLocation('diff:abc:wt:b.ts', 10)
    vi.advanceTimersByTime(500)
    nav.reportLocation('untitled://1', 10)
    expect(nav.canNavigateBack.value).toBe(false)
  })

  it('项目切换（beginSession）整体作废，同项目重入不清', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 1)
    vi.advanceTimersByTime(500)
    nav.notifyActiveFile('b.ts')
    expect(nav.canNavigateBack.value).toBe(true)
    nav.beginSession('p-same-current') // 递增序之外的未知项目 → 清
    expect(nav.canNavigateBack.value).toBe(false)
    nav.reportLocation('a.ts', 1)
    vi.advanceTimersByTime(500)
    nav.notifyActiveFile('b.ts')
    nav.beginSession('p-same-current') // 同项目重入 → 不清
    expect(nav.canNavigateBack.value).toBe(true)
  })

  it('空栈后退/前进为 no-op', () => {
    const nav = useEditorNavHistory()
    expect(nav.canNavigateBack.value).toBe(false)
    expect(nav.canNavigateForward.value).toBe(false)
    nav.navigateBack(restore)
    nav.navigateForward(restore)
    expect(restored).toHaveLength(0)
  })

  it('列号随锚点入栈并在后退/前进中往返保留（P-20261002-148 列级精度）', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 1, 1)
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 100, 37) // 同文件大跳 → 锚定 {a,1,col1}
    vi.advanceTimersByTime(500)
    nav.reportLocation('b.ts', 9, 4) // 换文件 → 锚定 {a,100,col37}，b 落 9 行 4 列
    nav.navigateBack(restore)
    expect(restored[0]).toEqual({ path: 'a.ts', line: 100, column: 37 })
    vi.advanceTimersByTime(500)
    nav.navigateForward(restore)
    expect(restored[1]).toEqual({ path: 'b.ts', line: 9, column: 4 })
  })

  it('同点重离：栈顶列刷新为最新离开列，不重复压栈；无列占位锚点恢复缺省', () => {
    const nav = useEditorNavHistory()
    nav.reportLocation('a.ts', 1, 1)
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 100, 37) // 锚定 {a,1,col1}
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 130, 5) // 锚定 {a,100,col37}
    nav.reportLocation('a.ts', 100, 40) // 停留窗口内跳回 → 轻更新 {a,100,col40}
    vi.advanceTimersByTime(500)
    nav.reportLocation('a.ts', 130, 5) // 再跳出 → 栈顶 {a,100} 同点去重、列刷新 col40
    nav.navigateBack(restore)
    expect(restored[0]).toEqual({ path: 'a.ts', line: 100, column: 40 })
    nav.navigateBack(restore)
    expect(restored[1]).toEqual({ path: 'a.ts', line: 1, column: 1 })
    expect(nav.canNavigateBack.value).toBe(false) // 恰两条：去重挡掉了重复的 {a,100}
  })

  // ============== 选区信标（P-20261005-149 {selection} 占位符源） ==============

  it('reportSelection 上报/空选区清零；beginSession 项目切换清空', () => {
    const nav = useEditorNavHistory()
    nav.reportSelection('a.ts', 'const a = 1')
    expect(nav.activeSelection.value).toBe('const a = 1')
    nav.reportSelection('a.ts', '') // 空选区（点击/光标移动）上报空串即清
    expect(nav.activeSelection.value).toBe('')
    nav.reportSelection('a.ts', 'selected')
    nav.beginSession(`p${++seq}`) // 项目切换整体作废（与 activeFilePath 口径一致）
    expect(nav.activeSelection.value).toBe('')
  })

  it('releaseSelection 只清归属路径：分屏另一组在场的选区不被误清', () => {
    const nav = useEditorNavHistory()
    nav.reportSelection('a.ts', 'from-a')
    nav.releaseSelection('b.ts') // 他组路径：不动
    expect(nav.activeSelection.value).toBe('from-a')
    nav.reportSelection('b.ts', 'from-b')
    nav.releaseSelection('a.ts') // 信标已归属 b：a 的释放不动它
    expect(nav.activeSelection.value).toBe('from-b')
    nav.releaseSelection('b.ts') // 归属者自身：清空（关编辑器不残留幽灵选区）
    expect(nav.activeSelection.value).toBe('')
  })

  it('diff 伪键/未命名草稿的选区照收（选区无按路径重开语义，不受 isNavTrackable 过滤）', () => {
    const nav = useEditorNavHistory()
    nav.reportSelection('diff:HEAD~1..HEAD/web/src/main.ts', 'diff hunk text')
    expect(nav.activeSelection.value).toBe('diff hunk text')
    nav.reportSelection('untitled://1', 'draft text')
    expect(nav.activeSelection.value).toBe('draft text')
  })
})
