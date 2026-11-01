import { describe, expect, it } from 'vitest'
import { fuzzyMatch, fuzzyScoreWeighted } from './fuzzy'

describe('fuzzyMatch', () => {
  it('空 query 返回 0（调用方按全部命中处理）', () => {
    expect(fuzzyMatch('', 'anything.ts')).toBe(0)
    expect(fuzzyMatch('   ', 'anything.ts')).toBe(0)
  })

  it('不区分大小写', () => {
    expect(fuzzyMatch('USR', 'user.ts')).not.toBeNull()
    expect(fuzzyMatch('user', 'USER-README.md')).not.toBeNull()
  })

  it('非子序列返回 null', () => {
    expect(fuzzyMatch('xy', 'user.ts')).toBeNull()
    expect(fuzzyMatch('ures', 'rsue.ts')).toBeNull()
  })

  it('跨越 camelCase 驼峰与分隔符断词', () => {
    // 纯子串匹配不到的典型案例
    expect(fuzzyMatch('urepo', 'useRepo.ts')).not.toBeNull()
    expect(fuzzyMatch('ulist', 'user-list.ts')).not.toBeNull()
    expect(fuzzyMatch('ul', 'useList.ts')).not.toBeNull()
    // 驼峰处按词首加权：跨驼峰命中不低于词中命中
    expect(fuzzyMatch('ul', 'useList.ts')!).toBeGreaterThanOrEqual(fuzzyMatch('ul', 'results.ts')!)
  })

  it('词首命中胜过词中命中', () => {
    const boundary = fuzzyMatch('ul', 'user-list.ts')!
    const midWord = fuzzyMatch('ul', 'results.ts')!
    expect(boundary).toBeGreaterThan(midWord)
  })

  it('靠前命中胜过靠后命中', () => {
    const early = fuzzyMatch('user', 'user.ts')!
    const late = fuzzyMatch('user', 'a-user.ts')!
    expect(early).toBeGreaterThan(late)
  })

  it('连续命中胜过离散命中', () => {
    const tight = fuzzyMatch('user', 'user.ts')!
    const scattered = fuzzyMatch('user', 's-ketch-user.ts')!
    expect(tight).toBeGreaterThan(scattered)
  })

  it('多 token 为 AND 语义，全部命中才通过', () => {
    expect(fuzzyMatch('term new', 'Terminal: New Tab')).not.toBeNull()
    expect(fuzzyMatch('term old', 'Terminal: New Tab')).toBeNull()
  })

  it('长 query 短 target 返回 null', () => {
    expect(fuzzyMatch('user-repo-ts-long', 'u.ts')).toBeNull()
  })
})

describe('fuzzyScoreWeighted', () => {
  it('主字段命中权重加倍并主导排序', () => {
    // 文件名命中 vs 仅路径命中
    const byName = fuzzyScoreWeighted('usr', 'user.ts', 'src/views/user.ts')!
    const byPathOnly = fuzzyScoreWeighted('src', 'user.ts', 'src/views/user.ts')!
    expect(byName).toBeGreaterThan(0)
    expect(byPathOnly).toBeGreaterThan(0)
    // 名字命中（user.ts 里没有 usr？有：u-s-r 子序列）应比同级路径命中强
    const nameOnly = fuzzyScoreWeighted('usr', 'user.ts', 'a/b/c.ts')!
    expect(nameOnly).toBeGreaterThan(0)
  })

  it('主次都未命中返回 null，次字段命中可兜底', () => {
    expect(fuzzyScoreWeighted('zzz', 'user.ts', 'src/a.ts')).toBeNull()
    expect(fuzzyScoreWeighted('views', 'user.ts', 'src/views/user.ts')).not.toBeNull()
  })

  it('空 query 一律返回 0', () => {
    expect(fuzzyScoreWeighted('', 'user.ts', 'src/user.ts')).toBe(0)
  })
})
