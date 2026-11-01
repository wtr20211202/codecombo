import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { NDropdown } from 'naive-ui'
import SessionTimeline from '../../components/claude/SessionTimeline.vue'
import { claudeApi, type ClaudeTimelineEntry } from '../../api/domains/claude'

// 组件测试（P-20261001-3）：只 mock 时间线 API 域，i18n/naive-ui 走 setup.ts
// 的全局 mock（真实 zh 文案直译），断言贴近真实渲染
vi.mock('../../api/domains/claude', () => ({
  claudeApi: { timeline: vi.fn(), setCuration: vi.fn() },
}))

// 敏感遮蔽开关（P-20261004-14）：确认弹窗桩替（jsdom 无 discrete dialog 渲染面），
// 只断言组件侧的确认门与开关状态，弹窗本体是 useDialog 既有能力
const confirmDialogMock = vi.hoisted(() => vi.fn())
vi.mock('../../composables/useDialog', () => ({
  confirmDialog: confirmDialogMock,
}))

// 继续此会话（P-20261002-96）：恢复链路的三个出口分别桩替——会话 store 的
// createAgent、终端编排的 activeId/open、消息 toast（jsdom 无 NMessageProvider）
const createAgentMock = vi.hoisted(() => vi.fn())
const agentTerminalMock = vi.hoisted(() => ({ activeId: { value: '' }, open: vi.fn(async () => {}) }))
const messageMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('../../stores/terminal-sessions', () => ({
  useTerminalSessionsStore: () => ({ createAgent: createAgentMock }),
}))
vi.mock('../../composables/useAgentTerminal', () => ({
  useAgentTerminal: () => agentTerminalMock,
}))

// 此轮链接复制（P-20261003-154）：剪贴板与项目 store 桩替——copyText 捕获深链
// URL 断言参数拼装；项目清单喂 cwd 反查（归属/不归属两形态）
const copyTextMock = vi.hoisted(() => vi.fn(async () => true))
vi.mock('../../utils/clipboard', () => ({ copyText: copyTextMock }))
const projectList = vi.hoisted(() => [{ id: 'p9', path: 'D:\\demo' }])
vi.mock('../../stores/project', () => ({
  useProjectStore: () => ({ projects: projectList }),
}))

vi.mock('naive-ui', async () => {
  const actual = await vi.importActual<typeof import('naive-ui')>('naive-ui')
  return {
    ...(actual as object),
    useMessage: () => messageMock,
    // AI 总结（P-20261003-215）经 useClaudeSessionSummary 的离散 message：
    // 复用上方 messageMock 桩替（jsdom 无真实 DOM 挂载面）
    createDiscreteApi: () => ({ message: messageMock }),
  }
})

const mockedTimeline = vi.mocked(claudeApi.timeline)
const mockedSetCuration = vi.mocked(claudeApi.setCuration)

const session = {
  id: 'sess-1',
  title: '会话标题',
  cwd: 'D:\\demo',
  messageCount: 6,
  firstAt: '2026-10-01T08:00:00Z',
  lastAt: '2026-10-01T08:10:00Z',
  sizeBytes: 1024,
  active: false,
}

function entry(partial: Partial<ClaudeTimelineEntry>): ClaudeTimelineEntry {
  return { kind: 'user', at: '', text: '', ...partial }
}

function page(entries: ClaudeTimelineEntry[], total: number, truncated = false) {
  return { data: { entries, total, truncated } }
}

/** 虚拟化定位桩（P-20261003-182）：定位从 querySelector+scrollIntoView 改为
 *  容器 scrollTop 编程滚动（useVirtualList scrollTo）。原型级捕获写入值，
 *  返回实时数组供断言（只验「定位滚动发生且落点非负」，jsdom 无布局不验像素） */
function installScrollTopCapture(): number[] {
  const writes: number[] = []
  const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')!
  Object.defineProperty(Element.prototype, 'scrollTop', {
    get() { return desc.get!.call(this) },
    set(this: Element, v: number) { writes.push(v); desc.set!.call(this, v) },
    configurable: true,
  })
  return writes
}

beforeEach(() => {
  mockedTimeline.mockReset()
  mockedSetCuration.mockReset()
})

async function mountTimeline(props: { focusAt?: string; focusTurn?: number } = {}) {
  const w = mount(SessionTimeline, { props: { session, ...props } })
  await flushPromises()
  return w
}

describe('SessionTimeline', () => {
  it('按时间正序渲染步骤：种类/工具名/输入/时刻/相对时间', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '帮我跑测试' }),
      entry({ kind: 'assistant', at: '2026-10-01T08:00:10Z', text: '好的' }),
      entry({ kind: 'tool', at: '2026-10-01T08:00:20Z', tool: 'Bash', input: 'go test ./...' }),
      entry({ kind: 'result', at: '2026-10-01T08:01:50Z', text: 'ok', status: 'error' }),
    ], 4))

    const w = await mountTimeline()
    const steps = w.findAll('.cstl-step')
    expect(steps).toHaveLength(4)
    expect(steps[0]!.classes()).toContain('is-user')
    expect(steps[0]!.text()).toContain('帮我跑测试')
    expect(steps[2]!.text()).toContain('Bash')
    // 步骤 3 与步骤 2 间隔 90s → 「+2 分钟」间隔徽标（时间间隔可见）
    expect(steps[3]!.text()).toContain('+2 分钟')
    // 失败结果带失败徽标
    expect(steps[3]!.text()).toContain('失败')
    // 首屏请求 offset=0
    expect(mockedTimeline).toHaveBeenCalledWith('sess-1', { limit: 50, offset: 0 })
    // 头部：目录 + 总步数
    expect(w.find('.cstl-head').text()).toContain('D:\\demo')
    expect(w.find('.cstl-head').text()).toContain('4 步')
  })

  it('工具调用默认折叠，点开显示输入摘要', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'tool', at: '2026-10-01T08:00:20Z', tool: 'Write', input: 'main.go' }),
    ], 1))
    const w = await mountTimeline()
    expect(w.find('.cstl-input-pre').exists()).toBe(false)
    await w.find('[data-tool-toggle="0"]').trigger('click')
    expect(w.find('.cstl-input-pre').exists()).toBe(true)
    expect(w.find('.cstl-input-pre').text()).toContain('main.go')
  })

  it('「加载更多」向后追加更新的步骤（offset=已加载条数）', async () => {
    const first = Array.from({ length: 2 }, (_, i) =>
      entry({ kind: 'user', at: `2026-10-01T08:0${i}:00Z`, text: `步骤${i}` }))
    const second = [entry({ kind: 'user', at: '2026-10-01T08:05:00Z', text: '步骤2' })]
    mockedTimeline
      .mockResolvedValueOnce(page(first, 3))
      .mockResolvedValueOnce(page(second, 3))

    const w = await mountTimeline()
    expect(w.findAll('.cstl-step')).toHaveLength(2)
    await w.find('[data-test="timeline-load-more"]').trigger('click')
    await flushPromises()
    expect(mockedTimeline).toHaveBeenLastCalledWith('sess-1', { limit: 50, offset: 2 })
    expect(w.findAll('.cstl-step')).toHaveLength(3)
    // 追加完 total → 「加载更多」消失
    expect(w.find('[data-test="timeline-load-more"]').exists()).toBe(false)
  })

  it('truncated=true 显示「仅最近一段」提示', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1, true))
    const w = await mountTimeline()
    expect(w.find('.cstl-head-trunc').exists()).toBe(true)
  })

  it('加载失败显示重试入口，重试重新拉取', async () => {
    mockedTimeline.mockRejectedValueOnce(new Error('boom'))
    const w = await mountTimeline()
    expect(w.find('.cstl-state').text()).toContain('时间线加载失败')
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'ok' })], 1))
    await w.find('.cstl-state button').trigger('click')
    await flushPromises()
    expect(w.findAll('.cstl-step')).toHaveLength(1)
  })

  it('空时间线显示空态文案', async () => {
    mockedTimeline.mockResolvedValueOnce(page([], 0))
    const w = await mountTimeline()
    expect(w.find('.cstl-state').text()).toContain('没有可回放的内容')
  })
})

describe('SessionTimeline 时间线内搜索（P-20261002-81）', () => {
  const searchEntries = [
    entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '把 zebra 配置改成 unicorn 样式' }),
    entry({ kind: 'assistant', at: '2026-10-01T08:00:10Z', text: '好的，我来处理' }),
    entry({ kind: 'tool', at: '2026-10-01T08:00:20Z', tool: 'Edit', input: 'themes/zebra.json' }),
    entry({ kind: 'result', at: '2026-10-01T08:00:30Z', text: 'done' }),
  ]

  it('子串命中即时计数：徽标数与命中步骤高亮（大小写不敏感），未命中步骤保持可见', async () => {
    mockedTimeline.mockResolvedValueOnce(page(searchEntries, 4))
    const w = await mountTimeline()
    // 无查询词：徽标隐藏、按钮禁用
    expect(w.find('[data-test="timeline-search-hits"]').exists()).toBe(false)
    expect(w.find('[data-test="timeline-search-hits-only"]').attributes('disabled')).toBeDefined()

    await w.find('[data-test="timeline-search-input"] input').setValue('ZEBRA')
    const badge = w.find('[data-test="timeline-search-hits"]')
    expect(badge.text()).toBe('2 处命中')
    expect(w.findAll('.cstl-step.is-hit')).toHaveLength(2) // user 正文 + 工具输入摘要
    // 默认全量展示（仅高亮不过滤）
    expect(w.findAll('.cstl-step')).toHaveLength(4)
    expect(w.find('[data-test="timeline-search-hits-only"]').attributes('disabled')).toBeUndefined()
  })

  it('Enter/Shift+Enter 命中间循环跳转：工具输入命中自动展开折叠块', async () => {
    mockedTimeline.mockResolvedValueOnce(page(searchEntries, 4))
    const w = await mountTimeline()
    const input = w.find('[data-test="timeline-search-input"] input')
    await input.setValue('zebra')
    expect(w.find('.cstl-input-pre').exists()).toBe(false)

    await input.trigger('keydown', { key: 'Enter' })
    expect(w.find('.cstl-step[data-step="0"]').classes()).toContain('is-hit-cur')
    await input.trigger('keydown', { key: 'Enter' })
    // 第二处命中在工具输入摘要里 → 折叠块自动展开
    expect(w.find('.cstl-step[data-step="2"]').classes()).toContain('is-hit-cur')
    expect(w.find('.cstl-input-pre').exists()).toBe(true)
    expect(w.find('.cstl-input-pre').text()).toContain('themes/zebra.json')
    // Shift+Enter 回退上一处命中（真实键盘事件形态：key=Enter + shiftKey）
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(w.find('.cstl-step[data-step="0"]').classes()).toContain('is-hit-cur')
    // 首处命中继续 Shift+Enter：循环回最后一处
    await input.trigger('keydown', { key: 'Enter', shiftKey: true })
    expect(w.find('.cstl-step[data-step="2"]').classes()).toContain('is-hit-cur')
  })

  it('「仅命中」隐藏未命中步骤，清空查询自动退出紧凑模式', async () => {
    mockedTimeline.mockResolvedValueOnce(page(searchEntries, 4))
    const w = await mountTimeline()
    const input = w.find('[data-test="timeline-search-input"] input')
    await input.setValue('zebra')
    await w.find('[data-test="timeline-search-hits-only"]').trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(2)
    expect(w.findAll('.cstl-step.is-hit')).toHaveLength(2)
    expect(w.find('[data-test="timeline-search-hits-only"]').classes()).toContain('is-on')

    // 零命中 + 仅命中 → 空态文案
    await input.setValue('no-such-keyword')
    expect(w.find('[data-test="timeline-search-hits"]').text()).toBe('0 处命中')
    expect(w.find('.cstl-state').text()).toContain('没有命中的步骤')

    // 清空查询：恢复全量 + 紧凑模式自动退出
    await input.setValue('')
    expect(w.findAll('.cstl-step')).toHaveLength(4)
    expect(w.find('[data-test="timeline-search-hits-only"]').classes()).not.toContain('is-on')
  })
})

describe('SessionTimeline 搜索正则开关（P-20261003-196）', () => {
  // 第一步正文含括号字面（非法正则降级后的字面命中目标）+ zebra/unicorn 分散两步
  const regexEntries = [
    entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '修复 (bug) 后回滚 revert 发布' }),
    entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '把 zebra 配置改成 unicorn 样式' }),
    entry({ kind: 'tool', at: '2026-10-01T08:02:00Z', tool: 'Edit', input: 'themes/zebra.json' }),
  ]

  beforeEach(() => {
    mockedTimeline.mockReset()
  })

  it('regex 开：交替等模式一步命中（同查询字面模式 0 命中）', async () => {
    mockedTimeline.mockResolvedValueOnce(page(regexEntries, 3))
    const w = await mountTimeline()
    const input = w.find('[data-test="timeline-search-input"] input')
    await input.setValue('zebra|unicorn')
    expect(w.find('[data-test="timeline-search-hits"]').text()).toBe('0 处命中') // 字面：该子串不存在
    await w.find('[data-test="timeline-search-regex"]').trigger('click')
    expect(w.find('[data-test="timeline-search-regex"]').classes()).toContain('is-on')
    expect(w.find('[data-test="timeline-search-hits"]').text()).toBe('2 处命中') // user 正文 + 工具输入摘要
    expect(w.findAll('.cstl-step.is-hit')).toHaveLength(2)
    w.unmount()
  })

  it('非法正则：降级字面匹配（括号子串照常命中）并显示就地提示，合法查询提示消失', async () => {
    mockedTimeline.mockResolvedValueOnce(page(regexEntries, 3))
    const w = await mountTimeline()
    await w.find('[data-test="timeline-search-regex"]').trigger('click')
    const input = w.find('[data-test="timeline-search-input"] input')
    await input.setValue('(bug') // 未闭合组：正则非法；作为字面子串命中第一步
    expect(w.find('[data-test="timeline-search-regex-invalid"]').exists()).toBe(true)
    expect(w.find('[data-test="timeline-search-regex-invalid"]').text()).toContain('正则无效')
    expect(w.find('[data-test="timeline-search-hits"]').text()).toBe('1 处命中')
    expect(w.findAll('.cstl-step.is-hit')).toHaveLength(1)
    await input.setValue('revert') // 合法正则：提示消失
    expect(w.find('[data-test="timeline-search-regex-invalid"]').exists()).toBe(false)
    w.unmount()
  })

  it('regex 关：回字面子串（元字符失效），大小写不敏感语义两种模式一致', async () => {
    mockedTimeline.mockResolvedValueOnce(page(regexEntries, 3))
    const w = await mountTimeline()
    const input = w.find('[data-test="timeline-search-input"] input')
    await input.setValue('zebra|unicorn')
    await w.find('[data-test="timeline-search-regex"]').trigger('click')
    expect(w.find('[data-test="timeline-search-hits"]').text()).toBe('2 处命中')
    await w.find('[data-test="timeline-search-regex"]').trigger('click') // 再点关
    expect(w.find('[data-test="timeline-search-regex"]').classes()).not.toContain('is-on')
    expect(w.find('[data-test="timeline-search-hits"]').text()).toBe('0 处命中') // 元字符失效
    await input.setValue('ZEBRA') // 字面大小写不敏感（既有语义不变）
    expect(w.find('[data-test="timeline-search-hits"]').text()).toBe('2 处命中')
    await w.find('[data-test="timeline-search-regex"]').trigger('click')
    await input.setValue('ZEBRA|UNICORN') // 正则同为 i 标志（与终端搜索家族一致）
    expect(w.find('[data-test="timeline-search-hits"]').text()).toBe('2 处命中')
    w.unmount()
  })
})

describe('SessionTimeline 敏感遮蔽（P-20261004-14）', () => {
  // 正文含 sca_ 系令牌、工具输入含 password 赋值——两类模式各占一步
  const maskEntries = [
    entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '令牌 sca_e2etmQ7x9Kp2Rw 勿外泄' }),
    entry({ kind: 'tool', at: '2026-10-01T08:00:10Z', tool: 'Bash', input: 'export password=hunter2' }),
  ]

  beforeEach(() => {
    mockedTimeline.mockReset()
    confirmDialogMock.mockReset()
  })

  it('默认遮蔽：sca_ 令牌与 password 赋值呈 ***，原文不出现在渲染面', async () => {
    mockedTimeline.mockResolvedValueOnce(page(maskEntries, 2))
    const w = await mountTimeline()
    await w.find('[data-tool-toggle="1"]').trigger('click') // 展开工具输入折叠块
    const body = w.find('.cstl-list').text()
    expect(body).toContain('令牌 ***')
    expect(body).toContain('export password=***')
    expect(body).not.toContain('sca_e2etmQ7x9Kp2Rw')
    expect(body).not.toContain('hunter2')
  })

  it('「显示原文」经确认放行；再点「隐藏原文」直接收回（无二次确认）', async () => {
    mockedTimeline.mockResolvedValueOnce(page(maskEntries, 2))
    const w = await mountTimeline()
    await w.find('[data-tool-toggle="1"]').trigger('click')
    confirmDialogMock.mockResolvedValueOnce(true)
    await w.find('[data-test="timeline-mask-toggle"]').trigger('click')
    expect(confirmDialogMock).toHaveBeenCalledTimes(1)
    expect(w.find('.cstl-list').text()).toContain('sca_e2etmQ7x9Kp2Rw')
    expect(w.find('.cstl-list').text()).toContain('hunter2')

    await w.find('[data-test="timeline-mask-toggle"]').trigger('click')
    expect(confirmDialogMock).toHaveBeenCalledTimes(1) // 收回无风险：不再确认
    expect(w.find('.cstl-list').text()).not.toContain('sca_e2etmQ7x9Kp2Rw')
    expect(w.find('.cstl-list').text()).toContain('export password=***')
  })

  it('确认弹窗取消：保持遮蔽', async () => {
    mockedTimeline.mockResolvedValueOnce(page(maskEntries, 2))
    const w = await mountTimeline()
    confirmDialogMock.mockResolvedValueOnce(false)
    await w.find('[data-test="timeline-mask-toggle"]').trigger('click')
    expect(confirmDialogMock).toHaveBeenCalledTimes(1)
    expect(w.find('.cstl-list').text()).not.toContain('sca_e2etmQ7x9Kp2Rw')
    expect(w.find('.cstl-list').text()).toContain('令牌 ***')
  })
})

describe('SessionTimeline 定位高亮（P-20261002-82 focusAt）', () => {
  beforeEach(() => {
    mockedTimeline.mockReset()
  })

  it('高亮最近早于目标时刻的条目并滚动定位', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
      entry({ kind: 'user', at: '2026-10-01T08:02:00Z', text: '步骤2' }),
    ], 3))

    const scrolls = installScrollTopCapture()
    const w = await mountTimeline({ focusAt: '2026-10-01T08:01:30Z' })
    const focus = w.findAll('.cstl-step.is-focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.text()).toContain('步骤1')
    // 定位走虚拟化 scrollTo（容器 scrollTop 编程滚动，P-20261003-182）：
    // 落点 = 目标前条目估高求和，非负
    expect(scrolls.length).toBeGreaterThan(0)
    expect(scrolls.every(v => v >= 0)).toBe(true)
    w.unmount()
  })

  it('目标在已加载区间之后：先「加载更多」追加到位再高亮', async () => {
    const first = [
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
    ]
    const second = [entry({ kind: 'user', at: '2026-10-01T08:02:00Z', text: '步骤2' })]
    mockedTimeline
      .mockResolvedValueOnce(page(first, 3))
      .mockResolvedValueOnce(page(second, 3))

    const w = await mountTimeline({ focusAt: '2026-10-01T08:02:30Z' })
    expect(mockedTimeline).toHaveBeenLastCalledWith('sess-1', { limit: 50, offset: 2 })
    const focus = w.findAll('.cstl-step.is-focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.text()).toContain('步骤2')
    w.unmount()
  })

  it('目标早于全部条目：落首条', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
    ], 2))

    const w = await mountTimeline({ focusAt: '2026-10-01T07:00:00Z' })
    const focus = w.findAll('.cstl-step.is-focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.text()).toContain('步骤0')
    w.unmount()
  })

  it('无效 focusAt：不高亮、不因定位追加请求', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
    ], 1))

    const w = await mountTimeline({ focusAt: 'not-a-time' })
    expect(w.findAll('.cstl-step.is-focus')).toHaveLength(0)
    expect(mockedTimeline).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('呼吸高亮 2s 后自行消退', async () => {
    vi.useFakeTimers()
    try {
      mockedTimeline.mockResolvedValueOnce(page([
        entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      ], 1))

      const w = mount(SessionTimeline, { props: { session, focusAt: '2026-10-01T08:00:05Z' } })
      // 微任务链（加载→定位→起 2s 计时）走完，高亮在场。虚拟化定位含两帧
      // 测量回补（rAF≈+16/32ms），2s 计时在其后起——推进窗须盖过回补帧
      await vi.advanceTimersByTimeAsync(0)
      expect(w.findAll('.cstl-step.is-focus')).toHaveLength(1)
      // 计时到：is-focus 摘除
      await vi.advanceTimersByTimeAsync(2500)
      expect(w.findAll('.cstl-step.is-focus')).toHaveLength(0)
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SessionTimeline 继续此会话（P-20261002-96）', () => {
  beforeEach(() => {
    mockedTimeline.mockReset()
    createAgentMock.mockReset()
    agentTerminalMock.open.mockClear()
    agentTerminalMock.activeId.value = ''
    messageMock.success.mockClear()
    messageMock.error.mockClear()
    messageMock.warning.mockClear()
  })

  it('footer 主按钮：点击走恢复链路（--resume 注入 + 激活终端）并 emit resumed', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    createAgentMock.mockResolvedValueOnce({ id: 'term-9', launched: true })

    const w = await mountTimeline()
    expect(w.find('[data-test="timeline-resume"]').exists()).toBe(true)

    await w.find('[data-test="timeline-resume"]').trigger('click')
    await flushPromises()
    // 恢复链路与 picker 列表行同款：runtime=claude、dir=会话 cwd、--resume 注入
    expect(createAgentMock).toHaveBeenCalledWith('Claude · 会话标题', 'claude', undefined, {
      dir: 'D:\\demo',
      launchArgs: '--resume sess-1',
    })
    // 激活新终端并展开管理页
    expect(agentTerminalMock.activeId.value).toBe('term-9')
    expect(agentTerminalMock.open).toHaveBeenCalledWith('docked')
    // 宿主据此关弹层
    expect(w.emitted('resumed')).toEqual([['term-9']])
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('活跃会话隐藏按钮（同列表行守卫：防双进程写同一对话）', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    const w = await mount(SessionTimeline, { props: { session: { ...session, active: true } } })
    await flushPromises()
    expect(w.find('[data-test="timeline-resume"]').exists()).toBe(false)
  })

  it('无 claude 运行时（launched=false）：降级提示仍激活终端并 emit', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    createAgentMock.mockResolvedValueOnce({ id: 'term-8', launched: false })

    const w = await mountTimeline()
    await w.find('[data-test="timeline-resume"]').trigger('click')
    await flushPromises()
    expect(messageMock.warning).toHaveBeenCalled()
    expect(agentTerminalMock.activeId.value).toBe('term-8')
    expect(w.emitted('resumed')).toEqual([['term-8']])
  })

  it('创建失败：错误 toast，不激活终端不 emit', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    createAgentMock.mockResolvedValueOnce(null)

    const w = await mountTimeline()
    await w.find('[data-test="timeline-resume"]').trigger('click')
    await flushPromises()
    expect(messageMock.error).toHaveBeenCalled()
    expect(agentTerminalMock.open).not.toHaveBeenCalled()
    expect(w.emitted('resumed')).toBeUndefined()
  })
})

describe('SessionTimeline AI 总结本会话（P-20261003-215）', () => {
  // transcriptPath 形态对齐服务端 filepath.Join 产出（数据面同源派生）
  const sessionWithPath = { ...session, transcriptPath: 'C:/Users/demo/.claude/projects/D--demo/sess-1.jsonl' }

  beforeEach(() => {
    mockedTimeline.mockReset()
    createAgentMock.mockReset()
    agentTerminalMock.open.mockClear()
    agentTerminalMock.activeId.value = ''
    messageMock.success.mockClear()
    messageMock.error.mockClear()
    messageMock.warning.mockClear()
  })

  it('工具条按钮：点击经 ask-agent 链发起（launchArgs 含路径与摘要指令）并 emit summarized', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    createAgentMock.mockResolvedValueOnce({ id: 'term-7', launched: true })

    const w = await mount(SessionTimeline, { props: { session: sessionWithPath } })
    await flushPromises()
    const btn = w.find('[data-test="timeline-ai-summary"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeUndefined()

    await btn.trigger('click')
    await flushPromises()
    // 发起链路：runtime=claude、dir=会话 cwd、prompt 含 transcript 路径与四节指令
    expect(createAgentMock).toHaveBeenCalledTimes(1)
    const [name, runtime, , extra] = createAgentMock.mock.calls[0]!
    expect(runtime).toBe('claude')
    expect(name).toContain('AI 总结')
    expect(extra!.dir).toBe('D:\\demo')
    expect(extra!.launchArgs).toContain('C:/Users/demo/.claude/projects/D--demo/sess-1.jsonl')
    expect(extra!.launchArgs).toContain('遗留事项')
    expect(extra!.launchArgs).toContain('***')
    // 激活新终端并展开管理页，宿主据此关弹层（与 resumed 同款处置）
    expect(agentTerminalMock.activeId.value).toBe('term-7')
    expect(agentTerminalMock.open).toHaveBeenCalledWith('docked')
    expect(w.emitted('summarized')).toEqual([['term-7']])
    expect(messageMock.success).toHaveBeenCalled()
  })

  it('transcriptPath 缺失（旧版本对端）：按钮禁用兜底', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    const w = await mountTimeline()
    expect(w.find('[data-test="timeline-ai-summary"]').attributes('disabled')).toBeDefined()
  })

  it('活跃会话不拦（读转写是只读动作，阶段性总结成立）：可发起', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    createAgentMock.mockResolvedValueOnce({ id: 'term-6', launched: true })

    const w = await mount(SessionTimeline, { props: { session: { ...sessionWithPath, active: true } } })
    await flushPromises()
    expect(w.find('[data-test="timeline-ai-summary"]').attributes('disabled')).toBeUndefined()

    await w.find('[data-test="timeline-ai-summary"]').trigger('click')
    await flushPromises()
    expect(createAgentMock).toHaveBeenCalledTimes(1)
    expect(w.emitted('summarized')).toEqual([['term-6']])
  })

  it('发起失败：错误 toast，不激活终端不 emit', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    createAgentMock.mockResolvedValueOnce(null)

    const w = await mount(SessionTimeline, { props: { session: sessionWithPath } })
    await flushPromises()
    await w.find('[data-test="timeline-ai-summary"]').trigger('click')
    await flushPromises()
    expect(messageMock.error).toHaveBeenCalled()
    expect(agentTerminalMock.open).not.toHaveBeenCalled()
    expect(w.emitted('summarized')).toBeUndefined()
  })
})

describe('SessionTimeline 时间轴进度条拖拽定位（P-20261003-132）', () => {
  beforeEach(() => {
    mockedTimeline.mockReset()
  })

  /** 进度条几何桩：jsdom 无布局，给轨宽 100px 便于按 px 表达比例 */
  function stubBarRect(bar: Element) {
    vi.spyOn(bar as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 10, width: 100, height: 10,
      toJSON: () => ({}),
    } as DOMRect)
  }

  /** 指针事件派发：jsdom 把 pointer* 映射为 getter-only MouseEvent，test-utils
   *  的 trigger 事后赋值 clientX 会抛——直接用构造器 init 携带坐标 */
  function firePointer(bar: DOMWrapper<Element>, type: string, clientX: number, button = 0) {
    bar.element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button }))
  }

  it('total>1 渲染进度条（title 位号），total≤1 隐藏；非左键按下不拖拽', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
    ], 2))
    const w = await mountTimeline()
    const bar = w.find('[data-test="timeline-progress"]')
    expect(bar.exists()).toBe(true)
    expect(bar.attributes('title')).toBe('1 / 2')
    stubBarRect(bar.element)
    firePointer(bar, 'pointerdown', 40, 2)
    await nextTick()
    expect(w.find('[data-test="timeline-progress-tip"]').exists()).toBe(false)
    w.unmount()

    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    const w2 = await mountTimeline()
    expect(w2.find('[data-test="timeline-progress"]').exists()).toBe(false)
    w2.unmount()
  })

  it('拖到中段：浮层预览目标条目首行摘要，松手滚动定位并短暂高亮，浮层撤下', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'assistant', at: '2026-10-01T08:01:00Z', text: '好的\n这是第二行' }),
      entry({ kind: 'user', at: '2026-10-01T08:02:00Z', text: '步骤2' }),
    ], 3))
    const scrolls = installScrollTopCapture()
    const w = await mountTimeline()
    const bar = w.find('[data-test="timeline-progress"]')
    stubBarRect(bar.element)
    // clientX=40 / 宽100 → 比例 0.4 → idx = round(0.4×2) = 1
    firePointer(bar, 'pointerdown', 40)
    await nextTick()
    const tip = w.find('[data-test="timeline-progress-tip"]')
    expect(tip.exists()).toBe(true)
    expect(tip.text()).toContain('2 / 3')
    expect(tip.text()).toContain('好的')
    expect(tip.text()).not.toContain('第二行') // 只预览首行
    firePointer(bar, 'pointerup', 40)
    await flushPromises()
    // 定位走虚拟化 scrollTo（容器 scrollTop 编程滚动，P-20261003-182）
    expect(scrolls.length).toBeGreaterThan(0)
    const focus = w.findAll('.cstl-step.is-focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.text()).toContain('好的')
    expect(w.find('[data-test="timeline-progress-tip"]').exists()).toBe(false)
    w.unmount()
  })

  it('松手目标在未加载段：先追加加载到位（不因拖动产生 IO）再定位高亮', async () => {
    const first = [0, 1].map(i =>
      entry({ kind: 'user', at: `2026-10-01T08:0${i}:00Z`, text: `步骤${i}` }))
    const second = [entry({ kind: 'user', at: '2026-10-01T08:05:00Z', text: '步骤2' })]
    mockedTimeline
      .mockResolvedValueOnce(page(first, 3))
      .mockResolvedValueOnce(page(second, 3))
    const w = await mountTimeline()
    const bar = w.find('[data-test="timeline-progress"]')
    stubBarRect(bar.element)
    firePointer(bar, 'pointerdown', 100)
    await nextTick()
    // 未加载段无文本可预览：只报位号，不提前发请求
    expect(w.find('[data-test="timeline-progress-tip"]').text()).not.toContain('步骤2')
    expect(mockedTimeline).toHaveBeenCalledTimes(1)
    firePointer(bar, 'pointerup', 100)
    await flushPromises()
    expect(mockedTimeline).toHaveBeenLastCalledWith('sess-1', { limit: 50, offset: 2 })
    const focus = w.findAll('.cstl-step.is-focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.text()).toContain('步骤2')
    w.unmount()
  })

  it('高亮 2s 后自行消退（与 focusAt 定位同款呼吸摘除）', async () => {
    vi.useFakeTimers()
    try {
      mockedTimeline.mockResolvedValueOnce(page([
        entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
        entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
      ], 2))
      const w = mount(SessionTimeline, { props: { session } })
      await vi.advanceTimersByTimeAsync(0)
      const bar = w.find('[data-test="timeline-progress"]')
      stubBarRect(bar.element)
      firePointer(bar, 'pointerdown', 100)
      firePointer(bar, 'pointerup', 100)
      await vi.advanceTimersByTimeAsync(0)
      expect(w.findAll('.cstl-step.is-focus')).toHaveLength(1)
      // 虚拟化定位含两帧测量回补（rAF≈+16/32ms），2s 计时在其后起——推进窗须盖过
      await vi.advanceTimersByTimeAsync(2500)
      expect(w.findAll('.cstl-step.is-focus')).toHaveLength(0)
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SessionTimeline 回放深链定位（P-20261003-154 focusTurn）', () => {
  beforeEach(() => {
    mockedTimeline.mockReset()
  })

  it('focusTurn（0-based）定位：目标条目呼吸高亮并滚动', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
      entry({ kind: 'user', at: '2026-10-01T08:02:00Z', text: '步骤2' }),
    ], 3))
    const scrolls = installScrollTopCapture()
    const w = await mountTimeline({ focusTurn: 1 })
    const focus = w.findAll('.cstl-step.is-focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.text()).toContain('步骤1')
    // 定位走虚拟化 scrollTo（容器 scrollTop 编程滚动，P-20261003-182）
    expect(scrolls.length).toBeGreaterThan(0)
    w.unmount()
  })

  it('目标在未加载段：先「加载更多」追加到位再高亮', async () => {
    const first = [
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
    ]
    mockedTimeline
      .mockResolvedValueOnce(page(first, 3))
      .mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:02:00Z', text: '步骤2' })], 3))
    const w = await mountTimeline({ focusTurn: 2 })
    expect(mockedTimeline).toHaveBeenLastCalledWith('sess-1', { limit: 50, offset: 2 })
    const focus = w.findAll('.cstl-step.is-focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.text()).toContain('步骤2')
    w.unmount()
  })

  it('越界 focusTurn：钳到尾条（会话截断/收缩后链接保底可打开）', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
    ], 2))
    const w = await mountTimeline({ focusTurn: 99 })
    const focus = w.findAll('.cstl-step.is-focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.text()).toContain('步骤1')
    w.unmount()
  })

  it('focusTurn 与 focusAt 同时携带：精确索引优先', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
      entry({ kind: 'user', at: '2026-10-01T08:02:00Z', text: '步骤2' }),
    ], 3))
    // focusAt 指向尾条时刻、focusTurn 指向首条：高亮必须落在首条
    const w = await mountTimeline({ focusAt: '2026-10-01T08:02:30Z', focusTurn: 0 })
    const focus = w.findAll('.cstl-step.is-focus')
    expect(focus).toHaveLength(1)
    expect(focus[0]!.text()).toContain('步骤0')
    w.unmount()
  })
})

describe('SessionTimeline 此轮链接复制（P-20261003-154）', () => {
  beforeEach(() => {
    mockedTimeline.mockReset()
    copyTextMock.mockClear()
    copyTextMock.mockResolvedValue(true)
    messageMock.success.mockClear()
    messageMock.error.mockClear()
  })

  it('点击复制钮：cwd 反查归属项目入 URL，turn 按 1 计（idx+1）', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '步骤0' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '步骤1' }),
    ], 2))
    const w = await mountTimeline()
    // session.cwd = 'D:\demo' 精确命中项目清单 p9
    await w.find('.cstl-step[data-step="1"] [data-test="timeline-copy-link"]').trigger('click')
    await flushPromises()
    expect(copyTextMock).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/localhost:\d+\/project\?session=sess-1&project=p9&turn=2$/),
    )
    expect(messageMock.success).toHaveBeenCalled()
    w.unmount()
  })

  it('cwd 不归属任何项目：URL 省略 project 参数（会话 id 全局可寻址）', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    const w = await mount(SessionTimeline, { props: { session: { ...session, cwd: '/srv/nowhere' } } })
    await flushPromises()
    await w.find('.cstl-step[data-step="0"] [data-test="timeline-copy-link"]').trigger('click')
    await flushPromises()
    const link = copyTextMock.mock.calls[0]![0] as string
    expect(link).toContain('session=sess-1&turn=1')
    expect(link).not.toContain('project=')
    w.unmount()
  })

  it('复制失败（copyText false）：错误 toast 兜底', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    const w = await mountTimeline()
    copyTextMock.mockResolvedValueOnce(false)
    await w.find('.cstl-step[data-step="0"] [data-test="timeline-copy-link"]').trigger('click')
    await flushPromises()
    expect(messageMock.error).toHaveBeenCalled()
    expect(messageMock.success).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('SessionTimeline 单条内容复制（P-20261003-185）', () => {
  const copyEntries = [
    entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '把 zebra 配置改成 unicorn 样式' }),
    entry({ kind: 'assistant', at: '2026-10-01T08:00:10Z', text: '结论：改完了' }),
    entry({ kind: 'tool', at: '2026-10-01T08:00:20Z', tool: 'Edit', input: 'themes/zebra.json' }),
    entry({ kind: 'result', at: '2026-10-01T08:00:30Z', text: 'done', status: 'error' }),
  ]

  beforeEach(() => {
    mockedTimeline.mockReset()
    copyTextMock.mockClear()
    copyTextMock.mockResolvedValue(true)
    messageMock.success.mockClear()
    messageMock.error.mockClear()
    confirmDialogMock.mockReset()
  })

  it('user/assistant/result 条目：正文原样入剪贴板（无时间戳/meta 行等 UI 残留）', async () => {
    mockedTimeline.mockResolvedValueOnce(page(copyEntries, 4))
    const w = await mountTimeline()
    for (const [idx, want] of [[0, '把 zebra 配置改成 unicorn 样式'], [1, '结论：改完了'], [3, 'done']] as const) {
      copyTextMock.mockClear()
      await w.find(`.cstl-step[data-step="${idx}"] [data-test="timeline-copy-text"]`).trigger('click')
      await flushPromises()
      expect(copyTextMock).toHaveBeenCalledWith(want)
      expect(messageMock.success).toHaveBeenCalled()
    }
    w.unmount()
  })

  it('tool 条目：工具名+输入摘要两行（P-44 单条口径，无 markdown 装饰）', async () => {
    mockedTimeline.mockResolvedValueOnce(page(copyEntries, 4))
    const w = await mountTimeline()
    await w.find('.cstl-step[data-step="2"] [data-test="timeline-copy-text"]').trigger('click')
    await flushPromises()
    expect(copyTextMock).toHaveBeenCalledWith('Edit\nthemes/zebra.json')
    w.unmount()
  })

  it('复制出口走遮蔽视图：默认遮蔽形态入剪贴板，原文放行后复制原文（所见即所复制）', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '令牌 sca_e2etmQ7x9Kp2Rw 勿外泄' }),
    ], 1))
    const w = await mountTimeline()
    await w.find('[data-test="timeline-copy-text"]').trigger('click')
    await flushPromises()
    expect(copyTextMock).toHaveBeenCalledWith('令牌 *** 勿外泄')
    expect(copyTextMock).not.toHaveBeenCalledWith(expect.stringContaining('sca_e2etmQ7x9Kp2Rw'))

    confirmDialogMock.mockResolvedValueOnce(true)
    await w.find('[data-test="timeline-mask-toggle"]').trigger('click')
    copyTextMock.mockClear()
    await w.find('[data-test="timeline-copy-text"]').trigger('click')
    await flushPromises()
    expect(copyTextMock).toHaveBeenCalledWith('令牌 sca_e2etmQ7x9Kp2Rw 勿外泄')
    w.unmount()
  })

  it('复制失败（copyText false）：错误 toast 兜底', async () => {
    mockedTimeline.mockResolvedValueOnce(page([entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: 'x' })], 1))
    const w = await mountTimeline()
    copyTextMock.mockResolvedValueOnce(false)
    await w.find('[data-test="timeline-copy-text"]').trigger('click')
    await flushPromises()
    expect(messageMock.error).toHaveBeenCalled()
    expect(messageMock.success).not.toHaveBeenCalled()
    w.unmount()
  })
})

describe('SessionTimeline 虚拟滚动（P-20261003-182）', () => {
  beforeEach(() => {
    mockedTimeline.mockReset()
  })

  it('长回放切片渲染：DOM 节点有界（远小于已加载数），头部步数如实', async () => {
    // jsdom 无布局：容器 0 高 → 切片 ≈ offset(1) + overscan(10)，60 条只渲染
    // 头部一小窗——「不全量渲染」的核心契约
    const many = Array.from({ length: 60 }, (_, i) =>
      entry({ kind: 'user', at: `2026-10-01T08:${String(i).padStart(2, '0')}:00Z`, text: `虚拟步骤${i}` }))
    mockedTimeline.mockResolvedValueOnce(page(many, 60))
    const w = await mountTimeline()
    const rendered = w.findAll('.cstl-step')
    expect(rendered.length).toBeGreaterThan(0)
    expect(rendered.length).toBeLessThan(60)
    expect(w.find('.cstl-head').text()).toContain('60 步')
    w.unmount()
  })

  it('窗口外条目经 scrollTo 进窗：命中跳转后 is-hit-cur 落在切片内', async () => {
    // 40 条首窗（≈11）外的一条命中唯一词：jumpHit 须把它渲染出来（querySelector
    // 时代的窗口外跳转静默失效，是本提案要消灭的形态）
    const many = Array.from({ length: 40 }, (_, i) =>
      entry({ kind: 'user', at: `2026-10-01T08:${String(i).padStart(2, '0')}:00Z`, text: `虚拟步骤${i}` }))
    many[30]!.text = '虚拟步骤30 quixotic-needle'
    mockedTimeline.mockResolvedValueOnce(page(many, 40))
    const w = await mountTimeline()
    expect(w.find('.cstl-step[data-step="30"]').exists()).toBe(false) // 首窗外
    const input = w.find('[data-test="timeline-search-input"] input')
    await input.setValue('quixotic-needle')
    await input.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    const target = w.find('.cstl-step[data-step="30"]')
    expect(target.exists()).toBe(true) // scrollTo 换窗后已渲染
    expect(target.classes()).toContain('is-hit-cur')
    w.unmount()
  })
})

describe('SessionTimeline 键盘导航（P-20261003-224）', () => {
  const navEntries = [
    entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '键盘步骤0' }),
    entry({ kind: 'assistant', at: '2026-10-01T08:01:00Z', text: '键盘步骤1' }),
    entry({ kind: 'user', at: '2026-10-01T08:02:00Z', text: '键盘步骤2' }),
  ]

  beforeEach(() => {
    mockedTimeline.mockReset()
    copyTextMock.mockClear()
    copyTextMock.mockResolvedValue(true)
    messageMock.success.mockClear()
    messageMock.error.mockClear()
  })

  it('↑↓ 移动 roving 高亮：首按从视口中线（visibleIdx=0）起步，到边即停；移动走虚拟化 scrollTo', async () => {
    mockedTimeline.mockResolvedValueOnce(page(navEntries, 3))
    const scrolls = installScrollTopCapture()
    const w = await mountTimeline()
    expect(w.find('.cstl-step.is-nav').exists()).toBe(false) // 未按键无高亮

    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('.cstl-step.is-nav').text()).toContain('键盘步骤0')
    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('.cstl-step.is-nav').text()).toContain('键盘步骤1')
    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowUp' })
    expect(w.find('.cstl-step.is-nav').text()).toContain('键盘步骤0')
    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowUp' })
    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowUp' })
    expect(w.find('.cstl-step.is-nav').text()).toContain('键盘步骤0') // 首条钳住不越界

    // 滚动协调复用 P-182 scrollToEntryPos：容器 scrollTop 编程滚动发生
    expect(scrolls.length).toBeGreaterThan(0)
    expect(scrolls.every(v => v >= 0)).toBe(true)
    w.unmount()
  })

  it('Enter 复制当前高亮条（P-185 链）；无高亮时不动作', async () => {
    mockedTimeline.mockResolvedValueOnce(page(navEntries, 3))
    const w = await mountTimeline()
    await w.find('.cstl-root').trigger('keydown', { key: 'Enter' })
    expect(copyTextMock).not.toHaveBeenCalled()

    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowDown' })
    await w.find('.cstl-root').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(copyTextMock).toHaveBeenCalledWith('键盘步骤0')
    expect(messageMock.success).toHaveBeenCalled()
    w.unmount()
  })

  it('焦点在行内按钮上：Enter 原生激活优先，导航不重复接管复制', async () => {
    mockedTimeline.mockResolvedValueOnce(page([
      entry({ kind: 'tool', at: '2026-10-01T08:00:00Z', tool: 'Bash', input: 'echo hi' }),
      entry({ kind: 'user', at: '2026-10-01T08:01:00Z', text: '键盘步骤1' }),
    ], 2))
    const w = await mountTimeline()
    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowDown' }) // 高亮 tool 条
    expect(w.find('.cstl-step.is-nav').text()).toContain('Bash')
    copyTextMock.mockClear()
    // keydown 自按钮冒泡到根容器：按钮守卫放行原生激活语义
    await w.find('[data-tool-toggle="0"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(copyTextMock).not.toHaveBeenCalled()
    w.unmount()
  })

  it('/ 聚焦搜索框；输入框内按键不参与导航（/ 可输入、↑↓ 不移动高亮）', async () => {
    mockedTimeline.mockResolvedValueOnce(page(navEntries, 3))
    const w = await mountTimeline()
    // test-utils mount 默认挂 detached 容器：jsdom 不聚焦文档外元素，改断言
    // 组件对输入框发起了 focus（真实聚焦行为由 e2e toBeFocused 守护）
    const inputEl = w.find('[data-test="timeline-search-input"] input').element as HTMLInputElement
    const focusSpy = vi.spyOn(inputEl, 'focus')
    await w.find('.cstl-root').trigger('keydown', { key: '/' })
    expect(focusSpy).toHaveBeenCalledTimes(1)

    await w.find('[data-test="timeline-search-input"] input').trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('.cstl-step.is-nav').exists()).toBe(false) // INPUT 守卫：导航不接管
    // 带修饰键的组合不抢（Shift+/ 产出「?」归全局备忘单）
    focusSpy.mockClear()
    await w.find('.cstl-root').trigger('keydown', { key: '/', shiftKey: true })
    expect(focusSpy).not.toHaveBeenCalled()
    w.unmount()
  })

  it('「仅命中」下 roving 域 = 命中集：高亮只在命中内移动、被过滤移除后从新域重起步', async () => {
    mockedTimeline.mockResolvedValueOnce(page(navEntries, 3))
    const w = await mountTimeline()
    const input = w.find('[data-test="timeline-search-input"] input')
    await input.setValue('键盘步骤1') // 唯一命中 step1
    await w.find('[data-test="timeline-search-hits-only"]').trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(1)

    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('.cstl-step.is-nav').text()).toContain('键盘步骤1') // 起步 = 首个命中
    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowDown' })
    expect(w.findAll('.cstl-step.is-nav')).toHaveLength(1) // 末条钳住不回绕

    // 查询变更后高亮条被「仅命中」滤掉：陈旧高亮先消失，再按键从新渲染域重起步
    await input.setValue('键盘步骤0')
    expect(w.find('.cstl-step.is-nav').exists()).toBe(false)
    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('.cstl-step.is-nav').text()).toContain('键盘步骤0')
    w.unmount()
  })

  it('整体重载（会话切换/重定位）后 roving 高亮作废', async () => {
    mockedTimeline.mockResolvedValueOnce(page(navEntries, 3))
    const w = await mountTimeline()
    await w.find('.cstl-root').trigger('keydown', { key: 'ArrowDown' })
    expect(w.find('.cstl-step.is-nav').exists()).toBe(true)

    mockedTimeline.mockResolvedValueOnce(page(navEntries, 3))
    await w.setProps({ focusAt: '2026-10-01T08:02:30Z' }) // 触发 watch 整体重载
    await flushPromises()
    expect(w.find('.cstl-step.is-nav').exists()).toBe(false)
    w.unmount()
  })
})

describe('SessionTimeline 策展导出（P-20261003-144）', () => {
  const curEntries = [
    entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '把 zebra 配置改了' }),
    entry({ kind: 'assistant', at: '2026-10-01T08:00:10Z', text: '结论一：zebra 完成' }),
    entry({ kind: 'assistant', at: '2026-10-01T08:01:10Z', text: '结论二：预算充足' }),
    entry({ kind: 'tool', at: '2026-10-01T08:01:20Z', tool: 'Bash', input: 'echo done' }),
  ]

  /** blob 下载链桩：jsdom 无 createObjectURL/下载语义——捕获 blob 与锚点
   *  download 名，文档内容经 blob.text() 异步读回断言 */
  function installDownloadCapture() {
    const captured: { name: string; blob: Blob }[] = []
    const origCreate = URL.createObjectURL
    const origRevoke = URL.revokeObjectURL
    URL.createObjectURL = vi.fn((blob: Blob | MediaSource) => {
      captured.push({ blob: blob as Blob, name: '' })
      return `blob:test-${captured.length}`
    }) as typeof URL.createObjectURL
    URL.revokeObjectURL = vi.fn()
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      const last = captured[captured.length - 1]
      if (last) last.name = this.download
    })
    return {
      captured,
      restore() {
        URL.createObjectURL = origCreate
        URL.revokeObjectURL = origRevoke
        clickSpy.mockRestore()
      },
    }
  }

  beforeEach(() => {
    mockedTimeline.mockReset()
    messageMock.success.mockClear()
    messageMock.error.mockClear()
  })

  it('下拉全量项在顶（完整/仅问答/JSONL 三项）+ 策展组计数/禁用态（无命中无书签全禁用）', async () => {
    mockedTimeline.mockResolvedValueOnce(page(curEntries, 4))
    const w = await mountTimeline()
    const options = w.getComponent(NDropdown).props('options') as Array<{ key?: string; label?: string; disabled?: boolean }>
    // md 分完整/仅问答两档（P-20261004-132），机读 jsonl 随后——三选项在顶
    expect(options[0]!.key).toBe('md')
    expect(options[1]!.key).toBe('md-qa')
    expect(options[2]!.key).toBe('jsonl')
    // 策展组：无查询无书签 → 两项禁用，计数为 0
    const hits = options.find(o => o.key === 'md-hits')!
    const bm = options.find(o => o.key === 'md-bm')!
    expect(hits!.disabled).toBe(true)
    expect(bm!.disabled).toBe(true)
    expect(String(hits!.label)).toContain('0')
    w.unmount()
  })

  it('命中集导出：文档仅含命中条目 + 口径注记引用查询词，下载名 claude-hits- 前缀', async () => {
    mockedTimeline.mockResolvedValueOnce(page(curEntries, 4))
    const dl = installDownloadCapture()
    try {
      const w = await mountTimeline()
      await w.find('[data-test="timeline-search-input"] input').setValue('zebra')
      await nextTick()

      const options = w.getComponent(NDropdown).props('options') as Array<{ key?: string; disabled?: boolean }>
      expect(options.find(o => o.key === 'md-hits')!.disabled).toBe(false)

      w.getComponent(NDropdown).vm.$emit('select', 'md-hits')
      await flushPromises()
      expect(dl.captured).toHaveLength(1)
      expect(dl.captured[0]!.name).toMatch(/^claude-hits-.*\.md$/)
      const doc = await dl.captured[0]!.blob.text()
      // 命中口径注记：查询词在场；文档只含命中条目（user+结论一），未命中不出现
      expect(doc).toContain('「zebra」的命中轮次')
      expect(doc).toContain('把 zebra 配置改了')
      expect(doc).toContain('结论一：zebra 完成')
      expect(doc).not.toContain('结论二：预算充足')
      expect(doc).not.toContain('echo done')
      expect(messageMock.success).toHaveBeenCalled()
      w.unmount()
    } finally {
      dl.restore()
    }
  })

  it('书签轮导出：文档仅含书签轮（timeline 响应书签集 → idxByAt 反查），claude-bookmarks- 前缀', async () => {
    mockedTimeline.mockResolvedValueOnce({
      data: { entries: curEntries, total: 4, truncated: false, bookmarks: ['2026-10-01T08:00:10Z'] },
    })
    const dl = installDownloadCapture()
    try {
      const w = await mountTimeline()
      const options = w.getComponent(NDropdown).props('options') as Array<{ key?: string; disabled?: boolean }>
      expect(options.find(o => o.key === 'md-bm')!.disabled).toBe(false)

      w.getComponent(NDropdown).vm.$emit('select', 'md-bm')
      await flushPromises()
      expect(dl.captured).toHaveLength(1)
      expect(dl.captured[0]!.name).toMatch(/^claude-bookmarks-.*\.md$/)
      const doc = await dl.captured[0]!.blob.text()
      expect(doc).toContain('仅包含书签标记的轮次')
      expect(doc).toContain('结论一：zebra 完成')
      expect(doc).not.toContain('把 zebra 配置改了')
      expect(doc).not.toContain('结论二：预算充足')
      w.unmount()
    } finally {
      dl.restore()
    }
  })
})

describe('SessionTimeline 轮级语义标签（P-20261003-256）', () => {
  const tagEntries = [
    entry({ kind: 'user', at: '2026-10-01T08:00:00Z', text: '把 zebra 配置改成 unicorn 样式' }),
    entry({ kind: 'assistant', at: '2026-10-01T08:00:10Z', text: '结论一：zebra 完成' }),
    entry({ kind: 'tool', at: '2026-10-01T08:00:20Z', tool: 'Edit', input: 'themes/zebra.json' }),
    entry({ kind: 'assistant', at: '2026-10-01T08:00:30Z', text: '结论二：预算充足' }),
  ]
  const T0 = '2026-10-01T08:00:00Z'
  const T1 = '2026-10-01T08:00:10Z'
  const T3 = '2026-10-01T08:00:30Z'

  it('标签渲染：条目 chips + 顶部过滤条（名字典序+计数），点击过滤条切换条目显隐（多选 OR）', async () => {
    mockedTimeline.mockResolvedValueOnce({
      data: {
        entries: tagEntries,
        total: 4,
        truncated: false,
        tags: [{ at: T3, tag: '修复' }, { at: T1, tag: '架构' }, { at: T3, tag: '架构' }],
      },
    })
    const w = await mountTimeline()

    // 条目已挂 chips：步骤 1 一枚、步骤 3 两枚、无标签步骤无 chip
    expect(w.findAll('[data-test="timeline-tag-chip"]')).toHaveLength(3)
    expect(w.findAll('.cstl-step[data-step="1"] [data-test="timeline-tag-chip"]')).toHaveLength(1)
    expect(w.findAll('.cstl-step[data-step="3"] [data-test="timeline-tag-chip"]')).toHaveLength(2)

    // 过滤条：名字典序（JS 码元序，修 U+4FEE < 架 U+67B6 → 修复在前）+ 计数
    const strip = w.find('[data-test="timeline-tag-list"]')
    expect(strip.exists()).toBe(true)
    const chips = strip.findAll('[data-test="timeline-tag-filter"]')
    expect(chips).toHaveLength(2)
    expect(chips[0]!.attributes('data-tag')).toBe('修复')
    expect(chips[0]!.text()).toContain('#修复')
    expect(chips[1]!.attributes('data-tag')).toBe('架构')
    expect(chips[1]!.text()).toContain('#架构')

    // 点击「修复」→ 只剩打标的步骤 3，chip 高亮
    await chips[0]!.trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(1)
    expect(w.find('.cstl-step[data-step="3"]').exists()).toBe(true)
    expect(w.find('.cstl-step[data-step="0"]').exists()).toBe(false)
    expect(chips[0]!.classes()).toContain('is-on')

    // 叠加「架构」（OR）→ 步骤 1/3 都在
    await chips[1]!.trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(2)

    // 再点「修复」取消 → 只剩架构覆盖的步骤 1/3
    await chips[0]!.trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(2)
    expect(w.find('.cstl-step[data-step="1"]').exists()).toBe(true)

    // 全部取消 → 恢复全量
    await chips[1]!.trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(4)
    w.unmount()
  })

  it('与「仅命中」正交叠加：标签过滤 ∩ 搜索命中；空交集时按标签口径提示', async () => {
    mockedTimeline.mockResolvedValueOnce({
      data: {
        entries: tagEntries,
        total: 4,
        truncated: false,
        tags: [{ at: T1, tag: '架构' }, { at: T3, tag: '架构' }],
      },
    })
    const w = await mountTimeline()
    const input = w.find('[data-test="timeline-search-input"] input')
    // 架构命中步骤 1/3；搜索 unicorn 仅命中步骤 0（未打标）——交集为空
    await w.find('[data-test="timeline-tag-filter"][data-tag="架构"]').trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(2)
    await input.setValue('unicorn')
    await w.find('[data-test="timeline-search-hits-only"]').trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(0)
    // 空态文案按标签口径（非「没有命中的步骤」）
    expect(w.find('.cstl-state').text()).toContain('没有打了所选标签的条目')

    // 取消标签过滤 → 恢复为仅命中的 1 步
    await w.find('[data-test="timeline-tag-filter"][data-tag="架构"]').trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(1)
    expect(w.find('.cstl-state').exists()).toBe(false)
    w.unmount()
  })

  it('内联编辑器：Enter 提交（#前缀归一）乐观上屏 + tagAdd 落服务端，响应权威集收口', async () => {
    mockedTimeline.mockResolvedValueOnce(page(tagEntries, 4))
    mockedSetCuration.mockResolvedValueOnce({
      data: { sessionId: 'sess-1', tags: [{ at: T0, tag: '架构' }] },
    })
    const w = await mountTimeline()

    // 无时刻不参与、有时刻条目有编辑钮
    expect(w.findAll('[data-test="timeline-tag"]')).toHaveLength(4)

    // 打开步骤 0 编辑器，输入 #架构（归一为 架构）回车
    await w.find('.cstl-step[data-step="0"] [data-test="timeline-tag"]').trigger('click')
    const editor = w.find('.cstl-step[data-step="0"] [data-test="timeline-tag-editor"]')
    expect(editor.exists()).toBe(true)
    const input = editor.find('[data-test="timeline-tag-input"] input')
    await input.setValue('#架构 ')
    await input.trigger('keydown', { key: 'Enter' })

    // 服务端收到归一后的 (at, tag)；编辑器关闭；乐观 chip 先行、响应后以权威集收口
    expect(mockedSetCuration).toHaveBeenCalledWith({ sessionId: 'sess-1', tagAdd: { at: T0, tag: '架构' } })
    expect(w.find('.cstl-step[data-step="0"] [data-test="timeline-tag-editor"]').exists()).toBe(false)
    expect(w.find('.cstl-step[data-step="0"] [data-test="timeline-tag-chip"]').text()).toContain('#架构')
    await flushPromises()
    expect(w.find('[data-test="timeline-tag-list"]').text()).toContain('#架构')
    w.unmount()
  })

  it('快捷复用 chips：已挂标签点击走 tagRemove，未挂点击走 tagAdd（不关编辑器，连挂多枚）', async () => {
    mockedTimeline.mockResolvedValueOnce({
      data: {
        entries: tagEntries,
        total: 4,
        truncated: false,
        // 修复挂在步骤 3：步骤 1 编辑器内仍有其快捷 chip 可点（移除架构后会话非空）
        tags: [{ at: T1, tag: '架构' }, { at: T3, tag: '修复' }],
      },
    })
    mockedSetCuration
      .mockResolvedValueOnce({ data: { sessionId: 'sess-1', tags: [{ at: T3, tag: '修复' }] } })
      .mockResolvedValueOnce({ data: { sessionId: 'sess-1', tags: [{ at: T3, tag: '修复' }, { at: T1, tag: '修复' }] } })
    const w = await mountTimeline()

    await w.find('.cstl-step[data-step="1"] [data-test="timeline-tag"]').trigger('click')
    const editor = w.find('.cstl-step[data-step="1"] [data-test="timeline-tag-editor"]')
    // 已挂的「架构」呈选中态，点击 = 移除
    const archChip = editor.find('[data-test="timeline-tag-suggest"][data-tag="架构"]')
    expect(archChip.classes()).toContain('is-on')
    await archChip.trigger('click')
    expect(mockedSetCuration).toHaveBeenLastCalledWith({ sessionId: 'sess-1', tagRemove: { at: T1, tag: '架构' } })
    await flushPromises()
    // 架构已摘：步骤 1 无 chip，步骤 3 的修复仍在
    expect(w.find('.cstl-step[data-step="1"] [data-test="timeline-tag-chip"]').exists()).toBe(false)
    expect(w.find('.cstl-step[data-step="3"] [data-test="timeline-tag-chip"]').text()).toContain('#修复')

    // 编辑器保持打开：继续点「修复」= 添加（连挂不关面板）
    expect(w.find('.cstl-step[data-step="1"] [data-test="timeline-tag-editor"]').exists()).toBe(true)
    await w.find('.cstl-step[data-step="1"] [data-test="timeline-tag-editor"] [data-test="timeline-tag-suggest"][data-tag="修复"]').trigger('click')
    expect(mockedSetCuration).toHaveBeenLastCalledWith({ sessionId: 'sess-1', tagAdd: { at: T1, tag: '修复' } })
    await flushPromises()
    expect(w.find('.cstl-step[data-step="1"] [data-test="timeline-tag-chip"]').text()).toContain('#修复')
    w.unmount()
  })

  it('定位意图优先：书签跳转目标不在标签过滤内时自动退出过滤（与「仅命中」退出同语义）', async () => {
    mockedTimeline.mockResolvedValueOnce({
      data: {
        entries: tagEntries,
        total: 4,
        truncated: false,
        bookmarks: [T0],
        tags: [{ at: T1, tag: '架构' }],
      },
    })
    const w = await mountTimeline()
    // 激活「架构」过滤：只剩步骤 1
    await w.find('[data-test="timeline-tag-filter"]').trigger('click')
    expect(w.findAll('.cstl-step')).toHaveLength(1)

    // 点击书签 chip（目标=步骤 0，不在过滤内）→ 过滤退出 + 定位呼吸高亮
    await w.find('[data-test="timeline-bookmark-chip"]').trigger('click')
    await flushPromises()
    expect(w.findAll('.cstl-step')).toHaveLength(4)
    expect(w.find('[data-test="timeline-tag-filter"]').classes()).not.toContain('is-on')
    expect(w.find('.cstl-step[data-step="0"]').classes()).toContain('is-focus')
    w.unmount()
  })
})
