import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// jsdom 无 canvas 2d / 图片解码：ctx 与 toDataURL 打桩走合成成功路径，
// Image 换成同步 onload 的假类，fetch 打桩返回最小 SVG 源
const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><circle cx="24" cy="24" r="8"/></svg>'
const FAKE_PNG = 'data:image/png;base64,FAKE'

class FakeImage {
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  width = 64
  height = 64
  private _src = ''
  set src(v: string) {
    this._src = v
    queueMicrotask(() => (FakeImage.failNext ? this.onerror?.() : this.onload?.()))
  }
  get src(): string {
    return this._src
  }
  static failNext = false
}

const ctxStubs = {
  drawImage: vi.fn(),
  beginPath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  fillText: vi.fn(),
}

let updateFaviconBadge: (count: number) => Promise<void>
let faviconBadgeLabel: (count: number) => string
let fetchMock: ReturnType<typeof vi.fn>

function addIconLink(href: string, type?: string): HTMLLinkElement {
  const link = document.createElement('link')
  link.rel = 'icon'
  link.setAttribute('href', href)
  if (type) link.setAttribute('type', type)
  document.head.appendChild(link)
  return link
}

function iconHrefs(): (string | null)[] {
  return Array.from(document.querySelectorAll('link[rel~="icon"]')).map((l) => l.getAttribute('href'))
}

describe('faviconBadge — favicon 待办角标（P-20261003-65）', () => {
  beforeEach(async () => {
    vi.resetModules() // 模块级恢复锚点/缓存按用例隔离
    const mod = await import('./faviconBadge')
    updateFaviconBadge = mod.updateFaviconBadge
    faviconBadgeLabel = mod.faviconBadgeLabel
    document.head.innerHTML = ''
    FakeImage.failNext = false

    fetchMock = vi.fn(async () => ({ ok: true, text: async () => SVG_SOURCE }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('Image', FakeImage)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctxStubs as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(FAKE_PNG)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('角标文案：>9 显 9+，其余原样', () => {
    expect(faviconBadgeLabel(1)).toBe('1')
    expect(faviconBadgeLabel(9)).toBe('9')
    expect(faviconBadgeLabel(10)).toBe('9+')
    expect(faviconBadgeLabel(128)).toBe('9+')
  })

  it('待办 >0：全部 icon link 换 PNG dataURL + 角标属性，type 校正', async () => {
    addIconLink('/favicon.svg', 'image/svg+xml')
    addIconLink('/favicon.ico')

    await updateFaviconBadge(1)

    for (const href of iconHrefs()) {
      expect(href).toBe(FAKE_PNG)
    }
    const primary = document.querySelector('link[rel~="icon"]')!
    expect(primary.getAttribute('data-favicon-badge')).toBe('1')
    expect(primary.getAttribute('type')).toBe('image/png')
    // SVG 源按首个 icon link 的 href 解析，只拉一次
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/favicon.svg'))
  })

  it('清零恢复原始 href/type 并摘除角标属性', async () => {
    addIconLink('/favicon.svg', 'image/svg+xml')
    addIconLink('/favicon.ico')

    await updateFaviconBadge(1)
    expect(iconHrefs()[0]).toBe(FAKE_PNG)
    await updateFaviconBadge(0)

    expect(iconHrefs()).toEqual(['/favicon.svg', '/favicon.ico'])
    const primary = document.querySelector('link[rel~="icon"]')!
    expect(primary.getAttribute('type')).toBe('image/svg+xml')
    expect(primary.hasAttribute('data-favicon-badge')).toBe(false)
  })

  it('启动即调 0（immediate watch）：未切换过则零写入', async () => {
    const link = addIconLink('/favicon.svg', 'image/svg+xml')
    await updateFaviconBadge(0)
    expect(link.getAttribute('href')).toBe('/favicon.svg')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('无 icon link（异常 DOM）：静默返回', async () => {
    await expect(updateFaviconBadge(1)).resolves.toBeUndefined()
  })

  it('SVG 源拉取失败：href 保持原图标', async () => {
    addIconLink('/favicon.svg', 'image/svg+xml')
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => '' })))

    await updateFaviconBadge(2)

    expect(iconHrefs()[0]).toBe('/favicon.svg')
    expect(document.querySelector('link[rel~="icon"]')!.hasAttribute('data-favicon-badge')).toBe(false)
  })

  it('SVG 解码失败（Image onerror）：href 保持原图标，恢复后重试成功', async () => {
    addIconLink('/favicon.svg', 'image/svg+xml')
    FakeImage.failNext = true

    await updateFaviconBadge(3)

    expect(iconHrefs()[0]).toBe('/favicon.svg')
    expect(document.querySelector('link[rel~="icon"]')!.hasAttribute('data-favicon-badge')).toBe(false)

    // 解码失败不进合成缓存；源文本已缓存（拉取成功与合成成败正交），
    // 恢复后同档位重试只重做合成不重拉
    FakeImage.failNext = false
    await updateFaviconBadge(3)
    expect(iconHrefs()[0]).toBe(FAKE_PNG)
    expect(document.querySelector('link[rel~="icon"]')!.getAttribute('data-favicon-badge')).toBe('3')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('同档位合成结果复用缓存，不重复拉源', async () => {
    addIconLink('/favicon.svg', 'image/svg+xml')
    await updateFaviconBadge(1)
    await updateFaviconBadge(0)
    await updateFaviconBadge(1)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(iconHrefs()[0]).toBe(FAKE_PNG)
  })
})
