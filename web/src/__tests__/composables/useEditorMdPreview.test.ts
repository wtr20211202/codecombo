// useEditorMdPreview composable 单测（P-20261007-7 页内锚点二阶段）
//
// 覆盖两段新链路：
// ① 渲染侧——heading renderer hook 经 marked 全局实例产出 GitHub 风格 slug id
//    （中文保留 / 行内标记剥除 / 重名 -1 去重），id 穿过 DOMPurify 消毒链存活；
// ② 点击侧——预览容器委托里 #anchor 分流：命中滚动 + 高亮、坏锚点 title 提示
//    （不炸）、相对 .md 链接仍走 OPS_OPEN_FILE_AT 既有打开链（P-108 语义不回退）。
// 渲染走 150ms 防抖尾沿，用真实定时器短等；滚动断言与 mdAnchorNav.test.ts 同款
// scrollTo stub（jsdom 无布局引擎）。
import { describe, expect, it, vi } from 'vitest'
import type { useI18n } from 'vue-i18n'
import { OPS_OPEN_FILE_AT, type OpenFileAtDetail } from '@/utils/opsEvents'
import { useEditorMdPreview } from '@/composables/useEditorMdPreview'

const t = vi.fn((key: string, named?: Record<string, unknown>) =>
  named ? `${key}:${JSON.stringify(named)}` : key,
)

function buildComposable(md: string) {
  return useEditorMdPreview({
    getPath: () => 'README.md',
    getModelValue: () => md,
    canNavigate: () => true,
    getProjectId: () => 'p1',
    t: t as unknown as ReturnType<typeof useI18n>['t'],
  })
}

const waitDebounce = () => new Promise((r) => setTimeout(r, 250))

function buildPreviewDom(html: string): { scroller: HTMLElement; root: HTMLElement } {
  const scroller = document.createElement('div')
  scroller.className = 'md-preview'
  const root = document.createElement('div')
  root.className = 'md-preview-content'
  root.innerHTML = html
  scroller.appendChild(root)
  document.body.appendChild(scroller)
  return { scroller, root }
}

function clickAnchor(c: ReturnType<typeof buildComposable>, anchor: HTMLAnchorElement): MouseEvent {
  // 真组件由 EditorMdPreviewPane 容器 @click 绑定 handlePreviewClick（上抛）；
  // 测试桩无绑定监听，dispatch 后直调委托函数（事件 target 已落在 anchor 上）
  const e = new MouseEvent('click', { bubbles: true, cancelable: true })
  anchor.dispatchEvent(e)
  c.handlePreviewClick(e)
  return e
}

describe('useEditorMdPreview heading id 渲染', () => {
  it('heading 挂 GitHub 风格 slug id，穿过 DOMPurify 存活', async () => {
    const c = buildComposable('## 第一节\n\n## Hello **World**\n')
    await waitDebounce()
    expect(c.renderedHtml.value).toContain('<h2 id="第一节">第一节</h2>')
    expect(c.renderedHtml.value).toContain('<h2 id="hello-world">Hello <strong>World</strong></h2>')
  })

  it('重名标题 -1 去重；两次独立 parse 各自计数（preprocess 复位）', async () => {
    const c = buildComposable('## Top\n\n## Top\n')
    await waitDebounce()
    expect(c.renderedHtml.value).toContain('<h2 id="top">Top</h2>')
    expect(c.renderedHtml.value).toContain('<h2 id="top-1">Top</h2>')

    const c2 = buildComposable('## Top\n')
    await waitDebounce()
    expect(c2.renderedHtml.value).toContain('<h2 id="top">Top</h2>')
  })

  it('纯标点标题不挂 id（slug 空回落默认 renderer）', async () => {
    const c = buildComposable('## !!!\n')
    await waitDebounce()
    expect(c.renderedHtml.value).toContain('<h2>!!!</h2>')
  })
})

describe('useEditorMdPreview handlePreviewClick 锚点分流', () => {
  it('#anchor 命中：滚动 + 呼吸高亮 + preventDefault（URL 不挂 #）', () => {
    const c = buildComposable('')
    const { scroller, root } = buildPreviewDom('<h2 id="第一节">第一节</h2><a href="#%E7%AC%AC%E4%B8%80%E8%8A%82">go</a>')
    scroller.scrollTo = vi.fn()
    const anchor = root.querySelector('a')!

    const e = clickAnchor(c, anchor)
    expect(e.defaultPrevented).toBe(true)
    expect(scroller.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'smooth' }))
    expect(root.querySelector('h2')!.classList.contains('md-anchor-hit')).toBe(true)
  })

  it('坏锚点：preventDefault 不炸不跳，title 提示携锚点名', () => {
    const c = buildComposable('')
    const { root } = buildPreviewDom('<h2 id="第一节">第一节</h2><a href="#no-such">bad</a>')
    const anchor = root.querySelector('a')!

    const e = clickAnchor(c, anchor)
    expect(e.defaultPrevented).toBe(true)
    expect(anchor.title).toBe('editor.mdAnchorMiss:{"anchor":"no-such"}')
    expect(root.querySelector('.md-anchor-hit')).toBeNull()
  })

  it('相对 .md 链接仍派发 OPS_OPEN_FILE_AT（P-108 语义不回退）', () => {
    const c = buildComposable('')
    const { root } = buildPreviewDom('<a href="./docs/guide.md">guide</a>')
    const seen: OpenFileAtDetail[] = []
    const listener = (e: Event) => seen.push((e as CustomEvent<OpenFileAtDetail>).detail)
    window.addEventListener(OPS_OPEN_FILE_AT, listener)

    clickAnchor(c, root.querySelector('a')!)
    window.removeEventListener(OPS_OPEN_FILE_AT, listener)
    expect(seen).toEqual([{ path: 'docs/guide.md', projectId: 'p1' }])
  })
})
