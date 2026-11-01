import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, computed, nextTick } from 'vue'
import { useSettingsSearch } from '@/composables/useSettingsSearch'
import { SETTINGS_TAB_KEYS } from '@/utils/settingsSearch'

/**
 * 设置搜索/深链行级锚定单测（useSettingsSearch）：run24 实测两条定位缺陷的
 * 回归面——① 弹窗内容尚未完成布局（display:none / 零高）时以零矩形「定位」
 * 会把滚动写丢且闪烁空转（palette-project-rules）；② 异步内容（设置项/规则
 * 清单）晚于锚点落地会撑高上方区域，把目标行挤出可视区，位置一次性算死不够
 * （settings-search-anchor:130）。
 * jsdom 无布局：矩形与 scrollTop 全部按用例注入（锚定逻辑只消费这两个量）。
 */

vi.mock('vue-i18n', async (importOriginal) =>
  (await import('@/__tests__/mocks/naiveRuntime')).mockVueI18n(await importOriginal()))

function fakeRect(top: number, height: number): DOMRect {
  return {
    top, bottom: top + height, height, left: 0, right: 500, width: 500, x: 0, y: top,
    toJSON: () => ({}),
  } as DOMRect
}

interface Fixture {
  content: HTMLElement
  row: HTMLElement
  setContentHeight: (h: number, top?: number) => void
  setRowTop: (top: number) => void
  scrollTop: () => number
}

function makeFixture(): Fixture {
  const content = document.createElement('div')
  const pane = document.createElement('div')
  pane.setAttribute('data-testid', 'settings-pane-general')
  const row = document.createElement('div')
  row.setAttribute('data-testid', 'settings-row')
  pane.appendChild(row)
  content.appendChild(pane)
  document.body.appendChild(content)

  let contentHeight = 300
  let contentTop = 100
  let baseTop = 900
  let scrollTopValue = 0
  content.getBoundingClientRect = () => fakeRect(contentTop, contentHeight)
  // 行矩形按「文档位 - 容器滚动量」求值（浏览器里滚动会移动行）
  row.getBoundingClientRect = () => fakeRect(baseTop - scrollTopValue, 40)
  Object.defineProperty(content, 'scrollTop', {
    configurable: true,
    get: () => scrollTopValue,
    set: (v: number) => { scrollTopValue = Math.max(0, v) },
  })
  return {
    content,
    row,
    setContentHeight: (h, top = 100) => { contentHeight = h; contentTop = top },
    setRowTop: (top) => { baseTop = top },
    scrollTop: () => scrollTopValue,
  }
}

function setup(fx: Fixture) {
  const contentRef = ref<HTMLElement | undefined>(fx.content)
  const activeTab = ref<'general'>('general')
  const tabs = computed(() => SETTINGS_TAB_KEYS.map(key => ({ key, label: key, icon: null })))
  const api = useSettingsSearch({
    tabs: tabs as never,
    activeTab: activeTab as never,
    contentRef,
  })
  return { ...api, contentRef }
}

describe('useSettingsSearch 行级锚定', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => {
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  it('内容容器未完成布局（零高）时不在隐藏态空转，挂载完成后再定位+闪烁', async () => {
    const fx = makeFixture()
    fx.setContentHeight(0)
    const api = setup(fx)
    api.revealAnchor('general', 'settings-row')
    await nextTick()
    vi.advanceTimersByTime(400)
    expect(fx.row.className).not.toContain('anchor-flash')
    expect(fx.scrollTop()).toBe(0)

    // 弹窗可见（有高度）→ 短轮询下一跳定位 + 闪烁
    fx.setContentHeight(300)
    vi.advanceTimersByTime(100)
    await nextTick()
    expect(fx.row.className).toContain('anchor-flash')
    expect(fx.scrollTop()).toBeGreaterThan(0)
    // 目标居中：900-100-(300-40)/2 = 670
    expect(fx.scrollTop()).toBe(670)
  })

  it('异步内容撑高上方区域后跟随纠偏，把目标行拉回可视区', async () => {
    const fx = makeFixture()
    const api = setup(fx)
    api.revealAnchor('general', 'settings-row')
    await nextTick()
    vi.advanceTimersByTime(20)
    expect(fx.row.className).toContain('anchor-flash')
    expect(fx.scrollTop()).toBe(670)

    // 上方内容加载（目标下移到可视框外）→ 下一帧跟随把底边对齐到可视框
    fx.setRowTop(1600)
    vi.advanceTimersByTime(40)
    expect(fx.scrollTop()).toBe(670 + (1600 - 670 + 40 - 400))
  })

  it('闪烁到期摘类并停止跟随', async () => {
    const fx = makeFixture()
    const api = setup(fx)
    api.revealAnchor('general', 'settings-row')
    await nextTick()
    vi.advanceTimersByTime(20)
    expect(fx.row.className).toContain('anchor-flash')

    vi.advanceTimersByTime(2000)
    expect(fx.row.className).not.toContain('anchor-flash')

    // 到期后布局再变也不再纠偏
    const settled = fx.scrollTop()
    fx.setRowTop(3000)
    vi.advanceTimersByTime(200)
    expect(fx.scrollTop()).toBe(settled)
  })
})
