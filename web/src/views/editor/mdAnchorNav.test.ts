// mdAnchorNav DOM 动作单测（P-20261007-7 md 预览页内锚点）
//
// 覆盖命中跳转（滚动 + 呼吸高亮）、#top 特例（有/无同名元素两形态）、
// 坏锚点 title 提示不炸、连点防高亮叠加。jsdom 无布局引擎：滚动断言走
// scrollTo stub 收到的实参，不做几何断言。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { jumpToMdAnchor } from './mdAnchorNav'

function buildPreview(html: string): { root: HTMLElement; scroller: HTMLElement } {
  const scroller = document.createElement('div')
  scroller.className = 'md-preview'
  const root = document.createElement('div')
  root.className = 'md-preview-content'
  root.innerHTML = html
  scroller.appendChild(root)
  document.body.appendChild(scroller)
  return { root, scroller }
}

const makeAnchor = (): HTMLAnchorElement => {
  const a = document.createElement('a')
  a.href = '#x'
  document.body.appendChild(a)
  return a
}

describe('jumpToMdAnchor', () => {
  let scroller: HTMLElement

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('命中：滚动（容器内平滑）+ 呼吸高亮，返回 true', () => {
    const built = buildPreview('<h2 id="第一节">第一节</h2><p>正文</p>')
    scroller = built.scroller
    scroller.scrollTo = vi.fn()
    const anchor = makeAnchor()

    expect(jumpToMdAnchor(built.root, '第一节', anchor, '未命中')).toBe(true)
    expect(scroller.scrollTo).toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth' }),
    )
    const h2 = built.root.querySelector('h2')!
    expect(h2.classList.contains('md-anchor-hit')).toBe(true)
    expect(anchor.title).toBe('')
  })

  it('高亮自愈：兜底定时器到点摘类（与 CSS 动画 1.6s 同步留余量）', () => {
    const built = buildPreview('<h2 id="a">A</h2>')
    built.scroller.scrollTo = vi.fn()

    jumpToMdAnchor(built.root, 'a', null, '未命中')
    expect(built.root.querySelector('h2')!.classList.contains('md-anchor-hit')).toBe(true)
    vi.advanceTimersByTime(1700)
    expect(built.root.querySelector('h2')!.classList.contains('md-anchor-hit')).toBe(false)
  })

  it('#top 无同名元素：回滚容器顶（浏览器原生片段语义同款）', () => {
    const built = buildPreview('<h2 id="第一节">第一节</h2>')
    scroller = built.scroller
    scroller.scrollTo = vi.fn()

    expect(jumpToMdAnchor(built.root, 'top', null, '未命中')).toBe(true)
    expect(scroller.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' })
  })

  it('#top 有 id="top" 元素：优先元素路径（滚动 + 高亮该元素）', () => {
    const built = buildPreview('<h2 id="top">Top</h2>')
    built.scroller.scrollTo = vi.fn()

    expect(jumpToMdAnchor(built.root, 'top', null, '未命中')).toBe(true)
    expect(built.root.querySelector('h2')!.classList.contains('md-anchor-hit')).toBe(true)
  })

  it('坏锚点：不炸不跳，title 提示锚点未命中，返回 false', () => {
    const built = buildPreview('<h2 id="第一节">第一节</h2>')
    built.scroller.scrollTo = vi.fn()
    const anchor = makeAnchor()

    expect(jumpToMdAnchor(built.root, 'no-such', anchor, '锚点「no-such」未命中')).toBe(false)
    expect(anchor.title).toBe('锚点「no-such」未命中')
    expect(built.scroller.scrollTo).not.toHaveBeenCalled()
    expect(built.root.querySelector('.md-anchor-hit')).toBeNull()
  })

  it('连点防叠加：新命中先摘上一枚高亮', () => {
    const built = buildPreview('<h2 id="a">A</h2><h2 id="b">B</h2>')
    built.scroller.scrollTo = vi.fn()

    jumpToMdAnchor(built.root, 'a', null, '未命中')
    const [ha, hb] = built.root.querySelectorAll('h2')
    expect(ha?.classList.contains('md-anchor-hit')).toBe(true)

    jumpToMdAnchor(built.root, 'b', null, '未命中')
    expect(ha?.classList.contains('md-anchor-hit')).toBe(false)
    expect(hb?.classList.contains('md-anchor-hit')).toBe(true)
  })

  it('显式 HTML 锚点（<a id="custom">）同样按 id 命中', () => {
    const built = buildPreview('<p>前言 <a id="custom"></a></p><h2 id="a">A</h2>')
    built.scroller.scrollTo = vi.fn()

    expect(jumpToMdAnchor(built.root, 'custom', null, '未命中')).toBe(true)
    expect(built.root.querySelector('a#custom')!.classList.contains('md-anchor-hit')).toBe(true)
  })
})
