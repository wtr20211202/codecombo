// mdRender 单测（P-20261119-4 必改2a）：全应用 md 渲染单一管线——
// marked（GFM/breaks/标题锚点）+ DOMPurify（ADD target/input）。编辑器侧栏
// 实时预览与统一预览视图共用本函数，so 断言面钉「渲染配置」而非实现细节：
// 标题锚点 id（页内跳转契约）、任务列表 input、外链 target、脚本净化。
import { describe, expect, it } from 'vitest'
import { renderMdPreviewHtml } from './mdRender'

describe('renderMdPreviewHtml', () => {
  it('空输入返回空串（不产生空壳）', () => {
    expect(renderMdPreviewHtml('')).toBe('')
  })

  it('基础渲染：标题带锚点 id、段落、代码块', () => {
    const html = renderMdPreviewHtml('# Quick Start\n\n正文 `code`\n')
    expect(html).toContain('<h1 id="quick-start">Quick Start</h1>')
    expect(html).toContain('<p>正文 <code>code</code></p>')
  })

  it('GFM：表格与任务列表 input 放行', () => {
    const html = renderMdPreviewHtml('| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n')
    expect(html).toContain('<table>')
    expect(html).toContain('<th>a</th>')
    expect(html).toContain('type="checkbox"')
  })

  it('breaks=true：单换行成 <br>', () => {
    expect(renderMdPreviewHtml('a\nb')).toContain('<br>')
  })

  it('净化：脚本/事件属性被 DOMPurify 剥掉，target 属性放行', () => {
    const dirty = '<script>alert(1)</script>\n\n<img src=x onerror="alert(2)">\n\n<a href="https://example.com" target="_blank">外链</a>'
    const html = renderMdPreviewHtml(dirty)
    expect(html).not.toContain('<script')
    expect(html).not.toContain('onerror')
    expect(html).toContain('href="https://example.com"')
    // ADD_ATTR ['target']：落盘的 target 是惰性的（左键点击被预览容器接管）
    expect(html).toContain('target="_blank"')
  })
})
