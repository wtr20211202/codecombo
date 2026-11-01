import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import ProjectSearch from '../../components/search/ProjectSearch.vue'

// 复制全部路径（P-20261003-149）组件级单测：
// 钉住「结果头小钮 → copyText 载荷」的契约面——单项目纯相对路径换行拼接（同文件
// 多命中去重）、glob 过滤后复制当前结果范围、跨项目模式带项目名前缀（跨仓同名
// 不互斥）、零结果不渲染按钮、copyText 失败走错误提示。
// 搜索链 mock 到 api client（组件真实防抖/watch 流程照跑）；文案走 setup.ts 真实
// zh 文案直译。

const searchContentMock = vi.hoisted(() => vi.fn())
const patchExportMock = vi.hoisted(() => vi.fn())
vi.mock('../../api/client', () => ({
  projectApi: { searchContent: searchContentMock },
  patchApi: { export: patchExportMock },
}))

const copyTextMock = vi.hoisted(() => vi.fn())
vi.mock('../../utils/clipboard', () => ({ copyText: copyTextMock }))

const msgSuccess = vi.hoisted(() => vi.fn())
const msgError = vi.hoisted(() => vi.fn())
// useMessage 依赖 NMessageProvider 注入（jsdom 无 provider 会抛错）
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual('naive-ui')
  return {
    ...(actual as object),
    useMessage: () => ({ success: msgSuccess, error: msgError, warning: vi.fn(), info: vi.fn() }),
  }
})

// 项目 store 以可变外置状态注入（plain object 即满足组件读取面：
// currentProjectId / projects[{id,name,valid}]）
const projectState = vi.hoisted(() => ({
  currentProjectId: 'p1',
  projects: [] as { id: string; name: string; valid?: boolean }[],
}))
vi.mock('../../stores/project', () => ({
  useProjectStore: () => projectState,
}))

interface FakeMatch {
  path: string
  line: number
  column: number
  content: string
  match: string
}

const m = (path: string, line: number): FakeMatch => ({
  path,
  line,
  column: 1,
  content: 'foo bar',
  match: 'foo',
})

/** 防抖 300ms + 搜索 promise 落定：真实定时器等足再冲刷微任务 */
async function settleSearch(): Promise<void> {
  await new Promise(r => setTimeout(r, 420))
  await flushPromises()
}

async function openPanel(wrapper: VueWrapper): Promise<void> {
  // show=false 挂载 → 置 true 触发打开 watcher（范围记忆恢复 + 聚焦），生产同路径
  await wrapper.setProps({ show: true })
  await flushPromises()
}

function queryInput(wrapper: VueWrapper) {
  return wrapper.find('.ps-input-row input')
}

function copyButton(wrapper: VueWrapper) {
  return wrapper.find('[data-testid="ps-copy-paths"]')
}

beforeEach(() => {
  searchContentMock.mockReset()
  patchExportMock.mockReset()
  copyTextMock.mockReset().mockResolvedValue(true)
  msgSuccess.mockClear()
  msgError.mockClear()
  projectState.currentProjectId = 'p1'
  projectState.projects = [{ id: 'p1', name: 'Alpha', valid: true }]
  localStorage.clear()
})

function mountPanel() {
  return mount(ProjectSearch, {
    props: { show: false, initialQuery: '', initialFilePattern: '' },
  })
}

describe('ProjectSearch 复制全部路径（P-20261003-149）', () => {
  it('单项目多文件：换行拼接唯一路径（同文件多命中去重）+ 成功提示', async () => {
    searchContentMock.mockResolvedValue({ data: [m('a.txt', 1), m('a.txt', 2), m('sub/b.md', 1)] })
    const wrapper = mountPanel()
    await openPanel(wrapper)

    await queryInput(wrapper).setValue('foo')
    await settleSearch()

    const btn = copyButton(wrapper)
    expect(btn.exists()).toBe(true)
    // tooltip 双语键（zh 直译）
    expect(btn.attributes('title')).toBe('复制全部路径（当前结果范围，换行分隔）')

    await btn.trigger('click')
    await flushPromises()
    expect(copyTextMock).toHaveBeenCalledTimes(1)
    expect(copyTextMock).toHaveBeenCalledWith('a.txt\nsub/b.md')
    expect(msgSuccess).toHaveBeenCalledWith('已复制')
    wrapper.unmount()
  })

  it('glob 过滤协同：过滤后新结果落地，复制面收敛到当前范围', async () => {
    searchContentMock
      .mockResolvedValueOnce({ data: [m('a.txt', 1), m('sub/b.md', 1), m('c.log', 1)] })
      .mockResolvedValueOnce({ data: [m('sub/b.md', 1)] })
    const wrapper = mountPanel()
    await openPanel(wrapper)

    await queryInput(wrapper).setValue('foo')
    await settleSearch()
    expect(copyButton(wrapper).exists()).toBe(true)

    // glob 输入走 watch(filePattern) 即时重搜（无防抖）
    await wrapper.find('.ps-glob input').setValue('*.md')
    await flushPromises()
    // 新结果落地信号：旧 a.txt 分组消失（行头文本=文件名+路径+计数拼串，按包含断言）
    const headers = wrapper.findAll('.ps-file-header').map(h => h.text())
    expect(headers).toHaveLength(1)
    expect(headers[0]).toContain('sub/b.md')

    await copyButton(wrapper).trigger('click')
    await flushPromises()
    expect(copyTextMock).toHaveBeenCalledWith('sub/b.md')
    // 服务端过滤契约：glob 参数随请求透传（复制面=请求结果范围的一致性前提）
    expect(searchContentMock.mock.calls[1]?.[1]).toMatchObject({ glob: '*.md' })
    wrapper.unmount()
  })

  it('跨项目模式：路径带项目名前缀，跨仓同名文件不互斥', async () => {
    projectState.projects = [
      { id: 'p1', name: 'Alpha', valid: true },
      { id: 'p2', name: 'Beta', valid: true },
    ]
    // 范围记忆种子：打开面板时 restoreRememberedScope 恢复成两项目（生产同路径）
    localStorage.setItem('project-search-scope', JSON.stringify(['p1', 'p2']))
    searchContentMock.mockImplementation(async (id: string) =>
      id === 'p1'
        ? { data: [m('same.txt', 1), m('same.txt', 2)] }
        : { data: [m('same.txt', 1), m('only-b.md', 1)] },
    )
    const wrapper = mountPanel()
    await openPanel(wrapper)

    await queryInput(wrapper).setValue('foo')
    await settleSearch()

    await copyButton(wrapper).trigger('click')
    await flushPromises()
    expect(copyTextMock).toHaveBeenCalledWith('Alpha/same.txt\nBeta/same.txt\nBeta/only-b.md')
    wrapper.unmount()
  })

  it('零结果不渲染按钮；copyText 失败走错误提示', async () => {
    searchContentMock
      .mockResolvedValueOnce({ data: [] })
      .mockResolvedValueOnce({ data: [m('a.txt', 1)] })
    const wrapper = mountPanel()
    await openPanel(wrapper)

    await queryInput(wrapper).setValue('foo')
    await settleSearch()
    expect(copyButton(wrapper).exists()).toBe(false)

    // 出结果后复制失败：common.copyFailed 错误提示
    await queryInput(wrapper).setValue('bar')
    await settleSearch()
    copyTextMock.mockResolvedValueOnce(false)
    await copyButton(wrapper).trigger('click')
    await flushPromises()
    expect(msgError).toHaveBeenCalledWith('复制失败，请手动选择文本复制')
    expect(msgSuccess).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

// 结果键盘走查（P-20261006-23）：↑↓ 单步移动（卡片级单绑定无双触发）、
// Enter/Shift+Enter 开当前/上一命中、F3/Shift+F3 窗口级全局跳转（面板保持
// 开启）、折叠行按需展开 + 滚动跟随。键位经真实 DOM 事件走（trigger /
// window.dispatchEvent），断言的是组件对外契约（emitted + 渲染行）
describe('ProjectSearch 结果键盘走查（P-20261006-23）', () => {
  beforeAll(() => {
    // jsdom 无布局无 scrollIntoView 实现：滚动跟随 watch 在活动行落 DOM 后调用
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('↓ 单步移动活动行（键位只在卡片级绑定，无双触发一次跳两行）', async () => {
    searchContentMock.mockResolvedValue({ data: [m('a.txt', 1), m('a.txt', 2), m('b.md', 3)] })
    const wrapper = mountPanel()
    await openPanel(wrapper)
    await queryInput(wrapper).setValue('foo')
    await settleSearch()

    // 输入框上按键 → 事件冒泡到卡片级 handler，只处理一次：首行即活动行
    // （旧代码输入框+卡片各绑一份，一次 ↓ 会跳到第二行）
    await queryInput(wrapper).trigger('keydown', { key: 'ArrowDown' })
    let rows = wrapper.findAll('.ps-line')
    expect(rows[0]!.classes()).toContain('is-active')
    expect(wrapper.findAll('.ps-line.is-active')).toHaveLength(1)

    await queryInput(wrapper).trigger('keydown', { key: 'ArrowDown' })
    rows = wrapper.findAll('.ps-line')
    expect(rows[1]!.classes()).toContain('is-active')
    wrapper.unmount()
  })

  it('Enter 开首个/活动命中并关面板；Shift+Enter 反向开上一命中', async () => {
    searchContentMock.mockResolvedValue({ data: [m('a.txt', 1), m('a.txt', 2), m('b.md', 3)] })
    const wrapper = mountPanel()
    await openPanel(wrapper)
    await queryInput(wrapper).setValue('foo')
    await settleSearch()

    // 无活动行 Enter → 开首个匹配（VS Code 惯例）
    await queryInput(wrapper).trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('open-file')).toEqual([['a.txt', 1]])
    expect(wrapper.emitted('update:show')!.at(-1)).toEqual([false])

    // 此刻活动行已落在首个命中（idx 0），↓ ↓ 移到第三命中（b.md:3），
    // Shift+Enter 反向开上一命中（clamp 不回绕）
    await queryInput(wrapper).trigger('keydown', { key: 'ArrowDown' })
    await queryInput(wrapper).trigger('keydown', { key: 'ArrowDown' })
    await queryInput(wrapper).trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(wrapper.emitted('open-file')!.at(-1)).toEqual(['a.txt', 2])
    wrapper.unmount()
  })

  it('F3/Shift+F3 窗口级全局跳转：面板保持开启连续走查，末行钳住不越界', async () => {
    searchContentMock.mockResolvedValue({ data: [m('a.txt', 1), m('b.md', 3)] })
    const wrapper = mountPanel()
    await openPanel(wrapper)
    await queryInput(wrapper).setValue('foo')
    await settleSearch()

    const press = (key: string, init: KeyboardEventInit = {}) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key, ...init }))

    // 焦点不在结果列表（模拟落在遮罩/浮层挂载点）也能走查
    press('F3')
    await flushPromises()
    expect(wrapper.findAll('.ps-line')[0]!.classes()).toContain('is-active')
    press('F3')
    await flushPromises()
    expect(wrapper.findAll('.ps-line')[1]!.classes()).toContain('is-active')
    // 末行钳住（clamp 不回绕），Shift+F3 反向退回
    press('F3')
    await flushPromises()
    expect(wrapper.findAll('.ps-line')[1]!.classes()).toContain('is-active')
    press('F3', { shiftKey: true })
    await flushPromises()
    expect(wrapper.findAll('.ps-line')[0]!.classes()).toContain('is-active')
    // F3 只移动高亮不打开：面板从未请求关闭
    expect(wrapper.emitted('update:show')).toBeUndefined()
    wrapper.unmount()
  })

  it('折叠行按需展开：走查越过折叠线渲染出活动行，ps-more 计数同步', async () => {
    searchContentMock.mockResolvedValue({ data: Array.from({ length: 35 }, (_, i) => m('big.txt', i + 1)) })
    const wrapper = mountPanel()
    await openPanel(wrapper)
    await queryInput(wrapper).setValue('foo')
    await settleSearch()

    // 无活动行时维持 30 行折叠线
    expect(wrapper.findAll('.ps-line')).toHaveLength(30)
    expect(wrapper.find('.ps-more').text()).toContain('+5')

    // F3 ×31：活动命中越过折叠线，渲染上限抬到活动行为止（31 行），余量 -1
    for (let i = 0; i < 31; i++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3' }))
    await flushPromises()
    expect(wrapper.findAll('.ps-line')).toHaveLength(31)
    expect(wrapper.find('.ps-more').text()).toContain('+4')
    // 活动行是最后一条渲染行，滚动跟随已触发
    expect(wrapper.findAll('.ps-line').at(-1)!.classes()).toContain('is-active')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    wrapper.unmount()
  })
})
