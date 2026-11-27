import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import {
  LOW_FX_DEFAULT,
  LOW_FX_ROOT_ATTR,
  LOW_FX_STORAGE_KEY,
  applyLowFxRootAttribute,
  parseLowFxQuery,
  readLowFxEarly,
  readStoredLowFx,
  useLowFxStore,
} from './low-fx'

// 低特效档 store（P-20261125-2 S2）：设备本地偏好（localStorage 轨），根属性
// html[data-low-fx="1"] 是 CSS 收口入口。覆盖：默认标准档 / 脏值回落 / query
// 一次性消费并落盘 / 根属性幂等增删 / setEnabled 直存直生效 / 跨标签 load 回读。

describe('low-fx store', () => {
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute(LOW_FX_ROOT_ATTR)
    setActivePinia(createPinia())
  })

  afterEach(() => {
    document.documentElement.removeAttribute(LOW_FX_ROOT_ATTR)
  })

  it('默认标准档（LOW_FX_DEFAULT=false），根属性不设', () => {
    const store = useLowFxStore()
    expect(store.enabled).toBe(LOW_FX_DEFAULT)
    expect(document.documentElement.hasAttribute(LOW_FX_ROOT_ATTR)).toBe(false)
  })

  it('parseLowFxQuery：1/0/其它三态', () => {
    expect(parseLowFxQuery('1')).toBe(true)
    expect(parseLowFxQuery('0')).toBe(false)
    expect(parseLowFxQuery(null)).toBeNull()
    expect(parseLowFxQuery('true')).toBeNull()
  })

  it('setEnabled 落盘 + 根属性即时增删', () => {
    const store = useLowFxStore()
    store.setEnabled(true)
    expect(document.documentElement.getAttribute(LOW_FX_ROOT_ATTR)).toBe('1')
    expect(JSON.parse(localStorage.getItem(LOW_FX_STORAGE_KEY) || '{}')?.enabled).toBe(true)

    store.setEnabled(false)
    expect(document.documentElement.hasAttribute(LOW_FX_ROOT_ATTR)).toBe(false)
    expect(JSON.parse(localStorage.getItem(LOW_FX_STORAGE_KEY) || '{}')?.enabled).toBe(false)
  })

  it('重开应用恢复已存档位（新 pinia 实例）', () => {
    useLowFxStore().setEnabled(true)
    setActivePinia(createPinia())
    expect(useLowFxStore().enabled).toBe(true)
    expect(document.documentElement.getAttribute(LOW_FX_ROOT_ATTR)).toBe('1')
  })

  it('脏值回落标准档（手改 localStorage 不崩不误开）', () => {
    localStorage.setItem(LOW_FX_STORAGE_KEY, JSON.stringify({ enabled: 'yes' }))
    expect(readStoredLowFx()).toBe(false)
    localStorage.setItem(LOW_FX_STORAGE_KEY, 'not-json')
    expect(readStoredLowFx()).toBe(false)
  })

  it('readLowFxEarly：无 query 回落存储；query=1 一次性消费并落盘（导航后仍保持）', () => {
    expect(readLowFxEarly('')).toBe(false)
    expect(readLowFxEarly('?__lowfx=1')).toBe(true)
    expect(JSON.parse(localStorage.getItem(LOW_FX_STORAGE_KEY) || '{}')?.enabled).toBe(true)
    // 后续无 query 的页（query 已在早期消费）仍读到开档
    expect(readLowFxEarly('?other=1')).toBe(true)
    expect(readLowFxEarly('?__lowfx=0')).toBe(false)
    expect(JSON.parse(localStorage.getItem(LOW_FX_STORAGE_KEY) || '{}')?.enabled).toBe(false)
  })

  it('load() 跨标签回读（settingsSync 入口）：改存储即改写根属性', () => {
    const store = useLowFxStore()
    localStorage.setItem(LOW_FX_STORAGE_KEY, JSON.stringify({ enabled: true }))
    store.load()
    expect(store.enabled).toBe(true)
    expect(document.documentElement.getAttribute(LOW_FX_ROOT_ATTR)).toBe('1')
  })

  it('根属性写入幂等：同值重写不产生额外属性/不抛错', () => {
    applyLowFxRootAttribute(true)
    applyLowFxRootAttribute(true)
    expect(document.documentElement.getAttribute(LOW_FX_ROOT_ATTR)).toBe('1')
    applyLowFxRootAttribute(false)
    applyLowFxRootAttribute(false)
    expect(document.documentElement.hasAttribute(LOW_FX_ROOT_ATTR)).toBe(false)
  })
})
