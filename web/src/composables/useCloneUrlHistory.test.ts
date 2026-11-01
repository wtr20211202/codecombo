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

import type { useCloneUrlHistory as UseCloneUrlHistory } from './useCloneUrlHistory'

/** 模块单例（history 为模块级状态）跨用例复位：resetModules + 动态重取 */
async function fresh(): Promise<ReturnType<typeof UseCloneUrlHistory>> {
  vi.resetModules()
  const m = await import('./useCloneUrlHistory')
  return m.useCloneUrlHistory()
}

beforeEach(() => {
  backing.clear()
})

describe('useCloneUrlHistory 克隆 URL 历史（P-20261003-251）', () => {
  it('recordUrl 去重置顶：重复提交移到最近位，不产生双条目', async () => {
    const h = await fresh()
    h.recordUrl('https://github.com/u/a.git')
    h.recordUrl('https://github.com/u/b.git')
    h.recordUrl('https://github.com/u/a.git')
    expect(h.history.value).toEqual(['https://github.com/u/a.git', 'https://github.com/u/b.git'])
    expect(backing.getItem('clone-url-history')).toBe(JSON.stringify(['https://github.com/u/a.git', 'https://github.com/u/b.git']))
  })

  it('recordUrl 环形 ≤10：超容裁最旧；写入前 trim；空白串忽略', async () => {
    const h = await fresh()
    for (let i = 0; i < 11; i++) h.recordUrl(`https://host.invalid/r${i}.git `)
    expect(h.history.value.length).toBe(10)
    expect(h.history.value[0]).toBe('https://host.invalid/r10.git')
    expect(h.history.value).not.toContain('https://host.invalid/r0.git')
    h.recordUrl('   ')
    expect(h.history.value.length).toBe(10)
  })

  it('含凭据 URL（scheme://user:pass@）不入历史——明文密钥不落 localStorage', async () => {
    const h = await fresh()
    h.recordUrl('https://user:pass@github.com/u/secret.git')
    h.recordUrl('http://x-access-token:ghp_abc123@github.com/u/repo.git')
    h.recordUrl('  https://tok:en@host.invalid/r.git  ')
    expect(h.history.value).toEqual([])
    expect(backing.getItem('clone-url-history')).toBeNull()
  })

  it('非凭据的 @ 形态照常入史：SCP 短形与 ssh:// 登录名（userinfo 无冒号）不是凭据', async () => {
    const h = await fresh()
    h.recordUrl('git@github.com:u/repo.git')
    h.recordUrl('ssh://git@github.com:2222/u/repo.git')
    h.recordUrl('file:///C:/repos/local-src')
    expect(h.history.value).toEqual([
      'file:///C:/repos/local-src',
      'ssh://git@github.com:2222/u/repo.git',
      'git@github.com:u/repo.git',
    ])
  })

  it('hasUrlCredentials 判定表：user:pass@ 命中，登录名/带端口/本地路径不命中', async () => {
    const { hasUrlCredentials } = await import('./useCloneUrlHistory')
    expect(hasUrlCredentials('https://user:pass@github.com/o/r.git')).toBe(true)
    expect(hasUrlCredentials('HTTPS://user:pass@github.com/o/r.git')).toBe(true)
    expect(hasUrlCredentials('https://u:p@host:8080/o/r.git')).toBe(true)
    expect(hasUrlCredentials('https://github.com/o/r.git')).toBe(false)
    expect(hasUrlCredentials('https://github.com:8080/o/r.git')).toBe(false)
    expect(hasUrlCredentials('ssh://git@github.com/o/r.git')).toBe(false)
    expect(hasUrlCredentials('git@github.com:o/r.git')).toBe(false)
    expect(hasUrlCredentials('file:///C:/repos/x')).toBe(false)
  })

  it('filterByPrefix 大小写不敏感前缀匹配；空前缀返回全部', async () => {
    const h = await fresh()
    h.recordUrl('https://github.com/u/Alpha.git')
    h.recordUrl('https://github.com/u/again.git')
    h.recordUrl('git@gitlab.com:u/other.git')
    expect(h.filterByPrefix('HTTPS://GIT')).toEqual(['https://github.com/u/again.git', 'https://github.com/u/Alpha.git'])
    expect(h.filterByPrefix('  https://bitbucket ')).toEqual([])
    expect(h.filterByPrefix('')).toEqual(['git@gitlab.com:u/other.git', 'https://github.com/u/again.git', 'https://github.com/u/Alpha.git'])
  })

  it('clearHistory 内存态与持久层同清', async () => {
    const h = await fresh()
    h.recordUrl('https://github.com/u/a.git')
    expect(backing.getItem('clone-url-history')).not.toBeNull()
    h.clearHistory()
    expect(h.history.value).toEqual([])
    expect(backing.getItem('clone-url-history')).toBeNull()
  })

  it('脏存储容错：非 JSON / 非字符串数组 / 凭据残留 → 安全回落', async () => {
    backing.setItem('clone-url-history', '{not-json')
    let h = await fresh()
    expect(h.history.value).toEqual([])

    backing.setItem('clone-url-history', JSON.stringify(['ok', 3, null, '  ', 'https://u:p@host.invalid/r.git']))
    h = await fresh()
    expect(h.history.value).toEqual(['ok'])
  })
})
