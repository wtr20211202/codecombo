// mdAnchorSlug 单测（P-20261007-7 md 预览页内锚点）
//
// slug 折叠规则（小写 / 去标点 / 中文保留 / 空白转连字符）与重名去重、
// reset 复位——渲染侧挂 id 与点击侧精确匹配都建立在这套规则之上。
import { describe, expect, it } from 'vitest'
import { createMdHeadingSlugger, mdHeadingSlug } from './mdAnchorSlug'

describe('mdHeadingSlug', () => {
  it('小写 + 空白转连字符', () => {
    expect(mdHeadingSlug('Hello World')).toBe('hello-world')
    expect(mdHeadingSlug('  Quick Start  ')).toBe('quick-start')
    expect(mdHeadingSlug('API Reference')).toBe('api-reference')
  })

  it('剔除非字母数字空白连字符下划线的字符（标点脱落）', () => {
    expect(mdHeadingSlug('API (v2): 使用指南!')).toBe('api-v2-使用指南')
    expect(mdHeadingSlug('What is "simple-coding"?')).toBe('what-is-simple-coding')
    expect(mdHeadingSlug('a/b\\c:d*e?f')).toBe('abcdef')
  })

  it('中文保留（\\p{L} 字母集）', () => {
    expect(mdHeadingSlug('第一节')).toBe('第一节')
    expect(mdHeadingSlug('架构 设计')).toBe('架构-设计')
    expect(mdHeadingSlug('常见问题 FAQ')).toBe('常见问题-faq')
  })

  it('下划线与数字保留', () => {
    expect(mdHeadingSlug('foo_bar')).toBe('foo_bar')
    expect(mdHeadingSlug('Step 1: Init')).toBe('step-1-init')
  })

  it('多个空白逐个转连字符（GitHub 同款，不折叠）', () => {
    expect(mdHeadingSlug('a  b')).toBe('a--b')
  })

  it('空串 / 纯标点折叠为空串（渲染侧据此不挂 id）', () => {
    expect(mdHeadingSlug('')).toBe('')
    expect(mdHeadingSlug('!!!')).toBe('')
    expect(mdHeadingSlug('   ')).toBe('')
  })
})

describe('createMdHeadingSlugger', () => {
  it('重名按出现序缀 -1 -2 递增（github-slugger 同款）', () => {
    const slug = createMdHeadingSlugger()
    expect(slug('Top')).toBe('top')
    expect(slug('TOP')).toBe('top-1')
    expect(slug('top')).toBe('top-2')
  })

  it('不同标题互不干扰，仅同 base 去重', () => {
    const slug = createMdHeadingSlugger()
    expect(slug('安装')).toBe('安装')
    expect(slug('使用')).toBe('使用')
    expect(slug('安装')).toBe('安装-1')
    expect(slug('使用')).toBe('使用-1')
  })

  it('重名后缀与后续同名标题继续递增不回绕', () => {
    const slug = createMdHeadingSlugger()
    expect(slug('Notes')).toBe('notes')
    expect(slug('Notes')).toBe('notes-1')
    expect(slug('Notes')).toBe('notes-2')
  })

  it('reset 复位去重计数（每个 parse 独立计数的前提）', () => {
    const slug = createMdHeadingSlugger()
    expect(slug('Top')).toBe('top')
    expect(slug('Top')).toBe('top-1')
    slug.reset()
    expect(slug('Top')).toBe('top')
  })
})
