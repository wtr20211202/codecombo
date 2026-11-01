// mdTableResize 单测（P-20261010-1 md 表格列宽拖拽）
//
// jsdom 无真实排版：getBoundingClientRect 恒 0（拖宽 = max(4em 下限, dx) 路径）、
// scrollWidth/clientWidth 恒 0（syncClipTitles 不落 title——行为即无截断全清）、
// matchMedia 需打桩。断言聚焦交互语义：fixed 切换/col 显式宽/双击恢复/守卫回落，
// 真实布局行为由 e2e（share-md-table-col-resize）在浏览器侧承接。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enhanceMdTables } from './mdTableResize'

type MqListener = (e: { matches: boolean }) => void

const TABLE_HTML = [
  '<div id="root"><table><thead><tr>',
  '<th>#</th><th>事项</th><th>说明</th><th>状态</th>',
  '</tr></thead><tbody><tr>',
  '<td>1</td><td>联调</td><td>很长的说明</td><td>待回复</td>',
  '</tr></tbody></table></div>',
].join('')

/** matchMedia 打桩：记录 addEventListener 注册的监听，用例内手动派发 */
let mqListeners: MqListener[] = []
function stubMatchMedia(matches: boolean): void {
  mqListeners = []
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches,
    addEventListener: (_: string, cb: MqListener) => { mqListeners.push(cb) },
    removeEventListener: () => {},
  })))
}

function root(): HTMLElement {
  return document.getElementById('root')!
}
function table(): HTMLTableElement {
  return root().querySelector('table')!
}
/** noUncheckedIndexedAccess 下按序取元素：缺失即抛（比 `!` 断言可审计） */
function nth(list: NodeListOf<Element>, i: number): Element {
  const el = list[i]
  if (!el) throw new Error(`element at ${i} missing (total ${list.length})`)
  return el
}
function handleAt(i: number): Element {
  return nth(root().querySelectorAll('.col-handle'), i)
}
function colAt(i: number): HTMLElement {
  return nth(table().querySelectorAll('colgroup col'), i) as HTMLElement
}
function handles(): NodeListOf<Element> {
  return root().querySelectorAll('.col-handle')
}
function cols(): NodeListOf<Element> {
  return table().querySelectorAll('colgroup col')
}
/** jsdom 无 PointerEvent：MouseEvent 携 clientX/button 派发同名事件
 *（pointerType 不落地 = undefined，走鼠标放行分支） */
function firePointer(el: Element, type: string, clientX: number): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX, button: 0 }))
}
/** 触屏形态事件：jsdom 的 MouseEventInit 不认 pointerType，手动挂上 */
function fireTouch(el: Element, type: string): void {
  const ev = new MouseEvent(type, { bubbles: true, clientX: 10, button: 0 })
  Object.defineProperty(ev, 'pointerType', { value: 'touch' })
  el.dispatchEvent(ev)
}

beforeEach(() => {
  document.body.innerHTML = TABLE_HTML
  stubMatchMedia(true)
})

describe('enhanceMdTables', () => {
  it('每个 th 挂一枚右缘手柄，重复调用幂等', () => {
    enhanceMdTables(root())
    expect(handles().length).toBe(4)
    enhanceMdTables(root())
    expect(handles().length).toBe(4)
  })

  it('拖动切 fixed 并写 col 显式宽：fixed 惰性到首个 move + 目标列随 dx 变化', () => {
    enhanceMdTables(root())
    const h = handleAt(2) // 「说明」列手柄
    firePointer(h, 'pointerdown', 100)
    // 纯按下不改布局（fixed 切换惰性到首个 move——双击「恢复」语义不被前置点击破坏）
    expect(table().classList.contains('sc-cols-fixed')).toBe(false)
    firePointer(h, 'pointermove', 130)
    expect(table().classList.contains('sc-cols-fixed')).toBe(true)
    expect(cols().length).toBe(4)
    // jsdom 实宽全 0 → col 全不写宽；拖动 +30 < 4em+26px 下限（jsdom 无排版
    // 样式，fontSize 空 → 回落 14px 基准，4*14+26=82）→ 钳在下限
    expect(colAt(2).style.width).toBe('82px')
    // 大幅拖宽生效
    firePointer(h, 'pointermove', 300)
    expect(colAt(2).style.width).toBe('200px')
    // 松手后不再跟随
    firePointer(h, 'pointerup', 300)
    firePointer(h, 'pointermove', 500)
    expect(colAt(2).style.width).toBe('200px')
  })

  it('未拖过的表纯双击手柄是 no-op（不切 fixed 不建 colgroup）', () => {
    enhanceMdTables(root())
    handleAt(1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(table().classList.contains('sc-cols-fixed')).toBe(false)
    expect(cols().length).toBe(0)
  })

  it('触屏 pointerType 拒绝拖拽（不切 fixed）', () => {
    enhanceMdTables(root())
    const h = handleAt(1)
    fireTouch(h, 'pointerdown')
    expect(table().classList.contains('sc-cols-fixed')).toBe(false)
    expect(cols().length).toBe(0)
  })

  it('窄屏（matchMedia 不命中）拒绝拖拽（不切 fixed）', () => {
    stubMatchMedia(false)
    enhanceMdTables(root())
    const h = handleAt(1)
    firePointer(h, 'pointerdown', 10)
    expect(table().classList.contains('sc-cols-fixed')).toBe(false)
  })

  it('双击手柄该列回自动；全部列回自动后整表回自动布局', () => {
    enhanceMdTables(root())
    const h2 = handleAt(2)
    firePointer(h2, 'pointerdown', 100)
    firePointer(h2, 'pointermove', 300)
    firePointer(h2, 'pointerup', 300)
    expect(table().classList.contains('sc-cols-fixed')).toBe(true)

    // 模拟另一列已被拖过：双击「说明」只清该列，表仍 fixed
    ;colAt(1).style.width = '90px'
    h2.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(colAt(2).style.width).toBe('')
    expect(table().classList.contains('sc-cols-fixed')).toBe(true)

    // 最后一枚显式宽清除 → colgroup 摘除、整表回自动
    handleAt(1).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    expect(table().querySelector('colgroup')).toBeNull()
    expect(table().classList.contains('sc-cols-fixed')).toBe(false)
  })

  it('宽屏拖出的 fixed 表在窗口变窄时整体回自动布局（matchMedia 单例回落）', async () => {
    // 模块单例监听只装一次：fresh import 保证本用例拿到自己的注册
    vi.resetModules()
    const mod = await import('./mdTableResize')
    mod.enhanceMdTables(root())
    const h = handleAt(0)
    firePointer(h, 'pointerdown', 100)
    firePointer(h, 'pointermove', 300)
    firePointer(h, 'pointerup', 300)
    expect(table().classList.contains('sc-cols-fixed')).toBe(true)

    expect(mqListeners.length).toBe(1)
    const narrow = mqListeners[0]
    if (!narrow) throw new Error('narrow fallback listener not registered')
    narrow({ matches: false })
    expect(table().classList.contains('sc-cols-fixed')).toBe(false)
    expect(table().querySelector('colgroup')).toBeNull()
    // 回宽屏不触发任何动作
    narrow({ matches: true })
    expect(table().classList.contains('sc-cols-fixed')).toBe(false)
  })
})
