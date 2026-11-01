import { describe, it, expect, vi, beforeEach } from 'vitest'
import { defineComponent, h, type Component } from 'vue'
import { mount } from '@vue/test-utils'
import InstanceNotifyOverview from '../../components/instance/InstanceNotifyOverview.vue'

// 组件测试（P-20261003-125 只读聚合）：mock 实例通道与两个 store，
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
  fetchInstances: vi.fn(async () => {}),
}))
vi.mock('../../stores/instance', () => ({ useInstanceStore: () => storeMock }))

const openCenterMock = vi.hoisted(() => vi.fn())
vi.mock('../../stores/notification', () => ({
  useNotificationStore: () => ({ open: openCenterMock }),
}))

const NModalStub = defineComponent({
  props: { show: { type: Boolean, default: false } },
  setup(props, { slots }) {
    return () => (props.show ? h('div', { class: 'modal-stub' }, [slots['header-extra']?.(), slots.default?.()]) : null)
  },
})

import type { NotificationItem } from '../../api/client'

/** 通知条目工厂（缺省未读 info） */
function n(over: Partial<NotificationItem> & { id: string }): NotificationItem {
  return {
    type: 'info', category: 'system', title: over.id,
    time: new Date(Date.now() - 3 * 60_000).toISOString(), read: false, ...over,
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** 打开弹层（show false→true 触发 load） */
const mounted: ReturnType<typeof mount>[] = []
async function mountOpened() {
  const w = mount(InstanceNotifyOverview, {
    props: { show: false },
    global: { stubs: { NModal: NModalStub as unknown as Component, Modal: NModalStub as unknown as Component } },
    attachTo: document.body,
  })
  mounted.push(w)
  await w.setProps({ show: true })
  await flush()
  return w
}

beforeEach(() => {
  fetchMock.mockReset()
  openCenterMock.mockClear()
  storeMock.instances = [
    { id: 'local', name: '中心机', isLocal: true, url: '', status: 'online' },
    { id: 'inst-a', name: '远程A', isLocal: false, url: 'http://10.0.0.9:9990', status: 'online' },
  ]
})

import { afterEach } from 'vitest'
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

describe('InstanceNotifyOverview 跨实例通知聚合', () => {
  it('聚合渲染：error 置顶 + 实例徽标随行 + 离线实例标记与注记条', async () => {
    fetchMock.mockImplementation(async (instanceId: string) => {
      if (instanceId === 'local') return { data: [n({ id: 'l-1', type: 'error', title: '中心异常' })] }
      if (instanceId === 'inst-a') throw new Error('502')
      return { data: [] }
    })
    const w = await mountOpened()

    // 实例徽标行：本机 + 远程A（离线）；离线注记条出现
    const chips = w.findAll('[data-testid="fleet-notify-chip"]')
    expect(chips).toHaveLength(2)
    expect(chips[0]!.text()).toContain('中心机')
    expect(chips[1]!.text()).toContain('远程A')
    expect(chips[1]!.text()).toContain('不可达')
    expect(w.find('[data-testid="fleet-notify-offline"]').exists()).toBe(true)
    // 聚合行：error 置顶、实例徽标「中心机」随行
    const rows = w.findAll('[data-testid="fleet-notify-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text()).toContain('中心异常')
    expect(rows[0]!.text()).toContain('中心机')
  })

  it('只读聚合：行内零操作按钮（跨实例写不引入）；「通知中心」按钮回本实例', async () => {
    fetchMock.mockImplementation(async (instanceId: string) => ({
      data: instanceId === 'local'
        ? [n({ id: 'l-1', type: 'error', title: 'E' }), n({ id: 'l-2', type: 'info', title: 'I' })]
        : [n({ id: 'a-1', type: 'warning', title: 'W' })],
    }))
    const w = await mountOpened()

    // 聚合行无任何按钮（已读/移除/延后回各自实例通知中心做）
    for (const row of w.findAll('[data-testid="fleet-notify-row"]')) {
      expect(row.findAll('button')).toHaveLength(0)
    }
    // 头部「通知中心」出口：点击关聚合弹层并开本实例通知中心
    await w.find('[data-testid="fleet-notify-open-center"]').trigger('click')
    expect(openCenterMock).toHaveBeenCalledTimes(1)
    expect(w.emitted('update:show')?.at(-1)).toEqual([false])
  })

  it('正交过滤：实例徽标点击只看该实例，「异常」页签只显 error/warning', async () => {
    fetchMock.mockImplementation(async (instanceId: string) => ({
      data: instanceId === 'local'
        ? [n({ id: 'l-1', type: 'error', title: '本机错误' })]
        : [n({ id: 'a-1', type: 'warning', title: '远程警告' }), n({ id: 'a-2', type: 'success', title: '远程成功' })],
    }))
    const w = await mountOpened()
    expect(w.findAll('[data-testid="fleet-notify-row"]')).toHaveLength(3)

    // 点远程A 徽标：只显该实例 2 行；再点取消回到全部
    const chipA = w.findAll('[data-testid="fleet-notify-chip"]')[1]!
    await chipA.trigger('click')
    expect(w.findAll('[data-testid="fleet-notify-row"]')).toHaveLength(2)
    await chipA.trigger('click')
    expect(w.findAll('[data-testid="fleet-notify-row"]')).toHaveLength(3)

    // 「异常」页签：success 行被滤掉（error/warning 语义，未读与否不影响）
    const issueBtn = w.findAll('.fno-filter').find(b => b.text() === '异常')!
    await issueBtn.trigger('click')
    const rows = w.findAll('[data-testid="fleet-notify-row"]')
    expect(rows).toHaveLength(2)
    expect(rows.map(r => r.text())).toEqual([expect.stringContaining('本机错误'), expect.stringContaining('远程警告')])
  })
})
