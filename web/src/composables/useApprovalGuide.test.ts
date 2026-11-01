import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock 边界：只隔离 safeStorage（Map 兜底语义同 utils/storage 的内存路径），
// composable 本体零外部依赖，直接真身跑 ──
const backing = vi.hoisted(() => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
})

vi.mock('../utils/storage', () => ({
  safeStorage: backing,
}))

import { APPROVAL_GUIDE_DISMISS_KEY, useApprovalGuide } from './useApprovalGuide'

/** 模块单例（dismissed 为模块级状态）跨用例复位：resetModules + 动态重取 */
async function fresh(): Promise<ReturnType<typeof useApprovalGuide>> {
  vi.resetModules()
  const m = await import('./useApprovalGuide')
  return m.useApprovalGuide()
}

beforeEach(() => {
  backing.clear()
})

describe('useApprovalGuide 首张审批卡首触说明状态（P-20261003-311）', () => {
  it('未 dismiss 时首次可见；dismiss 落一次性标记并即时消失', async () => {
    const g = await fresh()
    expect(g.dismissed.value).toBe(false)
    expect(backing.getItem(APPROVAL_GUIDE_DISMISS_KEY)).toBeNull()

    g.dismiss()
    // 同帧翻转（不等存储回读）+ 标记落 safeStorage（'1' 哨兵值）
    expect(g.dismissed.value).toBe(true)
    expect(backing.getItem(APPROVAL_GUIDE_DISMISS_KEY)).toBe('1')
  })

  it('已落标记的浏览器重启后不再提示（模块初始化读标记）', async () => {
    backing.setItem(APPROVAL_GUIDE_DISMISS_KEY, '1')
    const g = await fresh()
    expect(g.dismissed.value).toBe(true)
  })

  it('其他键的标记不影响判定（键名隔离）', async () => {
    backing.setItem('sc.localeSuggestDismissed', '1')
    const g = await fresh()
    expect(g.dismissed.value).toBe(false)
  })

  it('跨宿主单例：一处 dismiss 两处可见（全局卡堆与大屏同源）', async () => {
    vi.resetModules()
    const m = await import('./useApprovalGuide')
    const a = m.useApprovalGuide()
    const b = m.useApprovalGuide()
    expect(b.dismissed.value).toBe(false)
    a.dismiss()
    expect(b.dismissed.value).toBe(true)
  })
})
