import { describe, it, expect } from 'vitest'
import { parseSubject, buildChangelogDraft, CHANGELOG_GROUPS } from '@/utils/changelog'

describe('parseSubject', () => {
  it('feat: 前缀归 feat 并去前缀', () => {
    expect(parseSubject('feat: add filter')).toEqual({ group: 'feat', entry: 'add filter' })
  })
  it('带 scope 的 fix(panel): 归 fix 且 scope 不入条目', () => {
    expect(parseSubject('fix(panel): correct count')).toEqual({ group: 'fix', entry: 'correct count' })
  })
  it('大写前缀归一化（Feat:/FIX:）', () => {
    expect(parseSubject('Feat: a').group).toBe('feat')
    expect(parseSubject('FIX: b').group).toBe('fix')
  })
  it('breaking 的 type(scope)!: 仍识别类型', () => {
    expect(parseSubject('feat(api)!: redesign')).toEqual({ group: 'feat', entry: 'redesign' })
  })
  it('refactor/docs/perf 各归其组', () => {
    expect(parseSubject('refactor: move x').group).toBe('refactor')
    expect(parseSubject('docs: note y').group).toBe('docs')
    expect(parseSubject('perf: cache z').group).toBe('perf')
  })
  it('未收录前缀（chore/test）原样归 other 不丢条目', () => {
    expect(parseSubject('chore: bump deps')).toEqual({ group: 'other', entry: 'chore: bump deps' })
    expect(parseSubject('test: add case')).toEqual({ group: 'other', entry: 'test: add case' })
  })
  it('无前缀主题原样归 other', () => {
    expect(parseSubject('临时调试输出')).toEqual({ group: 'other', entry: '临时调试输出' })
  })
  it('空主题与纯前缀（feat:）归 other', () => {
    expect(parseSubject('')).toEqual({ group: 'other', entry: '' })
    expect(parseSubject('feat:')).toEqual({ group: 'other', entry: 'feat:' })
  })
})

describe('buildChangelogDraft', () => {
  const commits = [
    { hash: 'aaaaaaaa1111', subject: 'feat(panel): add filter' },
    { hash: 'bbbbbbbb2222', subject: 'fix: correct count' },
    { hash: 'cccccccc3333', subject: '临时调试输出' },
  ]

  it('按分区顺序聚合：## 分区 + 短 hash 条目，空分区不输出', () => {
    const d = buildChangelogDraft({ rangeLabel: 'v1..HEAD', commits })
    expect(d.empty).toBe(false)
    expect(d.markdown).toContain('# Changelog')
    expect(d.markdown).toContain('> v1..HEAD · 3 commits')
    expect(d.markdown.indexOf('## feat')).toBeLessThan(d.markdown.indexOf('## fix'))
    expect(d.markdown.indexOf('## fix')).toBeLessThan(d.markdown.indexOf('## other'))
    expect(d.markdown).toContain('- aaaaaaaa add filter')
    expect(d.markdown).toContain('- bbbbbbbb correct count')
    expect(d.markdown).toContain('- cccccccc 临时调试输出')
    expect(d.markdown).not.toContain('## docs')
    expect(d.markdown).not.toContain('panel)')
  })
  it('多行 message 只取主题行', () => {
    const d = buildChangelogDraft({ rangeLabel: 'r', commits: [{ hash: 'dddddddd4444', subject: 'feat: one\n\nbody line' }] })
    expect(d.markdown).toContain('- dddddddd one')
    expect(d.markdown).not.toContain('body line')
  })
  it('空 hash 条目不产生裸前缀（entry 直出）', () => {
    const d = buildChangelogDraft({ rangeLabel: 'r', commits: [{ hash: '', subject: 'feat: hashless' }] })
    expect(d.markdown).toContain('- hashless')
    expect(d.markdown).not.toContain('-  hashless') // 无「- <空> 」形态
  })
  it('截断时追加标注文案', () => {
    const d = buildChangelogDraft({ rangeLabel: 'r', commits, truncatedNote: '已达上限' })
    expect(d.truncated).toBe(true)
    expect(d.markdown).toContain('> 已达上限')
  })
  it('空区间返回 empty 且 markdown 为空', () => {
    const d = buildChangelogDraft({ rangeLabel: 'r', commits: [] })
    expect(d.empty).toBe(true)
    expect(d.markdown).toBe('')
  })
  it('分区表顺序恒定（防输出漂移）', () => {
    expect([...CHANGELOG_GROUPS]).toEqual(['feat', 'fix', 'refactor', 'docs', 'perf', 'other'])
  })
})
