// mdPreviewLinks 纯解析单测（P-20261003-108 md 预览链接导航）
//
// 覆盖相对 / 根相对折叠、./ ../ 导航段、锚点与查询剥离、协议排除、
// 越根防穿越与非 md 扩展名拒绝——点击委托层只信本函数的产出。
import { describe, expect, it } from 'vitest'
import { isMdPath, resolveMdAnchorTarget, resolveMdLinkTarget } from './mdPreviewLinks'

describe('resolveMdLinkTarget', () => {
  it('同级相对链接按当前文件目录折叠', () => {
    expect(resolveMdLinkTarget('README.md', './docs/guide.md')).toBe('docs/guide.md')
    expect(resolveMdLinkTarget('README.md', 'docs/guide.md')).toBe('docs/guide.md')
    expect(resolveMdLinkTarget('docs/setup.md', './install.md')).toBe('docs/install.md')
  })

  it('../ 逐级上跳', () => {
    expect(resolveMdLinkTarget('docs/guide/intro.md', '../setup.md')).toBe('docs/setup.md')
    expect(resolveMdLinkTarget('docs/intro.md', '../README.md')).toBe('README.md')
    expect(resolveMdLinkTarget('docs/a/b.md', '../../top.md')).toBe('top.md')
  })

  it('根相对链接以项目根为基', () => {
    expect(resolveMdLinkTarget('docs/deep/nested.md', '/CHANGELOG.md')).toBe('CHANGELOG.md')
  })

  it('尾部 #fragment / ?query 剥离后再折叠', () => {
    expect(resolveMdLinkTarget('README.md', './docs/guide.md#安装')).toBe('docs/guide.md')
    expect(resolveMdLinkTarget('README.md', 'docs/x.md?a=b')).toBe('docs/x.md')
  })

  it('percent 编码解码后折叠（marked 对空格的编码产物）', () => {
    expect(resolveMdLinkTarget('README.md', './my%20doc.md')).toBe('my doc.md')
  })

  it('纯页内锚点与空 href 保持死链（锚点走 resolveMdAnchorTarget 分流）', () => {
    expect(resolveMdLinkTarget('README.md', '#section')).toBeNull()
    expect(resolveMdLinkTarget('README.md', '')).toBeNull()
    expect(resolveMdLinkTarget('README.md', '   ')).toBeNull()
  })

  it('协议形态一律不折叠（外链分流 / mailto 忽略）', () => {
    expect(resolveMdLinkTarget('README.md', 'https://example.com/a.md')).toBeNull()
    expect(resolveMdLinkTarget('README.md', 'http://example.com')).toBeNull()
    expect(resolveMdLinkTarget('README.md', 'mailto:a@b.c')).toBeNull()
  })

  it('.. 越过项目根（防穿越）与非 md 扩展名拒绝', () => {
    expect(resolveMdLinkTarget('README.md', '../../outside.md')).toBeNull()
    expect(resolveMdLinkTarget('README.md', './img.png')).toBeNull()
    expect(resolveMdLinkTarget('README.md', './src/main.go')).toBeNull()
    expect(resolveMdLinkTarget('README.md', './docs')).toBeNull()
  })

  it('Windows 风格反斜杠 href 归一为正斜杠', () => {
    expect(resolveMdLinkTarget('README.md', '.\\docs\\guide.md')).toBe('docs/guide.md')
  })

  it('markdown 扩展名同口径（与 isMarkdown 一致）', () => {
    expect(resolveMdLinkTarget('README.md', './notes.markdown')).toBe('notes.markdown')
  })
})

describe('resolveMdAnchorTarget', () => {
  it('#fragment 折叠为 fragment，前后空白容忍', () => {
    expect(resolveMdAnchorTarget('#sec')).toBe('sec')
    expect(resolveMdAnchorTarget('  #top  ')).toBe('top')
  })

  it('中文锚点 percent 解码（marked 对 href 的 encodeURI 产物）', () => {
    expect(resolveMdAnchorTarget('#第一节')).toBe('第一节')
    expect(resolveMdAnchorTarget('#%E7%AC%AC%E4%B8%80%E8%8A%82')).toBe('第一节')
    expect(resolveMdAnchorTarget('#my%20head')).toBe('my head')
  })

  it('畸形 percent 编码按原文匹配（与 resolveMdLinkTarget 同一容忍口径）', () => {
    expect(resolveMdAnchorTarget('#%')).toBe('%')
    expect(resolveMdAnchorTarget('#a%2zb')).toBe('a%2zb')
  })

  it('非锚点与空 fragment 返回 null（调用方分流到其余导航）', () => {
    expect(resolveMdAnchorTarget('')).toBeNull()
    expect(resolveMdAnchorTarget('#')).toBeNull()
    expect(resolveMdAnchorTarget('   ')).toBeNull()
    expect(resolveMdAnchorTarget('docs/x.md#节')).toBeNull()
    expect(resolveMdAnchorTarget('https://example.com/#top')).toBeNull()
  })
})

describe('isMdPath', () => {
  it('md / markdown 真，其余假，大小写不敏感', () => {
    expect(isMdPath('a.md')).toBe(true)
    expect(isMdPath('a.markdown')).toBe(true)
    expect(isMdPath('A.MD')).toBe(true)
    expect(isMdPath('a.txt')).toBe(false)
    expect(isMdPath('a.mdx')).toBe(false)
  })
})
