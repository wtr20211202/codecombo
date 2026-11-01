import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock 边界：本组合式的外部依赖只有 ① instanceFetch 实例通道 ② 实例列表
// store。聚合排序/离线容错/延后过滤全部是真实现（不 mock 被测逻辑本身）──
const { fetchMock } = vi.hoisted(() => ({
  fetchMock: vi.fn<(instanceId: string, method: string, path: string) => Promise<unknown>>(),
}))
vi.mock('../api/instanceFetch', () => ({
  instanceFetch: fetchMock,
  instanceFetchRaw: vi.fn(),
}))

const storeMock = vi.hoisted(() => ({
  instances: [
    { id: 'local', name: '中心机', isLocal: true, url: '', status: 'online' },
    { id: 'inst-a', name: '远程A', isLocal: false, url: 'http://10.0.0.9:9990', status: 'online' },
    { id: 'inst-b', name: '远程B', isLocal: false, url: 'http://10.0.0.9:9991', status: 'online' },
  ],
  fetchInstances: vi.fn(async () => {}),
}))
vi.mock('../stores/instance', () => ({ useInstanceStore: () => storeMock }))

import { severityRank, notifyTitle, useFleetNotifications } from './useFleetNotify'
import type { NotificationItem } from '../api/client'

/** 通知条目工厂（只给测试关心的字段，缺省未读 info / 3 分钟前） */
function n(over: Partial<NotificationItem> & { id: string }): NotificationItem {
  return {
    type: 'info',
    category: 'system',
    title: over.id,
    time: new Date(Date.now() - 3 * 60_000).toISOString(),
    read: false,
    ...over,
  }
}

/** 接线逐实例 mock：按实例 id 分发数据或抛错（模拟不可达） */
function seed(byInstance: Record<string, NotificationItem[] | Error>) {
  fetchMock.mockImplementation(async (instanceId: string) => {
    const v = byInstance[instanceId]
    if (v instanceof Error) throw v
    return { data: v ?? [] }
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  storeMock.instances = [
    { id: 'local', name: '中心机', isLocal: true, url: '', status: 'online' },
    { id: 'inst-a', name: '远程A', isLocal: false, url: 'http://10.0.0.9:9990', status: 'online' },
    { id: 'inst-b', name: '远程B', isLocal: false, url: 'http://10.0.0.9:9991', status: 'online' },
  ]
})

describe('useFleetNotify 跨实例通知聚合（P-20261003-125）', () => {
  it('全量装载：本机块置顶 + 全部远程块并行拉取；error/warning 优先排序（同级时间倒序）', async () => {
    seed({
      local: [n({ id: 'l-info', type: 'info' })],
      'inst-a': [
        n({ id: 'a-old-warn', type: 'warning', time: new Date(Date.now() - 60 * 60_000).toISOString() }),
        n({ id: 'a-new-warn', type: 'warning' }),
        n({ id: 'a-err', type: 'error', time: new Date(Date.now() - 90 * 60_000).toISOString() }),
      ],
      'inst-b': [n({ id: 'b-succ', type: 'success' })],
    })
    const fleet = useFleetNotifications()
    await fleet.load()

    // 块结构：本机块第一，远程块按实例列表序
    expect(fleet.instances.value.map(b => b.id)).toEqual(['local', 'inst-a', 'inst-b'])
    expect(fleet.instances.value[0]!.name).toBe('中心机')
    // 聚合排序：error（即便最旧）> warning 新 > warning 旧 > success > info
    expect(fleet.aggregated.value.map(r => r.item.id)).toEqual([
      'a-err', 'a-new-warn', 'a-old-warn', 'b-succ', 'l-info',
    ])
    // 实例徽标随行：跨块排序后仍能定位来源实例
    const first = fleet.aggregated.value[0]!
    expect(first.instanceId).toBe('inst-a')
    expect(first.instanceName).toBe('远程A')
    expect(first.isLocal).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('拉取失败实例标离线不拖垮整体：其余实例数据照常聚合，恢复后自愈', async () => {
    seed({
      // b-1 显式更旧的时间：聚合同级按时间倒序（useFleetNotify.ts 比较器），
      // 两缺省时间各取 Date.now() 相差亚毫秒——同毫秒才靠稳定序成立，跨毫秒
      // 即翻转（实测 flake），显式错开让断言序由比较器语义确定性给出
      local: [n({ id: 'l-1' })],
      'inst-a': new Error('502'),
      'inst-b': [n({ id: 'b-1', time: new Date(Date.now() - 10 * 60_000).toISOString() })],
    })
    const fleet = useFleetNotifications()
    await fleet.load()

    expect(fleet.instances.value.find(b => b.id === 'inst-a')!.reachable).toBe(false)
    expect(fleet.offlineCount.value).toBe(1)
    // 本机（恒可达）+ 远程B 照常入聚合；离线块不出行
    expect(fleet.aggregated.value.map(r => r.instanceId)).toEqual(['local', 'inst-b'])

    // 恢复在线：下一轮静默刷新自愈，离线注记消失
    seed({ local: [n({ id: 'l-1' })], 'inst-a': [n({ id: 'a-1' })], 'inst-b': [n({ id: 'b-1' })] })
    await fleet.refreshAll()
    expect(fleet.instances.value.find(b => b.id === 'inst-a')!.reachable).toBe(true)
    expect(fleet.offlineCount.value).toBe(0)
    expect(fleet.aggregated.value).toHaveLength(3)
  })

  it('静默轮询失败只降级不清已有数据（值班面不因抖动闪没列表）', async () => {
    seed({ local: [n({ id: 'l-1' })], 'inst-a': [], 'inst-b': [] })
    const fleet = useFleetNotifications()
    await fleet.load()
    expect(fleet.aggregated.value).toHaveLength(1)

    seed({ local: new Error('timeout'), 'inst-a': [], 'inst-b': [] })
    await fleet.refreshAll()
    expect(fleet.instances.value.find(b => b.id === 'local')!.reachable).toBe(false)
    // 已有数据保留（非 silent 路径才清空），未计入聚合但块内仍在
    expect(fleet.instances.value.find(b => b.id === 'local')!.items).toHaveLength(1)
    expect(fleet.aggregated.value).toHaveLength(0)
  })

  it('延后中条目不入聚合（尊重专注保护语义），服务端巡检清标（重挂）后回归', async () => {
    seed({
      local: [
        n({ id: 'l-snoozed', snoozeUntil: new Date(Date.now() + 30 * 60_000).toISOString() }),
        // 已过期但标记未清（服务端分钟巡检重挂前的空窗态）：标记在位即延后中，
        // 与 notification store isSnoozed 同口径——回归的唯一路径是服务端清标
        //（重挂），不按墙钟提前弹回
        n({ id: 'l-snooze-flagged', snoozeUntil: new Date(Date.now() - 60_000).toISOString(), time: new Date(Date.now() - 60_000).toISOString() }),
        n({ id: 'l-normal', time: new Date(Date.now() - 5 * 60_000).toISOString() }),
      ],
      'inst-a': [],
      'inst-b': [],
    })
    const fleet = useFleetNotifications()
    await fleet.load()
    expect(fleet.aggregated.value.map(r => r.item.id)).toEqual(['l-normal'])

    // 服务端重挂 = 清标记（+置未读/时间戳前移，聚合面只关心标记）：条目回归
    seed({
      local: [
        n({ id: 'l-snooze-flagged', time: new Date(Date.now() - 30_000).toISOString() }),
        n({ id: 'l-normal', time: new Date(Date.now() - 5 * 60_000).toISOString() }),
      ],
      'inst-a': [],
      'inst-b': [],
    })
    await fleet.refreshAll()
    // 断言序（同级时间倒序 → 重挂件在前）：重挂条目时间戳已被服务端前移
    expect(fleet.aggregated.value.map(r => r.item.id)).toEqual(['l-snooze-flagged', 'l-normal'])
  })

  it('未读计数族：总数 / error / 异常（error+warning）/ 逐实例，已读不计', async () => {
    seed({
      local: [n({ id: 'l-err', type: 'error' }), n({ id: 'l-read', type: 'error', read: true })],
      'inst-a': [n({ id: 'a-warn', type: 'warning' }), n({ id: 'a-info', type: 'info' })],
      'inst-b': [],
    })
    const fleet = useFleetNotifications()
    await fleet.load()

    expect(fleet.unreadCount.value).toBe(3)
    expect(fleet.unreadErrorCount.value).toBe(1)
    expect(fleet.unreadIssueCount.value).toBe(2)
    expect(fleet.unreadByInstance.value.get('local')).toBe(1)
    expect(fleet.unreadByInstance.value.get('inst-a')).toBe(2)
    expect(fleet.unreadByInstance.value.has('inst-b')).toBe(false)
  })

  it('纯函数面：severityRank 未知类型归最低档；notifyTitle 走 titleKey 模板、原文回退', () => {
    expect(severityRank('error')).toBeLessThan(severityRank('warning'))
    expect(severityRank('warning')).toBeLessThan(severityRank('success'))
    expect(severityRank('success')).toBeLessThan(severityRank('info'))
    expect(severityRank('mystery')).toBe(severityRank('info'))

    const t = (k: string, p?: Record<string, unknown>) =>
      p ? `${k}(${Object.values(p).join(',')})` : k
    expect(notifyTitle({ ...n({ id: 'x' }), titleKey: 'report.daily.title', msgParams: { n: 3 } }, t))
      .toBe('report.daily.title(3)')
    expect(notifyTitle(n({ id: 'x', title: '原文标题' }), t)).toBe('原文标题')
  })
})
