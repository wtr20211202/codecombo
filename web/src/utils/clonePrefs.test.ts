import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── mock 边界：只隔离 safeStorage（Map 兜底语义同 utils/storage 的内存路径），
// 被测模块本体零外部依赖，直接真身跑 ──
const backing = vi.hoisted(() => {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    clear: () => m.clear(),
  }
})

vi.mock('./storage', () => ({
  safeStorage: backing,
}))

import { fallbackClonePrefs, loadClonePrefs, saveClonePrefs } from './clonePrefs'

beforeEach(() => {
  backing.clear()
})

describe('loadClonePrefs 上次选择恢复（P-20261003-241）', () => {
  it('空存储 → 默认档（无记忆密钥 + 完整克隆）', () => {
    expect(loadClonePrefs()).toEqual({ sshKeyId: '', depth: 0 })
  })

  it('合法存档 → 原样恢复（密钥 id + 深度）', () => {
    backing.setItem('clone-prefs', JSON.stringify({ sshKeyId: 'key-1', depth: 50 }))
    expect(loadClonePrefs()).toEqual({ sshKeyId: 'key-1', depth: 50 })
  })

  it('非法深度（负数/小数/非数值/超上限）→ 仅深度回落 0，密钥保留', () => {
    backing.setItem('clone-prefs', JSON.stringify({ sshKeyId: 'key-1', depth: -1 }))
    expect(loadClonePrefs()).toEqual({ sshKeyId: 'key-1', depth: 0 })
    backing.setItem('clone-prefs', JSON.stringify({ sshKeyId: 'key-1', depth: 1.5 }))
    expect(loadClonePrefs()).toEqual({ sshKeyId: 'key-1', depth: 0 })
    backing.setItem('clone-prefs', JSON.stringify({ sshKeyId: 'key-1', depth: '50' }))
    expect(loadClonePrefs()).toEqual({ sshKeyId: 'key-1', depth: 0 })
    backing.setItem('clone-prefs', JSON.stringify({ sshKeyId: 'key-1', depth: 100001 }))
    expect(loadClonePrefs()).toEqual({ sshKeyId: 'key-1', depth: 0 })
  })

  it('字段缺失/类型不对 → 逐字段回落，不整档作废', () => {
    backing.setItem('clone-prefs', JSON.stringify({ sshKeyId: 3, depth: null }))
    expect(loadClonePrefs()).toEqual({ sshKeyId: '', depth: 0 })
    backing.setItem('clone-prefs', JSON.stringify({ depth: 2 }))
    expect(loadClonePrefs()).toEqual({ sshKeyId: '', depth: 2 })
  })

  it('非 JSON / 非对象脏数据 → 默认档起步不抛错', () => {
    backing.setItem('clone-prefs', '{not-json')
    expect(loadClonePrefs()).toEqual(fallbackClonePrefs())
    backing.setItem('clone-prefs', 'null')
    expect(loadClonePrefs()).toEqual(fallbackClonePrefs())
    backing.setItem('clone-prefs', JSON.stringify(['key-1', 5]))
    expect(loadClonePrefs()).toEqual(fallbackClonePrefs())
  })

  it('升级兼容：存档多出未知字段忽略不炸', () => {
    backing.setItem('clone-prefs', JSON.stringify({ sshKeyId: 'key-1', depth: 5, extra: true }))
    expect(loadClonePrefs()).toEqual({ sshKeyId: 'key-1', depth: 5 })
  })
})

describe('saveClonePrefs 选择变更即写（P-20261003-241）', () => {
  it('载荷原样落盘；写侧同样校验深度（防脏值入库）', () => {
    saveClonePrefs({ sshKeyId: 'key-1', depth: 5 })
    expect(backing.getItem('clone-prefs')).toBe(JSON.stringify({ sshKeyId: 'key-1', depth: 5 }))
    saveClonePrefs({ sshKeyId: '', depth: 0 })
    expect(backing.getItem('clone-prefs')).toBe(JSON.stringify({ sshKeyId: '', depth: 0 }))
    saveClonePrefs({ sshKeyId: 'key-1', depth: NaN }) // NaN 是 number：写侧同样拦截
    expect(backing.getItem('clone-prefs')).toBe(JSON.stringify({ sshKeyId: 'key-1', depth: 0 }))
  })
})
