import { setActivePinia, createPinia } from 'pinia'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useDndStore, DND_STORAGE_KEY, DND_MANUAL_STORAGE_KEY } from '@/stores/dnd'
import { useNotificationStore } from '@/stores/notification'
import i18n from '@/i18n'

// 免打扰偏好 store（P-20261002-40）例外类别扩展（P-20261003-115）：
// 落盘归一化（旧数据无 except 字段补默认值 = 升级即获得审批穿透，无需清数据）
// + isSilenced 的例外短路语义（生效点统一入口，门控调用方只带类别即可）
// 手动临时档（P-20261003-227）：独立落盘键 + 与时段规则 OR 组合 + 到期自动恢复
//（定时器清档 + 通知中心入账告知）

beforeEach(() => {
  localStorage.clear()
  setActivePinia(createPinia())
})

describe('dndStore 例外类别', () => {
  // 时段判定注入固定 now：用例窗口 end:'23:59' 在分钟精度半开区间 [start, end)
  //（utils/dndSchedule.ts isWithinDnd）下恰好盖不住 23:59 这一分钟——真实挂钟
  // 走到该分钟时「全天窗」判定为不活跃，整组假红（2026-10-14 0 点前编排门禁
  // 实测 3 例）。钉在窗口正午，跑点无关（下组 NIGHT 同款；假钟修法见
  // utils/alertSound.test.ts pinClockInsideWindow 先例）
  const DAY = new Date(2026, 9, 9, 12, 0)

  it('初始默认：例外表含 approval', () => {
    const store = useDndStore()
    expect(store.prefs.except).toEqual(['approval'])
  })

  it('load 旧落盘数据（无 except 字段）→ 补默认 approval（升级兼容迁移）', () => {
    localStorage.setItem(DND_STORAGE_KEY, JSON.stringify({ enabled: true, start: '22:00', end: '08:00' }))
    const store = useDndStore()
    store.load()
    expect(store.prefs.except).toEqual(['approval'])
  })

  it('load except 含未知值 → 白名单过滤（损坏/外来值不进偏好）', () => {
    localStorage.setItem(
      DND_STORAGE_KEY,
      JSON.stringify({ enabled: true, start: '22:00', end: '08:00', except: ['approval', 'garbage', 42] })
    )
    const store = useDndStore()
    store.load()
    expect(store.prefs.except).toEqual(['approval'])
  })

  it('set 不带 except → 归一化补默认；落盘 JSON 携带 except', () => {
    const store = useDndStore()
    store.set({ enabled: true, start: '00:00', end: '23:59' })
    expect(store.prefs.except).toEqual(['approval'])
    const saved = JSON.parse(localStorage.getItem(DND_STORAGE_KEY) || '{}') as { except?: string[] }
    expect(saved.except).toEqual(['approval'])
  })

  it('set except 清空 → 用户显式全关被保留（不被默认值覆盖）', () => {
    const store = useDndStore()
    store.set({ enabled: true, start: '00:00', end: '23:59', except: [] })
    expect(store.prefs.except).toEqual([])
  })

  it('isSilenced：例外类别命中 → 不静默；未命中/无类别 → 静默', () => {
    const store = useDndStore()
    store.set({ enabled: true, start: '00:00', end: '23:59' })
    expect(store.isSilenced('approval', undefined, DAY)).toBe(false)
    expect(store.isSilenced('task', undefined, DAY)).toBe(true)
    expect(store.isSilenced(undefined, undefined, DAY)).toBe(true)
  })

  it('isSilenced：例外清空后 approval 恢复静默（例外表可关）', () => {
    const store = useDndStore()
    store.set({ enabled: true, start: '00:00', end: '23:59', except: [] })
    expect(store.isSilenced('approval', undefined, DAY)).toBe(true)
  })

  it('load 损坏数据 → 回退默认（except 默认在位）', () => {
    localStorage.setItem(DND_STORAGE_KEY, '{broken json')
    const store = useDndStore()
    store.load()
    expect(store.prefs.enabled).toBe(false)
    expect(store.prefs.except).toEqual(['approval'])
  })
})

describe('dndStore error 级穿透（P-20261004-117）', () => {
  // 时段判定注入固定 now（跨午夜窗 22:00→08:00 + 23:30）——用例不随挂钟漂移
  const NIGHT = new Date(2026, 9, 9, 23, 30)

  it('初始默认：exceptError 开（警报可达性默认兑现）', () => {
    expect(useDndStore().prefs.exceptError).toBe(true)
  })

  it('load 旧落盘数据（无 exceptError 字段）→ 补默认开（升级即获得穿透，无需清数据）', () => {
    localStorage.setItem(DND_STORAGE_KEY, JSON.stringify({ enabled: true, start: '22:00', end: '08:00' }))
    const store = useDndStore()
    store.load()
    expect(store.prefs.exceptError).toBe(true)
  })

  it('load 损坏值（非布尔）→ 归一化为开；显式 false 保留（绝对静默是合法偏好）', () => {
    localStorage.setItem(
      DND_STORAGE_KEY,
      JSON.stringify({ enabled: true, start: '22:00', end: '08:00', exceptError: 'yes' })
    )
    useDndStore().load()
    expect(useDndStore().prefs.exceptError).toBe(true)

    localStorage.setItem(
      DND_STORAGE_KEY,
      JSON.stringify({ enabled: true, start: '22:00', end: '08:00', exceptError: false })
    )
    setActivePinia(createPinia())
    useDndStore().load()
    expect(useDndStore().prefs.exceptError).toBe(false)
  })

  it('isSilenced：时段内 error 级穿透不静默；warning/success/info 照旧静默', () => {
    const store = useDndStore()
    store.set({ enabled: true, start: '22:00', end: '08:00' })
    expect(store.isSilenced('task', 'error', NIGHT)).toBe(false)
    expect(store.isSilenced('task', 'warning', NIGHT)).toBe(true)
    expect(store.isSilenced('task', 'success', NIGHT)).toBe(true)
    expect(store.isSilenced('task', 'info', NIGHT)).toBe(true)
    // 不携带 type 的调用点（ops-notify toast 等语义不知分级者）不参与豁免
    expect(store.isSilenced('task', undefined, NIGHT)).toBe(true)
  })

  it('isSilenced：exceptError 关 → error 级恢复静默（开关可关）', () => {
    const store = useDndStore()
    store.set({ enabled: true, start: '22:00', end: '08:00', exceptError: false })
    expect(store.isSilenced('task', 'error', NIGHT)).toBe(true)
    const saved = JSON.parse(localStorage.getItem(DND_STORAGE_KEY) || '{}') as { exceptError?: boolean }
    expect(saved.exceptError).toBe(false)
  })

  it('error 穿透在两源之上统一判定：手动临时档开启时 error 级同样穿透', () => {
    const store = useDndStore()
    store.enableManual(60 * 60 * 1000)
    expect(store.isSilenced('task', 'error')).toBe(false)
    expect(store.isSilenced('task')).toBe(true)
  })

  it('类别例外表与 error 豁免并联互不覆盖：except 清空只关类别口，类型口照常放行', () => {
    const store = useDndStore()
    store.set({ enabled: true, start: '22:00', end: '08:00', except: [] })
    expect(store.isSilenced('approval', undefined, NIGHT)).toBe(true)
    expect(store.isSilenced('approval', 'error', NIGHT)).toBe(false)
  })
})

describe('dndStore 手动临时免打扰（P-20261003-227）', () => {
  it('enableManual(1h)：时段规则未启用也静默；落盘绝对到期时刻', () => {
    const store = useDndStore()
    store.enableManual(60 * 60 * 1000)
    expect(store.isSilenced()).toBe(true)
    expect(store.isSilenced('task')).toBe(true)
    const saved = JSON.parse(localStorage.getItem(DND_MANUAL_STORAGE_KEY) || '{}') as { until?: number }
    expect(saved.until).toBeGreaterThan(Date.now() + 59 * 60 * 1000)
  })

  it('enableManual() 无参：直到手动关（哨兵 0），disableManual 解除并清落盘', () => {
    const store = useDndStore()
    store.enableManual()
    expect(store.manualUntil).toBe(0)
    expect(store.isSilenced()).toBe(true)
    store.disableManual()
    expect(store.manualUntil).toBeNull()
    expect(store.isSilenced()).toBe(false)
    expect(localStorage.getItem(DND_MANUAL_STORAGE_KEY)).toBeNull()
    // 幂等：未开启时再关不炸
    expect(() => store.disableManual()).not.toThrow()
  })

  it('OR 组合：手动档开启不影响时段规则独立生效；时段开+手动关仍静默', () => {
    // 首半段断言走时段源：钉窗口内时刻防 23:59 分钟假红（同「例外类别」组 DAY 注记）
    const DAY = new Date(2026, 9, 9, 12, 0)
    const store = useDndStore()
    // 时段规则独立静默（手动档未开）
    store.set({ enabled: true, start: '00:00', end: '23:59' })
    expect(store.isSilenced(undefined, undefined, DAY)).toBe(true)
    // 时段规则关 + 手动档开 → 静默来自手动源
    store.set({ enabled: false, start: '00:00', end: '23:59' })
    store.enableManual(60 * 60 * 1000)
    expect(store.isSilenced(undefined, undefined, DAY)).toBe(true)
  })

  it('例外表在两源之上统一判定：手动档开启时 approval 照常穿透', () => {
    const store = useDndStore()
    store.enableManual(60 * 60 * 1000)
    expect(store.isSilenced('approval')).toBe(false)
    expect(store.isSilenced('task')).toBe(true)
    // 例外清空后 approval 也被手动档静默
    store.set({ enabled: false, start: '22:00', end: '08:00', except: [] })
    expect(store.isSilenced('approval')).toBe(true)
  })

  it('设置保存（set）不动手动档：两条写路径互不可见', () => {
    const store = useDndStore()
    store.enableManual(60 * 60 * 1000)
    store.set({ enabled: true, start: '22:00', end: '08:00' })
    expect(store.manualUntil).not.toBeNull()
    expect(store.isSilenced()).toBe(true)
  })

  it('到期自动恢复：定时器清档 + 清落盘 + 通知中心入账到期告知', () => {
    vi.useFakeTimers()
    try {
      const store = useDndStore()
      const notif = useNotificationStore()
      store.enableManual(60_000)
      expect(store.isSilenced()).toBe(true)
      vi.advanceTimersByTime(60_000)
      expect(store.manualUntil).toBeNull()
      expect(store.isSilenced()).toBe(false)
      expect(localStorage.getItem(DND_MANUAL_STORAGE_KEY)).toBeNull()
      const expiredTitle = i18n.global.t('notify.dndManual.expiredTitle') as string
      expect(notif.items.some(n => n.title === expiredTitle && n.category === 'system')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('到期前重开/手动关：旧到期回调失效（按值比对），新档不受牵连', () => {
    vi.useFakeTimers()
    try {
      const store = useDndStore()
      store.enableManual(60_000)
      store.enableManual(120_000) // 重开覆盖旧档
      vi.advanceTimersByTime(60_000)
      expect(store.isSilenced()).toBe(true) // 旧到期点不误清新档
      vi.advanceTimersByTime(60_000)
      expect(store.isSilenced()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('load 播种：未到期档恢复生效；已到期档静默清账不补发通知', () => {
    localStorage.setItem(DND_MANUAL_STORAGE_KEY, JSON.stringify({ until: Date.now() + 60_000 }))
    const store = useDndStore()
    store.load()
    expect(store.isSilenced()).toBe(true)

    // 已到期形态走全新 pinia（同 pinia 下 useDndStore 是同一实例，load 重入会串档）
    localStorage.setItem(DND_MANUAL_STORAGE_KEY, JSON.stringify({ until: Date.now() - 1_000 }))
    setActivePinia(createPinia())
    const notif2 = useNotificationStore()
    const store2 = useDndStore()
    store2.load()
    expect(store2.manualUntil).toBeNull()
    expect(store2.isSilenced()).toBe(false)
    expect(localStorage.getItem(DND_MANUAL_STORAGE_KEY)).toBeNull()
    // 到期发生在离线期间：不补发「已结束」（启动期噪声），通知中心零新增
    expect(notif2.items).toHaveLength(0)
  })

  it('load 损坏/外来值（非数字/负数）→ 按关处理', () => {
    localStorage.setItem(DND_MANUAL_STORAGE_KEY, '{"until":"soon"}')
    const store = useDndStore()
    store.load()
    expect(store.manualUntil).toBeNull()
    expect(store.isSilenced()).toBe(false)

    localStorage.setItem(DND_MANUAL_STORAGE_KEY, '{"until":-5}')
    const store2 = useDndStore()
    store2.load()
    expect(store2.manualUntil).toBeNull()
  })
})
