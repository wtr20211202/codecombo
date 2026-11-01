import { describe, expect, it } from 'vitest'
import {
  applyPreservedCase,
  buildFilePreview,
  buildLinePreview,
  buildReplaceRegex,
  contentHasMatch,
  replaceMatches,
} from './replacePreview'

// 批量替换预览共享层单测（P-20261003-71）：核心断言是「预览与执行零漂移」——
// after 文本必须等于执行链同一 replace 函数的产物，高亮片段必须可重组为该文本。

describe('buildReplaceRegex', () => {
  it('字面量模式转义特殊字符，整词加 \\b，大小写开关切换 i 标志', () => {
    expect(buildReplaceRegex('a.b', { caseSensitive: true, wholeWord: false, useRegex: false })!.source).toBe('a\\.b')
    expect(buildReplaceRegex('foo', { caseSensitive: true, wholeWord: true, useRegex: false })!.source).toBe('\\bfoo\\b')
    const re = buildReplaceRegex('Foo', { caseSensitive: false, wholeWord: false, useRegex: false })!
    expect(re.flags).toContain('i')
    expect(re.flags).toContain('g')
    expect(buildReplaceRegex('Foo', { caseSensitive: true, wholeWord: false, useRegex: false })!.flags).toBe('g')
  })
  it('正则模式沿用查询原文；非法正则返回 null（不抛错）', () => {
    expect(buildReplaceRegex('b.r', { caseSensitive: true, wholeWord: false, useRegex: true })!.source).toBe('b.r')
    expect(buildReplaceRegex('([unclosed', { caseSensitive: true, wholeWord: false, useRegex: true })).toBeNull()
  })
})

describe('replaceMatches / contentHasMatch', () => {
  it('替换为字面量——replacement 含 $& 等特殊序列不被二次解释', () => {
    const re = buildReplaceRegex('foo', { caseSensitive: false, wholeWord: false, useRegex: false })!
    expect(replaceMatches('foo bar foo', re, '$&-$1-$$')).toBe('$&-$1-$$ bar $&-$1-$$')
  })
  it('命中探测不复位 lastIndex 会串味：连续调用结果稳定', () => {
    const re = buildReplaceRegex('foo', { caseSensitive: false, wholeWord: false, useRegex: false })!
    expect(contentHasMatch('x foo x', re)).toBe(true)
    expect(contentHasMatch('x foo x', re)).toBe(true) // 复用同一 re 第二次仍命中
    expect(contentHasMatch('no hit', re)).toBe(false)
  })
})

describe('buildLinePreview', () => {
  it('after 等于执行链同一函数的全文替换产物；片段重组一致', () => {
    const re = buildReplaceRegex('foo', { caseSensitive: false, wholeWord: false, useRegex: false })!
    const row = buildLinePreview(1, 'foo bar foo', re, 'bar')!
    expect(row.after).toBe(replaceMatches('foo bar foo', re, 'bar'))
    expect(row.after).toBe('bar bar bar')
    expect(row.before).toBe('foo bar foo')
    expect(row.beforeSegments).toEqual([
      { text: 'foo', isMatch: true },
      { text: ' bar ', isMatch: false },
      { text: 'foo', isMatch: true },
    ])
    expect(row.afterSegments).toEqual([
      { text: 'bar', isMatch: true },
      { text: ' bar ', isMatch: false },
      { text: 'bar', isMatch: true },
    ])
    expect(row.afterSegments.map(s => s.text).join('')).toBe(row.after)
  })
  it('regex 模式：贪婪命中的 after 与执行一致（整行唯一命中段）', () => {
    const re = buildReplaceRegex('id-\\d+', { caseSensitive: true, wholeWord: false, useRegex: true })!
    const row = buildLinePreview(3, 'const v = id-0042;', re, 'ID')!
    expect(row.after).toBe('const v = ID;')
    expect(row.afterSegments.filter(s => s.isMatch).map(s => s.text)).toEqual(['ID'])
  })
  it('同行多处命中单行单段 after；大小写不敏感命中原文形态进入 before 片段', () => {
    const re = buildReplaceRegex('foo', { caseSensitive: false, wholeWord: false, useRegex: false })!
    const row = buildLinePreview(1, 'FOO foo Foo', re, 'x')!
    expect(row.after).toBe('x x x')
    expect(row.beforeSegments.filter(s => s.isMatch).map(s => s.text)).toEqual(['FOO', 'foo', 'Foo'])
  })
  it('无命中行返回 null；零宽命中不死循环', () => {
    const re = buildReplaceRegex('foo', { caseSensitive: true, wholeWord: false, useRegex: false })!
    expect(buildLinePreview(1, 'bar baz', re, 'x')).toBeNull()
    const zw = buildReplaceRegex('x*', { caseSensitive: true, wholeWord: false, useRegex: true })!
    const row = buildLinePreview(1, 'ab', zw, '-')!
    expect(row!.after).toBe(replaceMatches('ab', zw, '-')) // 权威文本对齐
    expect(row!.afterSegments.map(s => s.text).join('')).toBe(row!.after)
  })
})

describe('applyPreservedCase（P-20261006-16 保留大小写：三形态推断）', () => {
  it('全小写命中 → replacement 原样（getuser→fetchUser 重命名动机）', () => {
    expect(applyPreservedCase('fetchUser', 'getuser')).toBe('fetchUser')
    expect(applyPreservedCase('fetch_user', 'get_user')).toBe('fetch_user')
  })
  it('全大写命中 → 大写化', () => {
    expect(applyPreservedCase('fetchUser', 'GETUSER')).toBe('FETCHUSER')
    expect(applyPreservedCase('fetch_user', 'GET_USER')).toBe('FETCH_USER')
  })
  it('Title 形态（首字母大写其余全小写）→ replacement 首字母大写化', () => {
    expect(applyPreservedCase('fetchUser', 'Getuser')).toBe('FetchUser')
    expect(applyPreservedCase('fetch_user', 'Get_user')).toBe('Fetch_user')
  })
  it('混合形态不猜——原样输出；无大小写字符/空命中按全小写原样', () => {
    expect(applyPreservedCase('fetchUser', 'geTuser')).toBe('fetchUser')
    expect(applyPreservedCase('fetchUser', 'getUser')).toBe('fetchUser')
    expect(applyPreservedCase('fetch', '123')).toBe('fetch')
    expect(applyPreservedCase('fetch', '')).toBe('fetch')
  })
})

describe('replaceMatches preserveCase 选项', () => {
  it('逐命中形态跟随，缺省 false 零变化（旧调用方零触及）', () => {
    const re = buildReplaceRegex('getuser', { caseSensitive: false, wholeWord: false, useRegex: false })!
    expect(replaceMatches('getuser GETUSER Getuser', re, 'fetchUser')).toBe('fetchUser fetchUser fetchUser')
    expect(replaceMatches('getuser GETUSER Getuser', re, 'fetchUser', true)).toBe('fetchUser FETCHUSER FetchUser')
  })
})

describe('buildFilePreview preserveCase 预览联动（所见即所得）', () => {
  it('after 与执行链（replaceMatches preserveCase）逐行一致，命中片段携带形态化文本', () => {
    const re = buildReplaceRegex('getuser', { caseSensitive: false, wholeWord: false, useRegex: false })!
    const content = 'getuser GETUSER Getuser geTuser'
    const fp = buildFilePreview('a.ts', [{ line: 1, content }], re, 'fetchUser', true)
    expect(fp.rows[0]!.after).toBe('fetchUser FETCHUSER FetchUser fetchUser')
    expect(fp.rows[0]!.after).toBe(replaceMatches(content, re, 'fetchUser', true))
    expect(fp.rows[0]!.afterSegments.filter(s => s.isMatch).map(s => s.text))
      .toEqual(['fetchUser', 'FETCHUSER', 'FetchUser', 'fetchUser'])
  })
})

describe('buildFilePreview', () => {
  const reOf = (q: string) => buildReplaceRegex(q, { caseSensitive: true, wholeWord: false, useRegex: true })!
  it('逐命中行生成对照，同行去重，hitCount 保持处数口径，行号升序', () => {
    const fp = buildFilePreview('a.txt', [
      { line: 2, content: 'id-002 beta' },
      { line: 1, content: 'id-001 alpha' },
      { line: 2, content: 'id-002 beta' },
    ], reOf('id-\\d+'), 'ID')
    expect(fp.hitCount).toBe(3) // 处数口径（rg --vimgrep 每处一条）
    expect(fp.rows.map(r => r.line)).toEqual([1, 2])
    expect(fp.rows[0]!.after).toBe('ID alpha')
    expect(fp.rows[1]!.after).toBe('ID beta')
  })
  it('执行链一致性：各行 after 拼回等于全文替换结果（行命中粒度）', () => {
    const content = 'id-1 alpha\nplain\nid-2 beta\n'
    const matches = [
      { line: 1, content: 'id-1 alpha' },
      { line: 3, content: 'id-2 beta' },
    ]
    const re = reOf('id-\\d+')
    const fp = buildFilePreview('a.txt', matches, re, 'ID')
    const replaced = replaceMatches(content, re, 'ID').split('\n')
    for (const row of fp.rows) {
      expect(row.after).toBe(replaced[row.line - 1]) // after 与执行结果逐行一致
    }
  })
})
