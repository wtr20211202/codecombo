import { describe, expect, it } from 'vitest'
import { restageSuggestion, restageStep } from './restageName'

// 回收站冲突恢复建议名（P-20261006-15）：<stem>-restaged<步进>.<ext>
describe('restageSuggestion', () => {
  it('常规扩展名替换主干', () => {
    expect(restageSuggestion('probe.md')).toBe('probe-restaged.md')
    expect(restageSuggestion('a.b.txt')).toBe('a.b-restaged.txt')
  })

  it('无扩展名与点开头隐藏文件整体作主干', () => {
    expect(restageSuggestion('Makefile')).toBe('Makefile-restaged')
    expect(restageSuggestion('.env')).toBe('.env-restaged')
    expect(restageSuggestion('.gitignore')).toBe('.gitignore-restaged')
  })
})

describe('restageStep', () => {
  it('首建议无步进号 → -2', () => {
    expect(restageStep('probe-restaged.md')).toBe('probe-restaged-2.md')
    expect(restageStep('Makefile-restaged')).toBe('Makefile-restaged-2')
  })

  it('已有步进号递增', () => {
    expect(restageStep('probe-restaged-2.md')).toBe('probe-restaged-3.md')
    expect(restageStep('probe-restaged-10.md')).toBe('probe-restaged-11.md')
  })

  it('非建议名形态回落首建议（防误用兜底）', () => {
    expect(restageStep('probe.md')).toBe('probe-restaged.md')
  })

  it('多段 -restaged 主干取最末尾缀步进', () => {
    expect(restageStep('a-restaged-restaged.txt')).toBe('a-restaged-restaged-2.txt')
  })
})
