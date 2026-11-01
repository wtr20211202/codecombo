import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, type Component } from 'vue'
import { mount } from '@vue/test-utils'
import InstanceSessionOverview from '../../components/instance/InstanceSessionOverview.vue'

// 组件测试（P-20261002-29 自动刷新）：mock 实例通道与两个 store，
// i18n/naive-ui 其余部分走 setup.ts 的全局 mock（真实 zh 文案直译）。
// NModal 用渲染函数桩替换（jsdom 下真实 NModal 经 teleport 挂 body，
// wrapper 查询不可达；且运行时无模板编译器，桩不能用 template 字符串）。
const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../../api/instanceFetch', () => ({
  instanceFetch: fetchMock,
  instanceFetchRaw: vi.fn(),
}))

const storeMock = vi.hoisted(() => ({
  instances: [
    { id: 'local', name: '中心机', isLocal: true, url: '', status: 'online' },
    { id: 'inst-a', name: '远程A', isLocal: false, url: 'http://10.0.0.9:9990', status: 'online' },
  ],
  currentInstanceId: 'local',
  fetchInstances: vi.fn(async () => {}),
  selectInstance: vi.fn(async () => {}),
  setSessionJump: vi.fn(),
}))
vi.mock('../../stores/instance', () => ({ useInstanceStore: () => storeMock }))
vi.mock('../../stores/project', () => ({ useProjectStore: () => ({ projects: [] }) }))

// useMessage 依赖 NMessageProvider 注入（jsdom 无 provider 会抛错）
vi.mock('naive-ui', async () => {
  const actual = await vi.importActual('naive-ui')
  return {
    ...(actual as object),
    useMessage: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }),
  }
})

const NModalStub = defineComponent({
  props: { show: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.show ? h('div', { class: 'modal-stub' }, [slots['header-extra']?.(), slots.default?.()]) : null)
  },
})

const session = (id: string, name: string) => ({ id, name, kind: 'shell', projectId: '', projectName: '' })

/** 微任务冲刷：fetch mock 即时 resolve，轮询/响应式更新数跳微任务即落定
 *  （不用 @vue/test-utils 的 flushPromises——其 setTimeout 在假时钟下不走） */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** 打开总览（show false→true 触发 load + 启动轮询），返回远程块定位器 */
const mounted: ReturnType<typeof mount>[] = []
async function mountOpened() {
  const w = mount(InstanceSessionOverview, {
    props: { show: false },
    // 桩键双写：naive-ui NModal 内部 name 是 'Modal'（VTU 按 type.name 匹配）
    global: { stubs: { NModal: NModalStub as unknown as Component, Modal: NModalStub as unknown as Component } },
    attachTo: document.body,
  })
  mounted.push(w)
  await w.setProps({ show: true })
  await flush()
  return w
}

function remoteBlock(w: ReturnType<typeof mount>) {
  return w.findAll('.iso-block').find(b => b.text().includes('远程A'))!
}

let hiddenSpy: ReturnType<typeof vi.spyOn> | null = null

beforeEach(() => {
  vi.useFakeTimers()
  fetchMock.mockReset()
  storeMock.fetchInstances.mockClear()
})

afterEach(() => {
  // 必须 unmount（而非只清 body）：实例级 visibilitychange 监听随卸载移除，
  // 漏卸会让上一用例仍打开的总览响应下一用例的事件、多打轮询请求
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
  if (hiddenSpy) {
    hiddenSpy.mockRestore()
    hiddenSpy = null
  }
  vi.useRealTimers()
})

describe('InstanceSessionOverview 自动刷新', () => {
  it('打开加载两块；30s 轮询只刷远程块（本地不参与），数据变化回灌列表', async () => {
    const localRows = [session('l1', '本机会话')]
    let remoteRows = [session('r1', '远程会话一')]
    fetchMock.mockImplementation((instanceId: string) =>
      Promise.resolve({ data: instanceId === 'local' ? localRows : remoteRows }))

    const w = await mountOpened()
    // 首次 load：本机 + 远程各拉一次
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(remoteBlock(w).findAll('.iso-row')).toHaveLength(1)

    // 远程数据变化（新会话上线），推进一个轮询周期
    remoteRows = [...remoteRows, session('r2', '远程会话二')]
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()

    // 远程块重拉且列表更新；本地块未被轮询触碰
    expect(fetchMock).toHaveBeenCalledTimes(3)
    const callsByInst = fetchMock.mock.calls.map(c => c[0])
    expect(callsByInst.filter(id => id === 'local')).toHaveLength(1)
    expect(callsByInst.filter(id => id === 'inst-a')).toHaveLength(2)
    expect(remoteBlock(w).findAll('.iso-row')).toHaveLength(2)
    // 远程块带「最后刷新」时间戳（刚刷完 → activityJustNow 文案）
    expect(remoteBlock(w).find('.iso-refreshed').text()).toBe('刚刚')
    w.unmount()
  })

  it('document.hidden 暂停轮询；回前台立即补刷一次并恢复周期', async () => {
    const rows = [session('r1', '远程会话一')]
    fetchMock.mockResolvedValue({ data: rows })

    const w = await mountOpened()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()

    // 不可见期间时间流逝：不产生任何新请求
    await vi.advanceTimersByTimeAsync(90_000)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 回前台：立即补刷一次（仅远程块）+ 周期恢复
    hiddenSpy.mockReturnValue(false)
    document.dispatchEvent(new Event('visibilitychange'))
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    w.unmount()
  })

  it('轮询失败沿用离线态但数据不清空；恢复在线后下一轮自愈，超时未刷变黄', async () => {
    fetchMock.mockImplementation((instanceId: string) =>
      instanceId === 'local'
        ? Promise.resolve({ data: [] })
        : Promise.resolve({ data: [session('r1', '远程会话一')] }))

    const w = await mountOpened()
    expect(remoteBlock(w).findAll('.iso-row')).toHaveLength(1)

    // 远程实例掉线：连续两轮失败 → 离线标记 + 旧行保留
    fetchMock.mockImplementation((instanceId: string) =>
      instanceId === 'local' ? Promise.resolve({ data: [] }) : Promise.reject(new Error('down')))
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    const block = remoteBlock(w)
    expect(block.find('.iso-tag.bad').exists()).toBe(true)
    expect(block.findAll('.iso-row')).toHaveLength(1)

    // 再推进 125s：nowTick 随轮询周期推进（滞后于墙钟，停在 +150s 的 tick），
    // 距上次成功刷新 150s > 2 分钟 → 刷新时间戳变黄提示陈旧
    await vi.advanceTimersByTimeAsync(125_000)
    await flush()
    expect(remoteBlock(w).find('.iso-refreshed.stale').exists()).toBe(true)

    // 实例恢复：下一轮自愈回在线态并拉到新数据
    fetchMock.mockImplementation((instanceId: string) =>
      instanceId === 'local'
        ? Promise.resolve({ data: [] })
        : Promise.resolve({ data: [session('r1', '远程会话一'), session('r2', '远程会话二')] }))
    await vi.advanceTimersByTimeAsync(30_000)
    await flush()
    const healed = remoteBlock(w)
    expect(healed.find('.iso-tag.bad').exists()).toBe(false)
    expect(healed.findAll('.iso-row')).toHaveLength(2)
    expect(healed.find('.iso-refreshed.stale').exists()).toBe(false)
    w.unmount()
  })

  it('关闭总览停止轮询；头部「全部刷新」重拉所有块', async () => {
    const rows = [session('r1', '远程会话一')]
    fetchMock.mockResolvedValue({ data: rows })

    const w = await mountOpened()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await w.setProps({ show: false })
    await flush()
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // 重新打开 + 点头部全局刷新：所有块（含本地）各重拉一次
    await w.setProps({ show: true })
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(4)
    await w.find('button[aria-label="全部刷新"]').trigger('click')
    await flush()
    expect(fetchMock).toHaveBeenCalledTimes(6)
    const callsByInst = fetchMock.mock.calls.map(c => c[0])
    expect(callsByInst.filter(id => id === 'local')).toHaveLength(3)
    expect(callsByInst.filter(id => id === 'inst-a')).toHaveLength(3)
    w.unmount()
  })
})
