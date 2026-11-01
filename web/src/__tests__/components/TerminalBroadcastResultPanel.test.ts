import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, type Component } from 'vue'
import { mount, type VueWrapper } from '@vue/test-utils'
import TerminalBroadcastResultPanel from '../../components/terminal/TerminalBroadcastResultPanel.vue'

// 组件测试（P-20261005-12 广播结果聚合面板）：尾拉取（延时/切片/剥 ANSI）、
// 全部刷新、失败/missing 灰态。terminalApi 全量 mock；i18n 走 setup.ts 真实
// zh 文案直译；NModal 用渲染函数桩替换（jsdom 下 teleport 挂 body 不可查询，
// 且运行时无模板编译器，桩不能用 template 字符串——InstanceSessionOverview
// 组件测试同款惯例）。
const scrollbackMock = vi.hoisted(() => vi.fn())
vi.mock('../../api/domains/terminal', () => ({
  terminalApi: {
    scrollback: scrollbackMock,
  },
}))

const NModalStub = defineComponent({
  props: { show: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.show ? h('div', { class: 'modal-stub' }, [slots['header-extra']?.(), slots.default?.()]) : null)
  },
})

/** 构造 n 行「line-i」缓冲 */
function bufferOf(n: number): ArrayBuffer {
  const lines: string[] = []
  for (let i = 1; i <= n; i++) lines.push(`line-${i}`)
  return new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer
}

const target = (id: string, state: 'ok' | 'missing' | 'failed' = 'ok', name = id) => ({ id, name, state })

const mounted: VueWrapper[] = []

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

async function mountOpened(targets: ReturnType<typeof target>[]) {
  const w = mount(TerminalBroadcastResultPanel, {
    props: { show: false, targets },
    // 桩键双写：naive-ui NModal 内部 name 是 'Modal'（VTU 按 type.name 匹配）
    global: { stubs: { NModal: NModalStub as unknown as Component, Modal: NModalStub as unknown as Component } },
    attachTo: document.body,
  })
  mounted.push(w)
  await w.setProps({ show: true })
  return w
}

beforeEach(() => {
  vi.useFakeTimers()
  scrollbackMock.mockReset()
  scrollbackMock.mockResolvedValue(bufferOf(0))
})

afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount()
  vi.useRealTimers()
})

describe('TerminalBroadcastResultPanel 广播结果聚合', () => {
  it('打开后延时拉取 ok 目标，missing/failed 灰态不发起请求', async () => {
    scrollbackMock.mockResolvedValue(bufferOf(3))
    const w = await mountOpened([
      target('t-ok'),
      target('t-gone', 'missing'),
      target('t-dead', 'failed'),
    ])

    // 延时窗内（1.5s 给命令留执行时间）不发请求；灰态单元格已就地呈现
    await vi.advanceTimersByTimeAsync(100)
    expect(scrollbackMock).not.toHaveBeenCalled()
    const gray = w.findAll('[data-testid="terminal-broadcast-result-cell"].is-gray')
    expect(gray).toHaveLength(2)
    expect(gray[0].text()).toContain('已不存在')
    expect(gray[1].text()).toContain('写入失败')

    // 延时到期：只拉 ok 目标，尾输出就位
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(scrollbackMock).toHaveBeenCalledTimes(1)
    expect(scrollbackMock).toHaveBeenCalledWith('t-ok', { silent: true })
    const okCell = w.findAll('[data-testid="terminal-broadcast-result-cell"]')
      .find(c => c.classes().includes('is-gray') === false)!
    expect(okCell.text()).toContain('line-3')
    w.unmount()
  })

  it('尾输出切片：60 行缓冲只显示尾 50 行，ANSI 控制码剥除', async () => {
    const lines: string[] = []
    for (let i = 1; i <= 60; i++) lines.push(`line-${i}`)
    lines[59] = '\u001b[32mcolored-tail\u001b[0m'
    scrollbackMock.mockResolvedValue(new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer)
    const w = await mountOpened([target('t-ok')])

    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    const pre = w.find('.tbr-cell-pre')
    const text = pre.text()
    const shown = text.split('\n')
    expect(shown).toHaveLength(50)
    expect(shown[0]).toBe('line-11') // 尾 50 行首行 = 第 11 行
    expect(shown[49]).toBe('colored-tail')
    expect(text).not.toContain('line-10\n')
    expect(text).not.toContain('\u001b')
    w.unmount()
  })

  it('全部刷新重拉（长命令二次回看）；无 ok 目标时刷新禁用', async () => {
    scrollbackMock.mockResolvedValue(bufferOf(1))
    const w = await mountOpened([target('t-a'), target('t-b')])

    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(scrollbackMock).toHaveBeenCalledTimes(2)

    const refreshBtn = w.find('[data-testid="terminal-broadcast-result-refresh"]')
    await refreshBtn.trigger('click')
    await flush()
    expect(scrollbackMock).toHaveBeenCalledTimes(4)
    expect(scrollbackMock).toHaveBeenNthCalledWith(3, 't-a', { silent: true })
    expect(scrollbackMock).toHaveBeenNthCalledWith(4, 't-b', { silent: true })

    // 全灰态面板：刷新钮禁用（无可看内容，重拉无意义）
    const w2 = await mountOpened([target('t-gone', 'missing')])
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(w2.find('[data-testid="terminal-broadcast-result-refresh"]').attributes('disabled')).toBeDefined()
    expect(scrollbackMock).toHaveBeenCalledTimes(4) // 未增量
    w2.unmount()
    w.unmount()
  })

  it('拉取失败单元格转 error 态就地呈现（不炸整面板）；重开面板重拉', async () => {
    scrollbackMock.mockRejectedValueOnce(new Error('gone'))
    scrollbackMock.mockResolvedValue(bufferOf(1))
    const w = await mountOpened([target('t-a')])

    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(w.find('[data-testid="terminal-broadcast-result-cell"]').text()).toContain('抓取失败')

    // 关闭再打开：重拉（重开 = 最新尾部输出，面板内容不滞旧）
    await w.setProps({ show: false })
    await flush()
    await w.setProps({ show: true })
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(scrollbackMock).toHaveBeenCalledTimes(2)
    expect(w.find('.tbr-cell-pre').text()).toContain('line-1')
    w.unmount()
  })

  it('面板开着时再次广播（目标集换代）重拉新目标集；纯名称漂移不重置', async () => {
    scrollbackMock.mockResolvedValue(bufferOf(1))
    const w = await mountOpened([target('t-a')])
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    expect(scrollbackMock).toHaveBeenCalledTimes(1)

    // 第二次广播：lastResult 换代 → targets 换新 id 集（show 保持 true）
    await w.setProps({ targets: [target('t-a'), target('t-new')] })
    await flush()
    await vi.advanceTimersByTimeAsync(1500)
    await flush()
    // 新目标集整轮重拉（t-a + t-new），不是只补拉新目标
    expect(scrollbackMock).toHaveBeenCalledTimes(3)
    expect(scrollbackMock).toHaveBeenLastCalledWith('t-new', { silent: true })
    expect(w.findAll('[data-testid="terminal-broadcast-result-cell"]')).toHaveLength(2)

    // 纯名称漂移（id/state 不变，如会话列表对账回填名字）：不重拉不打断
    await w.setProps({ targets: [target('t-a', 'ok', '改名-A'), target('t-new', 'ok', '改名-N')] })
    await flush()
    await vi.advanceTimersByTimeAsync(3000)
    await flush()
    expect(scrollbackMock).toHaveBeenCalledTimes(3)
    w.unmount()
  })
})
