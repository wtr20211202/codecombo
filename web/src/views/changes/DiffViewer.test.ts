import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { computed, ref, defineComponent, h, type Component } from 'vue'
import { mount } from '@vue/test-utils'
import DiffViewer from './DiffViewer.vue'

// DiffViewer hunk 操作区组件测试（P-20261003-49 放弃此更改块）：
// 虚拟列表在 jsdom 零高度容器下不出行——桩化 useVirtualList 直接展开全量行
//（虚拟化本身不经本组件改动路径）；diffApi / confirmDialog 打桩观测接线。
// i18n 走 setup.ts 全局 mock（真实 zh 文案直译）。
const scrollToMock = vi.hoisted(() => vi.fn())
vi.mock('@vueuse/core', async () => {
  const vue = await import('vue')
  return {
    useVirtualList: (source: unknown) => {
      const rows = computed(() =>
        (source as { value: Array<{ type: string; content: string; hunkIndex?: number }> }).value.map(
          (data, index) => ({ data, index }),
        ),
      )
      return {
        list: rows,
        scrollTo: scrollToMock,
        containerProps: { ref: vue.ref(null), style: {}, onScroll: () => {} },
        wrapperProps: { style: {} },
      }
    },
  }
})

const diffApiMock = vi.hoisted(() => ({
  stageHunk: vi.fn(async () => ({})),
  unstageHunk: vi.fn(async () => ({})),
  discardHunk: vi.fn(async () => ({})),
}))
vi.mock('../../api/client', () => ({ diffApi: diffApiMock }))

const confirmMock = vi.hoisted(() => vi.fn())
vi.mock('../../composables/useDialog', () => ({ confirmDialog: confirmMock }))

// NButtonGroup 桩（jsdom 下透传插槽即可，NButton 用真实组件保证可点击）
const NButtonGroupStub = defineComponent({
  setup(_, { slots }) {
    return () => h('div', { class: 'nbtn-group-stub' }, slots.default?.())
  },
}) as unknown as Component

const DIFF = [
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,3 @@',
  ' alpha',
  '-bravo',
  '+BRAVO',
  ' charlie',
  '@@ -10,3 +10,3 @@',
  ' xray',
  '-yankee',
  '+YANKEE',
  ' zulu',
].join('\n')

// 第二份 diff（游标重置用例）：三块，hunk 头 flat 下标 2/5/9——重置与否的 next
// 落点可区分（重置→2 首块；未重置续跳 pos1→pos2→5）
const DIFF2 = [
  '--- a/b.txt',
  '+++ b/b.txt',
  '@@ -1,2 +1,2 @@',
  '-bravo',
  '+BRAVO',
  '@@ -10,2 +11,2 @@',
  ' xray',
  '-yankee',
  '+YANKEE',
  '@@ -20,2 +21,2 @@',
  ' delta',
  '-echo',
  '+ECHO',
].join('\n')

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const mounted: ReturnType<typeof mount>[] = []
function mountViewer(props: {
  content: string
  file?: string
  projectId?: string
  staged?: boolean
  enableHunkStaging?: boolean
}) {
  const w = mount(DiffViewer, {
    props,
    global: { stubs: { NButtonGroup: NButtonGroupStub } },
  })
  mounted.push(w)
  return w
}

beforeEach(() => {
  vi.clearAllMocks()
  confirmMock.mockResolvedValue(true)
})

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
})

describe('DiffViewer hunk 放弃第三键（P-20261003-49）', () => {
  it('工作区侧（staged=false）每个 hunk 渲染 暂存+放弃 两键', () => {
    const w = mountViewer({ content: DIFF, file: 'a.txt', projectId: 'p1', staged: false, enableHunkStaging: true })
    const buttons = w.findAll('button').map((b) => b.text())
    // hunkIndex>0 的两块各出一对键；跳过 header 伪 hunk（index 0 无键）
    expect(buttons.filter((x) => x === '暂存代码块')).toHaveLength(2)
    expect(buttons.filter((x) => x === '放弃此更改块')).toHaveLength(2)
  })

  it('索引侧（staged=true）只有取消暂存键，无放弃键', () => {
    const w = mountViewer({ content: DIFF, file: 'a.txt', projectId: 'p1', staged: true, enableHunkStaging: true })
    const buttons = w.findAll('button').map((b) => b.text())
    expect(buttons.filter((x) => x === '取消暂存代码块')).toHaveLength(2)
    expect(buttons.filter((x) => x === '放弃此更改块')).toHaveLength(0)
  })

  it('未启用 hunk 操作（enableHunkStaging=false）无任何 hunk 键', () => {
    const w = mountViewer({ content: DIFF, file: 'a.txt', projectId: 'p1', staged: false })
    // 工具栏常驻三键（合并/并排/忽略空白），hunk 键应一个不出
    const hunkKeys = w.findAll('button').map((b) => b.text()).filter((x) => x === '暂存代码块' || x === '放弃此更改块')
    expect(hunkKeys).toHaveLength(0)
  })

  it('点击放弃 → 确认后调 discardHunk(file, hunkIndex) 并 emit hunk-discarded', async () => {
    const w = mountViewer({ content: DIFF, file: 'a.txt', projectId: 'p1', staged: false, enableHunkStaging: true })
    // DIFF 双块：展示索引 1/2（伪块 0 是文件头）→ 服务端 0 基真实块索引 0/1。
    // 首块 API 索引曾错传展示值 1（会误伤第二块），P-20261004-25 点亮承载面时修正
    const discardButtons = w.findAll('button').filter((b) => b.text() === '放弃此更改块')
    await discardButtons[0]!.trigger('click')
    await flush()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock.mock.calls[0]![0]).toMatchObject({ type: 'warning' })
    expect(diffApiMock.discardHunk).toHaveBeenCalledWith('p1', 'a.txt', 0)
    expect(w.emitted('hunk-discarded')).toHaveLength(1)
    expect(diffApiMock.stageHunk).not.toHaveBeenCalled()
  })

  it('第二块 API 寻址 -1 对位：展示索引 2 → 服务端索引 1（不重不漏）', async () => {
    const w = mountViewer({ content: DIFF, file: 'a.txt', projectId: 'p1', staged: false, enableHunkStaging: true })
    const discardButtons = w.findAll('button').filter((b) => b.text() === '放弃此更改块')
    await discardButtons[1]!.trigger('click')
    await flush()
    expect(diffApiMock.discardHunk).toHaveBeenCalledWith('p1', 'a.txt', 1)

    const stageButtons = w.findAll('button').filter((b) => b.text() === '暂存代码块')
    await stageButtons[1]!.trigger('click')
    await flush()
    expect(diffApiMock.stageHunk).toHaveBeenCalledWith('p1', 'a.txt', 1)
  })

  it('确认弹窗取消 → 不调 API 不 emit', async () => {
    confirmMock.mockResolvedValue(false)
    const w = mountViewer({ content: DIFF, file: 'a.txt', projectId: 'p1', staged: false, enableHunkStaging: true })
    const discard = w.findAll('button').find((b) => b.text() === '放弃此更改块')!
    await discard.trigger('click')
    await flush()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(diffApiMock.discardHunk).not.toHaveBeenCalled()
    expect(w.emitted('hunk-discarded')).toBeUndefined()
  })
})

// DIFF 扁平序列：2 行文件头（伪块 0）+ hunk1 起 5 行（flat 2..6）+ hunk2 起 5 行（flat 7..11）
describe('DiffViewer 变更导航 prev/next（P-20261003-212）', () => {
  it('无变更（纯上下文 diff）时导航按钮成对禁用', () => {
    const w = mountViewer({ content: '--- a/f.txt\n+++ b/f.txt\n context only\n' })
    expect(w.find('[data-testid="diff-nav-prev"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="diff-nav-next"]').attributes('disabled')).toBeDefined()
  })

  it('next 逐块前进到尾后回绕首块（尾→首），prev 对称回绕（首→尾）', async () => {
    const w = mountViewer({ content: DIFF })
    const next = w.find('[data-testid="diff-nav-next"]')
    const prev = w.find('[data-testid="diff-nav-prev"]')
    expect(prev.attributes('disabled')).toBeUndefined()

    await next.trigger('click')
    expect(scrollToMock).toHaveBeenLastCalledWith(2) // hunk1 头行 flat 下标
    await next.trigger('click')
    expect(scrollToMock).toHaveBeenLastCalledWith(7) // hunk2
    await next.trigger('click')
    expect(scrollToMock).toHaveBeenLastCalledWith(2) // 尾→首回绕

    await prev.trigger('click')
    expect(scrollToMock).toHaveBeenLastCalledWith(7) // 首→尾回绕
  })

  it('跳转落点高亮 hunk 头行（unified 行与并排 td 同锚）', async () => {
    const w = mountViewer({ content: DIFF })
    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    await flush()
    expect(w.find('[data-hunk-nav="1"]').classes()).toContain('diff-nav-flash')
    expect(w.find('[data-hunk-nav="2"]').classes()).not.toContain('diff-nav-flash')

    // 并排模式：同款锚点与高亮（切模式游标重置，next 再落首块）
    const sideBtn = w.findAll('button').find((b) => b.text() === '并排')!
    await sideBtn.trigger('click')
    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    await flush()
    expect(w.find('td[data-hunk-nav="1"]').classes()).toContain('diff-nav-flash')
  })

  it('内容变更后导航游标重置：next 重新从首块起跳', async () => {
    const w = mountViewer({ content: DIFF })
    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    expect(scrollToMock).toHaveBeenLastCalledWith(7)

    await w.setProps({ content: DIFF2 })
    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    expect(scrollToMock).toHaveBeenLastCalledWith(2) // 重置后首块（未续跳到 DIFF2 的第二块 flat=8）
  })
})

// N/M 计数 + 键盘导航（P-20261004-54）：游标位/总数指示与 Alt+↑/↓ 键入即跳。
// 键盘作用域 = 根节点（tabindex=0）：消费时 preventDefault+stopPropagation——
// 布局链 diffNav（document 气泡监听，服务编辑器 diff 标签）不得再收到同一事件
describe('DiffViewer 导航计数 + 键盘快捷键（P-20261004-54）', () => {
  /** 在根节点派发真实 KeyboardEvent（cancelable 才能观测 defaultPrevented） */
  function pressRoot(w: ReturnType<typeof mount>, key: string, altKey: boolean): KeyboardEvent {
    const ev = new KeyboardEvent('keydown', { key, altKey, bubbles: true, cancelable: true })
    w.find('.diff-root').element.dispatchEvent(ev)
    return ev
  }

  it('计数指示：未导航以「–」占位，导航后随游标更新且循环回绕可读', async () => {
    const w = mountViewer({ content: DIFF })
    const counter = w.find('[data-testid="diff-nav-count"]')
    expect(counter.text()).toBe('–/2')

    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    expect(counter.text()).toBe('1/2')
    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    expect(counter.text()).toBe('2/2')
    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    expect(counter.text()).toBe('1/2') // 尾→首回绕
    await w.find('[data-testid="diff-nav-prev"]').trigger('click')
    expect(counter.text()).toBe('2/2') // 首→尾回绕
  })

  it('无变更（纯上下文 diff）不渲染计数（与按钮成对禁用同语义）', () => {
    const w = mountViewer({ content: '--- a/f.txt\n+++ b/f.txt\n context only\n' })
    expect(w.find('[data-testid="diff-nav-count"]').exists()).toBe(false)
  })

  it('Alt+↓/↑ 根节点键入即导航并消费事件（document 链不再收到）', async () => {
    const w = mountViewer({ content: DIFF })
    const docSpy = vi.fn()
    document.addEventListener('keydown', docSpy)
    try {
      const down = pressRoot(w, 'ArrowDown', true)
      expect(down.defaultPrevented).toBe(true)
      expect(docSpy).not.toHaveBeenCalled()
      expect(scrollToMock).toHaveBeenLastCalledWith(2)
      await flush() // flash 类走 Vue 异步重渲染，微任务排空后再断言
      expect(w.find('[data-hunk-nav="1"]').classes()).toContain('diff-nav-flash')

      const up = pressRoot(w, 'ArrowUp', true)
      expect(up.defaultPrevented).toBe(true)
      expect(docSpy).not.toHaveBeenCalled()
      expect(scrollToMock).toHaveBeenLastCalledWith(7) // 首→尾回绕（游标已在首块）
    } finally {
      document.removeEventListener('keydown', docSpy)
    }
  })

  it('无修饰键不消费；无变更块时 Alt+↓ 也不消费——事件放行布局链', () => {
    const w = mountViewer({ content: DIFF })
    const bare = pressRoot(w, 'ArrowDown', false)
    expect(bare.defaultPrevented).toBe(false)
    expect(scrollToMock).not.toHaveBeenCalled()

    const empty = mountViewer({ content: '--- a/f.txt\n+++ b/f.txt\n context only\n' })
    const altDown = pressRoot(empty, 'ArrowDown', true)
    expect(altDown.defaultPrevented).toBe(false)
    expect(scrollToMock).not.toHaveBeenCalled()
  })
})

// 折叠未变区域（P-20261004-99）：工具条 ⋯ 开关（会话级默认关）→ 两处远隔变更的
// 中间未变区收成「⋯ 展开 N 行」占位行，点击展开/收起可逆；导航目标被折叠时先
// 展开再跳（P-54 联动）。折叠后扁平序列：flat 10..16 收 1 占位（槽位 10），hunk2 头
// flat 13 展开态下移到槽位 14。夹具头部带生产形态的 4 行文件头（diff --git/index/
// ---/+++ 全归伪块 0），与 e2e 断言数（22/15/23）同构
describe('DiffViewer 折叠未变区域（P-20261004-99）', () => {
  // 200 行文件改第 20/60 行的 diff 形态：两 hunk 相距 39 行文件空间（>8 可折叠），
  // 占位行罩住 ctx21..23 + @@h2 + ctx57..59 共 7 显示行
  const DIFF3 = [
    'diff --git a/big.txt b/big.txt',
    'index 0000000..1111111 100644',
    '--- a/big.txt',
    '+++ b/big.txt',
    '@@ -17,7 +17,7 @@',
    ' line-017',
    ' line-018',
    ' line-019',
    '-line-020',
    '+line-020 CHANGED',
    ' line-021',
    ' line-022',
    ' line-023',
    '@@ -57,7 +57,7 @@',
    ' line-057',
    ' line-058',
    ' line-059',
    '-line-060',
    '+line-060 CHANGED',
    ' line-061',
    ' line-062',
    ' line-063',
  ].join('\n')

  /** 工具条 ⋯ 折叠开关（全组件唯一 ⋯ 文案按钮） */
  function foldToggle(w: ReturnType<typeof mount>) {
    return w.findAll('button').find((b) => b.text() === '⋯')!
  }

  it('默认关无占位行；开关点亮后中间未变区收成占位行（22 行 → 15 行 + 1 占位）', async () => {
    const w = mountViewer({ content: DIFF3 })
    expect(w.findAll('[data-testid="diff-fold-row"]')).toHaveLength(0)
    expect(w.findAll('.diff-line')).toHaveLength(22)

    await foldToggle(w).trigger('click')
    const folds = w.findAll('[data-testid="diff-fold-row"]')
    expect(folds).toHaveLength(1)
    expect(folds[0]!.text()).toContain('展开 7 行')
    expect(w.findAll('.diff-line')).toHaveLength(15) // 7 行显示行折叠收 1 占位（总槽 22−7+1=16）
    // 被罩住的 context 行不再渲染（line-021 落入折叠区）
    expect(w.findAll('.diff-line').some((d) => d.text().includes('line-021'))).toBe(false)
  })

  it('占位行点击展开/再点收起（可逆），展开恢复被罩的 @@ 头与 context', async () => {
    const w = mountViewer({ content: DIFF3 })
    await foldToggle(w).trigger('click')
    const fold = () => w.find('[data-testid="diff-fold-row"]')

    await fold().trigger('click')
    expect(fold().text()).toContain('收起')
    expect(w.findAll('.diff-line')).toHaveLength(22) // 全量恢复
    expect(w.findAll('.diff-line').some((d) => d.text().includes('line-021'))).toBe(true)
    expect(w.find('[data-hunk-nav="2"]').exists()).toBe(true) // @@h2 回到 DOM

    await fold().trigger('click')
    expect(fold().text()).toContain('展开 7 行')
    expect(w.findAll('.diff-line')).toHaveLength(15)
  })

  it('导航目标被折叠时自动展开：next 到被罩 hunk 头，scrollTo 取展开后新下标', async () => {
    const w = mountViewer({ content: DIFF3 })
    await foldToggle(w).trigger('click')

    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    expect(scrollToMock).toHaveBeenLastCalledWith(4) // hunk1 头（区域在 flat 10，前段下标不动）

    await w.find('[data-testid="diff-nav-next"]').trigger('click')
    await flush()
    expect(scrollToMock).toHaveBeenLastCalledWith(14) // @@h2（flat 13）展开后槽位 14
    expect(w.find('[data-hunk-nav="2"]').classes()).toContain('diff-nav-flash')
    expect(w.find('[data-testid="diff-fold-row"]').text()).toContain('收起') // 区域保持展开
  })

  it('并排模式同款占位行（td 形态），行数与 unified 折叠一致', async () => {
    const w = mountViewer({ content: DIFF3 })
    await foldToggle(w).trigger('click')
    const sideBtn = w.findAll('button').find((b) => b.text() === '并排')!
    await sideBtn.trigger('click')
    expect(w.findAll('td[data-testid="diff-fold-row"]')).toHaveLength(1)
    expect(w.findAll('tr')).toHaveLength(16)
  })

  it('内容变更重置展开态：换 diff 再换回，占位行回折叠态', async () => {
    const w = mountViewer({ content: DIFF3 })
    await foldToggle(w).trigger('click')
    await w.find('[data-testid="diff-fold-row"]').trigger('click')
    expect(w.findAll('.diff-line')).toHaveLength(22)

    await w.setProps({ content: DIFF }) // 小 diff：无可折叠区
    expect(w.findAll('[data-testid="diff-fold-row"]')).toHaveLength(0)

    await w.setProps({ content: DIFF3 })
    expect(w.find('[data-testid="diff-fold-row"]').text()).toContain('展开 7 行')
    expect(w.findAll('.diff-line')).toHaveLength(15)
  })
})
