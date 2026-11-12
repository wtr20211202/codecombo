import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderChangelog, changelogBrief, onChangelogClick } from './changelogRender'

// 发布说明渲染链单源（P-20261112-2-S1）：dsh 版本弹层与自更新面板「更新内容」
// 共用。内容是外部输入（GitHub Release body）——本文件钉住净化策略（XSS 面）、
// 锚点契约（heading id ↔ 点击拦截）与摘要口径；放宽允许面必须先改这里。

/** 渲染产物挂进游离容器，按 DOM 断言（不对序列化字符串做脆弱匹配） */
function dom(body: string): HTMLElement {
  const div = document.createElement('div')
  div.innerHTML = renderChangelog(body)
  return div
}

describe('renderChangelog 净化策略（外部内容 XSS 面）', () => {
  it('markdown 渲染为结构化 html：标题/加粗/列表不再裸露标记', () => {
    const root = dom('### Added\n\n- **粗体** 条目\n- 第二条')
    expect(root.querySelector('h3')?.textContent).toBe('Added')
    expect(root.querySelector('strong')?.textContent).toBe('粗体')
    expect(root.querySelectorAll('li')).toHaveLength(2)
    expect(root.textContent).not.toContain('###')
    expect(root.textContent).not.toContain('**')
  })

  it('script / iframe / object / embed 等可执行与嵌入标签整体剥除', () => {
    const root = dom([
      'ok',
      '<script>window.__xss = 1</script>',
      '<iframe src="https://example.com/"></iframe>',
      '<object data="https://example.com/x"></object>',
      '<embed src="https://example.com/x">',
    ].join('\n\n'))
    for (const tag of ['script', 'iframe', 'object', 'embed']) {
      expect(root.querySelector(tag), tag).toBeNull()
    }
    expect(root.innerHTML).not.toContain('__xss')
  })

  it('style / form 剥除（DOMPurify 默认放行，本链显式收紧）：样式表不外溢全局、无脚本表单提交面', () => {
    const root = dom([
      'ok',
      '<style>body{display:none}</style>',
      '<form action="https://example.com/"><button type="submit">立即更新</button><input name="a"></form>',
    ].join('\n\n'))
    expect(root.querySelector('style')).toBeNull()
    expect(root.innerHTML).not.toContain('display:none')
    expect(root.querySelector('form')).toBeNull()
    // 表单壳剥除后内层控件即便留存也无提交面（无 form 归属、无 action）
    expect(root.querySelector('[action]')).toBeNull()
    expect(root.innerHTML).not.toContain('example.com')
  })

  it('事件处理器属性一律剥除（img onerror / 任意元素 onclick / svg onload）', () => {
    const root = dom([
      '<img src="x" onerror="window.__xss = 1">',
      '<a href="https://example.com/" onclick="window.__xss = 1">link</a>',
      '<svg onload="window.__xss = 1"><circle r="1"/></svg>',
      '<div onmouseover="window.__xss = 1">hover</div>',
    ].join('\n\n'))
    for (const el of Array.from(root.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.name.startsWith('on'), `${el.tagName}[${attr.name}]`).toBe(false)
      }
    }
    expect(root.innerHTML).not.toContain('__xss')
  })

  it('javascript: / data:text/html 等危险协议的 href 不存活（markdown 链接与裸 html 两条入口）', () => {
    const root = dom([
      '[md](javascript:alert(1))',
      '<a href="javascript:alert(1)">raw</a>',
      '<a href="JaVaScRiPt:alert(1)">case</a>',
      '<a href="data:text/html,<script>alert(1)</script>">data</a>',
    ].join('\n\n'))
    for (const a of Array.from(root.querySelectorAll('a'))) {
      const href = (a.getAttribute('href') || '').trim().toLowerCase()
      expect(href.startsWith('javascript:'), href).toBe(false)
      expect(href.startsWith('data:'), href).toBe(false)
    }
  })

  it('允许面：http(s) 外链与 a[target] 保留（ADD_ATTR 仅此一项）', () => {
    const root = dom('<a href="https://example.com/release" target="_blank">page</a>')
    const a = root.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://example.com/release')
    expect(a.getAttribute('target')).toBe('_blank')
  })

  it('空 / 空白正文不炸，产物为空', () => {
    expect(renderChangelog('')).toBe('')
    expect(dom('   \n ').textContent?.trim()).toBe('')
  })
})

describe('renderChangelog 锚点契约（heading id）', () => {
  it('标题挂 slug id（中文保留、英文小写），与发布说明锚点行 href 对得上', () => {
    const root = dom('[中文](#中文) | [English](#english)\n\n## 中文\n\n内容\n\n## English\n\nbody')
    expect(root.querySelector('h2[id="中文"]')).not.toBeNull()
    expect(root.querySelector('h2[id="english"]')).not.toBeNull()
    // 锚点行渲染为页内链接（非 ASCII 被 marked percent 编码，点击侧负责解码）
    const hrefs = Array.from(root.querySelectorAll('a')).map(a => a.getAttribute('href'))
    expect(hrefs).toEqual(['#%E4%B8%AD%E6%96%87', '#english'])
  })

  it('纯标点标题无 slug：不挂 id，回落默认渲染不炸', () => {
    const h = dom('## !!!').querySelector('h2')!
    expect(h.textContent).toBe('!!!')
    expect(h.hasAttribute('id')).toBe(false)
  })

  it('无锚点行的正文自然降级：零页内链接', () => {
    const root = dom('## Added\n\n- item')
    expect(root.querySelectorAll('a[href^="#"]')).toHaveLength(0)
  })
})

describe('changelogBrief 收起态摘要', () => {
  it('剥净 markdown 标记并压成单行', () => {
    expect(changelogBrief('### Added\n\n- **粗体** 条目\n- 第二条')).toBe('Added 粗体 条目 第二条')
  })

  it('超 150 字截断并带省略号；空白正文为空串', () => {
    const brief = changelogBrief('字'.repeat(400))
    expect(brief).toHaveLength(151)
    expect(brief.endsWith('…')).toBe(true)
    expect(changelogBrief('  \n ')).toBe('')
  })

  it('摘要是纯文本：正文里的 html 不以标记形态进入摘要', () => {
    const brief = changelogBrief('<img src="x" onerror="window.__xss = 1"> hello <b>world</b>')
    expect(brief).toBe('hello world')
  })
})

describe('onChangelogClick 页内锚点拦截', () => {
  let container: HTMLElement
  const scrollSpy = vi.fn()

  beforeEach(() => {
    scrollSpy.mockReset()
    // jsdom 无布局无 scrollIntoView 实现
    Element.prototype.scrollIntoView = scrollSpy
    container = document.createElement('div')
    container.innerHTML = renderChangelog(
      '[中文](#中文) | [English](#english) | [bad](#no-such) | [quote](#a"]b) | [ext](https://example.com/)\n\n## 中文\n\n内容\n\n## English\n\nbody',
    )
    container.addEventListener('click', onChangelogClick as EventListener)
    document.body.appendChild(container)
  })

  function click(el: Element): MouseEvent {
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    el.dispatchEvent(ev)
    return ev
  }
  const link = (text: string) => Array.from(container.querySelectorAll('a')).find(a => a.textContent === text)!

  it('命中：阻止默认（hash 不进地址栏）并滚到目标小节', () => {
    const ev = click(link('English'))
    expect(ev.defaultPrevented).toBe(true)
    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy.mock.instances[0]).toBe(container.querySelector('[id="english"]'))
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('percent 编码的中文锚点解码后命中', () => {
    const ev = click(link('中文'))
    expect(ev.defaultPrevented).toBe(true)
    expect(scrollSpy.mock.instances[0]).toBe(container.querySelector('[id="中文"]'))
  })

  it('坏锚点 / 含引号的 fragment：阻止默认、不滚、不抛', () => {
    for (const text of ['bad', 'quote']) {
      const ev = click(link(text))
      expect(ev.defaultPrevented, text).toBe(true)
    }
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('坏 percent 编码的 fragment 原样回落为坏锚点，不抛', () => {
    const a = document.createElement('a')
    a.setAttribute('href', '#%E4%ZZ')
    a.textContent = 'broken'
    container.appendChild(a)
    expect(click(a).defaultPrevented).toBe(true)
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('外链与非链接区域不接管', () => {
    expect(click(link('ext')).defaultPrevented).toBe(false)
    expect(click(container.querySelector('p:last-child')!).defaultPrevented).toBe(false)
    expect(scrollSpy).not.toHaveBeenCalled()
  })
})
