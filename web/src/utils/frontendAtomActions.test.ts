import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// clipApi（中继槽回落链）与 copyText（直写）都是模块边界：mock 隔离网络与
// 剪贴板真实面，断言回落链的分岔逻辑
const { clipSendMock, copyTextMock } = vi.hoisted(() => ({
  clipSendMock: vi.fn(async () => ({})),
  copyTextMock: vi.fn(async (): Promise<boolean> => true),
}))
vi.mock('@/api/domains/system', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  clipApi: { send: clipSendMock, take: vi.fn(async () => ({ content: '' })) },
}))
vi.mock('@/utils/clipboard', () => ({ copyText: copyTextMock }))
import {
  handleFrontendDownload, handleFrontendClipboard, handleFrontendOpen, handleFrontendReload,
  isProjectRelativePath, isHTTPExternalURL, resetFrontendAtomStateForTest,
} from './frontendAtomActions'
import { useOpsAtomPrefs } from '../stores/opsAtomPrefs'
import { useNotificationStore } from '../stores/notification'
import { useViewReloadTick } from '../composables/useViewReload'

/**
 * frontend 动词族原子前端消费链单测（P-20261023-4 首批 + P-20261111-3 重载）：
 * 载荷复验守卫 / 设置开关门控（关档 + 每窗口一条提示）/ 效应面限频（10 次/
 * 分钟/原子，超限可见 warning）/ 下载 anchor 组装 / 剪贴板直写与中继回落 /
 * 开标签与 popup 拦截回落 / 整页·视图重载分档。模块级预算经 reset 钩子在
 * 用例间隔离；pinia 与 localStorage 由全局 setup 每用例重建
 */

type FakeMessage = {
  success: ReturnType<typeof vi.fn>
  warning: ReturnType<typeof vi.fn>
  info: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
}

function fakeMessage(): FakeMessage {
  return { success: vi.fn(), warning: vi.fn(), info: vi.fn(), error: vi.fn() }
}

/** 取 handler 弹出的 toast testid（渲染函数形态的 message 调用无法直接断言
 *  文本，约定 toast 内容恒为 () => h('span', {'data-testid': …}) 渲染器） */
function toastIds(fn: ReturnType<typeof vi.fn>): string[] {
  return fn.mock.calls.map((call) => {
    const arg = call[0] as unknown
    if (typeof arg === 'function') {
      const vnode = (arg as () => { props?: Record<string, unknown> })()
      return String(vnode?.props?.['data-testid'] ?? '')
    }
    return ''
  })
}

/** 取渲染器 toast 的文本内容（h('span', props, text) 的 children 即文本串） */
function toastText(fn: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const call = fn.mock.calls[callIndex]
  if (!call) return ''
  const arg = call[0] as unknown
  if (typeof arg === 'function') {
    const vnode = (arg as () => { children?: unknown })()
    return String(vnode?.children ?? '')
  }
  return String(arg ?? '')
}

afterEach(() => {
  // 原型 spy（anchor click）不还原会跨用例叠加计数——上一用例的点击泄入
  // 本用例断言（限频用例曾数出 11 次）；统一还原
  vi.restoreAllMocks()
})

describe('载荷复验守卫（服务端已校验，此处防其它来源）', () => {
  it('isProjectRelativePath：正斜杠相对路径合法，绝对/盘符/反斜杠/.. 段拒绝', () => {
    expect(isProjectRelativePath('src/app.ts')).toBe(true)
    expect(isProjectRelativePath('a.md')).toBe(true)
    expect(isProjectRelativePath('/abs/a.md')).toBe(false)
    expect(isProjectRelativePath('C:/tmp/a.md')).toBe(false)
    expect(isProjectRelativePath('a\\b.md')).toBe(false)
    expect(isProjectRelativePath('../escape')).toBe(false)
    expect(isProjectRelativePath('a/../b')).toBe(false)
    expect(isProjectRelativePath('')).toBe(false)
  })

  it('isHTTPExternalURL：http(s) 绝对外链合法，伪协议/相对路径/协议相对/空白拒绝', () => {
    expect(isHTTPExternalURL('https://ci.example.com/run/1')).toBe(true)
    expect(isHTTPExternalURL('http://127.0.0.1:9999/monitor')).toBe(true)
    expect(isHTTPExternalURL('javascript:alert(1)')).toBe(false)
    expect(isHTTPExternalURL('data:text/html,bomb')).toBe(false)
    expect(isHTTPExternalURL('/project?file=a.ts')).toBe(false)
    expect(isHTTPExternalURL('//evil.com/x')).toBe(false)
    expect(isHTTPExternalURL('https://a.com/x y')).toBe(false)
    expect(isHTTPExternalURL('')).toBe(false)
  })
})

describe('handleFrontendDownload', () => {
  let clickSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetFrontendAtomStateForTest()
    copyTextMock.mockClear()
    clipSendMock.mockClear()
    clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  it('合法载荷 → 组装隐藏 anchor 指向下载端点并点击（成功 toast 可见）', () => {
    const msg = fakeMessage()
    expect(handleFrontendDownload({ path: 'reports/a.md', projectId: 'p1' }, msg as never)).toBe(true)
    expect(clickSpy).toHaveBeenCalledTimes(1)
    const anchor = clickSpy.mock.contexts[0] as HTMLAnchorElement
    expect(anchor.getAttribute('href')).toBe('/api/projects/p1/file/download?path=reports%2Fa.md')
    expect(anchor.getAttribute('download')).toBe('a.md')
    expect(toastIds(msg.success)).toContain('ops-atom-download-toast')
  })

  it('非法载荷静默忽略（不点击不提示）', () => {
    const msg = fakeMessage()
    expect(handleFrontendDownload({ path: '../escape', projectId: 'p1' }, msg as never)).toBe(false)
    // 缺 projectId 的残形载荷（直通分发面可伪造任意 detail，复验守卫拒绝）
    expect(handleFrontendDownload({ path: 'a.md' } as unknown as Parameters<typeof handleFrontendDownload>[0], msg as never)).toBe(false)
    expect(clickSpy).not.toHaveBeenCalled()
    expect(msg.warning).not.toHaveBeenCalled()
  })

  it('设置开关关闭 → 效应不发生 + 每窗口至多一条「已关闭」提示', () => {
    useOpsAtomPrefs().set('download', false)
    const msg = fakeMessage()
    expect(handleFrontendDownload({ path: 'a.md', projectId: 'p1' }, msg as never)).toBe(false)
    expect(handleFrontendDownload({ path: 'a.md', projectId: 'p1' }, msg as never)).toBe(false)
    expect(clickSpy).not.toHaveBeenCalled()
    expect(toastIds(msg.info).filter((id) => id === 'ops-atom-disabled-toast')).toHaveLength(1)
  })

  it('效应面限频 10 次/分钟：第 11 次不点击且弹可见 warning', () => {
    const msg = fakeMessage()
    for (let i = 0; i < 10; i++) {
      expect(handleFrontendDownload({ path: `f${i}.md`, projectId: 'p1' }, msg as never)).toBe(true)
    }
    expect(clickSpy).toHaveBeenCalledTimes(10)
    expect(handleFrontendDownload({ path: 'f11.md', projectId: 'p1' }, msg as never)).toBe(false)
    expect(clickSpy).toHaveBeenCalledTimes(10)
    expect(toastIds(msg.warning)).toContain('ops-atom-rate-limited-toast')
  })

  it('限频按原子独立：download 触顶不影响 clipboard 预算', async () => {
    const msg = fakeMessage()
    for (let i = 0; i < 10; i++) {
      handleFrontendDownload({ path: `f${i}.md`, projectId: 'p1' }, msg as never)
    }
    await expect(handleFrontendClipboard({ text: 'hello' }, msg as never)).resolves.toBe(true)
    expect(copyTextMock).toHaveBeenCalledWith('hello')
  })
})

describe('handleFrontendClipboard', () => {
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetFrontendAtomStateForTest()
    copyTextMock.mockClear()
    copyTextMock.mockResolvedValue(true)
    clipSendMock.mockClear()
    clipSendMock.mockResolvedValue({})
    addSpy = vi.spyOn(useNotificationStore(), 'add')
  })

  it('直写成功 → 成功 toast 带遮蔽截断预览（无静默写入）', async () => {
    const msg = fakeMessage()
    await expect(handleFrontendClipboard({ text: 'git push origin main' }, msg as never)).resolves.toBe(true)
    expect(copyTextMock).toHaveBeenCalledWith('git push origin main')
    expect(toastIds(msg.success)).toContain('ops-atom-clipboard-toast')
  })

  it('预览遮蔽敏感值并截断到 64 rune 加省略号', async () => {
    const msg = fakeMessage()
    const long = 'token=sk-abcd1234 ' + 'x'.repeat(200)
    await handleFrontendClipboard({ text: long }, msg as never)
    const text = toastText(msg.success)
    expect(text).toContain('***')
    expect(text.endsWith('…')).toBe(true)
    expect(text.length).toBeLessThan(long.length)
  })

  it('载荷守卫：空文本/超 32KB 静默忽略', async () => {
    const msg = fakeMessage()
    await expect(handleFrontendClipboard({ text: '' }, msg as never)).resolves.toBe(false)
    await expect(handleFrontendClipboard({ text: 'x'.repeat(32 * 1024 + 1) }, msg as never)).resolves.toBe(false)
    expect(copyTextMock).not.toHaveBeenCalled()
  })

  it('直写失败 → 回落中继槽 + 可点击到达式 toast（功能不缺失多一次点击）', async () => {
    copyTextMock.mockResolvedValue(false)
    const msg = fakeMessage()
    await expect(handleFrontendClipboard({ text: 'deliver-this' }, msg as never)).resolves.toBe(true)
    expect(clipSendMock).toHaveBeenCalledWith('deliver-this', expect.stringMatching(/^clip-/))
    // 可点击 toast 沿到达 toast 的 testid 语义锚点
    const rendered = msg.info.mock.calls.map((c) => (c[0] as () => { props?: Record<string, unknown> })())
    expect(rendered.some((v) => v?.props?.['data-testid'] === 'clip-arrive-toast')).toBe(true)
    expect(addSpy).not.toHaveBeenCalled()
  })

  it('回落链也失败（中继槽拒绝）→ error toast 兜底', async () => {
    copyTextMock.mockResolvedValue(false)
    clipSendMock.mockRejectedValue(new Error('413'))
    const msg = fakeMessage()
    await expect(handleFrontendClipboard({ text: 'x' }, msg as never)).resolves.toBe(false)
    expect(toastIds(msg.error)).toContain('ops-atom-clipboard-failed-toast')
  })
})

describe('handleFrontendOpen', () => {
  let addSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetFrontendAtomStateForTest()
    addSpy = vi.spyOn(useNotificationStore(), 'add')
  })

  it('弹窗放行 → window.open noopener 新标签 + 成功 toast', () => {
    const openMock = vi.fn(() => ({}))
    vi.stubGlobal('open', openMock)
    const msg = fakeMessage()
    expect(handleFrontendOpen({ url: 'https://ci.example.com/run/1' }, msg as never)).toBe(true)
    expect(openMock).toHaveBeenCalledWith('https://ci.example.com/run/1', '_blank', 'noopener')
    expect(toastIds(msg.success)).toContain('ops-atom-open-toast')
    expect(addSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('popup 被拦（open 返回 null）→ 通知中心 url 动作条目 + warning toast', () => {
    vi.stubGlobal('open', vi.fn(() => null))
    const msg = fakeMessage()
    expect(handleFrontendOpen({ url: 'https://ci.example.com/run/2' }, msg as never)).toBe(true)
    expect(addSpy).toHaveBeenCalledTimes(1)
    expect(addSpy).toHaveBeenCalledWith(expect.objectContaining({
      category: 'task',
      action: 'url',
      actionPayload: 'https://ci.example.com/run/2',
    }))
    expect(toastIds(msg.warning)).toContain('ops-atom-open-blocked-toast')
    vi.unstubAllGlobals()
  })

  it('非法 URL 静默忽略（不 window.open 不提示）', () => {
    const openMock = vi.fn(() => ({}))
    vi.stubGlobal('open', openMock)
    const msg = fakeMessage()
    expect(handleFrontendOpen({ url: 'javascript:alert(1)' }, msg as never)).toBe(false)
    expect(openMock).not.toHaveBeenCalled()
    expect(msg.success).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('handleFrontendReload（P-20261111-3）', () => {
  beforeEach(() => {
    resetFrontendAtomStateForTest()
  })

  it('scope=view → bump remount tick + 成功 toast（不走整页分档）', () => {
    const before = useViewReloadTick().value
    const msg = fakeMessage()
    expect(handleFrontendReload({ scope: 'view' }, msg as never)).toBe(true)
    expect(useViewReloadTick().value).toBe(before + 1)
    expect(toastIds(msg.success)).toContain('ops-atom-reload-toast')
    expect(msg.info).not.toHaveBeenCalled()
  })

  it('scope=page / 缺省 / 未知值 → 走整页分档（info toast；真实重载由 e2e 钉）', () => {
    // jsdom 的 location 是 Unforgeable 属性不可 spy——整页重载本体在
    // ops-frontend-atoms.spec 用真实浏览器钉；此处钉分档决策与可见反馈。
    // fake timers 吞掉 300ms 重载回调（jsdom reload 本体是 no-op 报
    // Not implemented，不触发即无噪音）
    vi.useFakeTimers()
    const msg = fakeMessage()
    expect(handleFrontendReload({}, msg as never)).toBe(true)
    expect(toastIds(msg.info)).toContain('ops-atom-reload-toast')
    expect(msg.success).not.toHaveBeenCalled()
    // 未知值按 page 收敛（重载意图明确，粒度存疑取更彻底的重取形态）
    const msg2 = fakeMessage()
    expect(handleFrontendReload({ scope: 'bogus' as 'page' }, msg2 as never)).toBe(true)
    expect(toastIds(msg2.info)).toContain('ops-atom-reload-toast')
    vi.useRealTimers()
  })

  it('设置开关关闭 → 效应不发生 + 「已关闭」提示', () => {
    useOpsAtomPrefs().set('reload', false)
    const before = useViewReloadTick().value
    const msg = fakeMessage()
    expect(handleFrontendReload({ scope: 'view' }, msg as never)).toBe(false)
    expect(useViewReloadTick().value).toBe(before)
    expect(toastIds(msg.info)).toContain('ops-atom-disabled-toast')
    expect(msg.success).not.toHaveBeenCalled()
  })

  it('效应面限频按原子独立：reload 10 次后触顶可见 warning，不影响 download 预算', () => {
    const before = useViewReloadTick().value
    for (let i = 0; i < 10; i++) expect(handleFrontendReload({ scope: 'view' }, fakeMessage() as never)).toBe(true)
    expect(useViewReloadTick().value).toBe(before + 10)
    const msg = fakeMessage()
    expect(handleFrontendReload({ scope: 'view' }, msg as never)).toBe(false)
    expect(useViewReloadTick().value).toBe(before + 10)
    expect(toastIds(msg.warning)).toContain('ops-atom-rate-limited-toast')
    // 独立预算：download 原子不受 reload 触顶影响
    expect(handleFrontendDownload({ path: 'a.md', projectId: 'p' }, fakeMessage() as never)).toBe(true)
  })
})

describe('opsAtomPrefs 开关 store', () => {
  it('默认全开；set(false) 落 localStorage 镜像并可回开', () => {
    const prefs = useOpsAtomPrefs()
    expect(prefs.enabled('download')).toBe(true)
    expect(prefs.enabled('clipboard')).toBe(true)
    expect(prefs.enabled('open')).toBe(true)
    expect(prefs.enabled('reload')).toBe(true)
    prefs.set('clipboard', false)
    expect(prefs.enabled('clipboard')).toBe(false)
    expect(localStorage.getItem('ops-atom-clipboard')).toBe('0')
    // 新实例（模拟刷新启动）从镜像读回关档
    const fresh = useOpsAtomPrefs()
    fresh.load()
    expect(fresh.enabled('clipboard')).toBe(false)
    prefs.set('clipboard', true)
    expect(localStorage.getItem('ops-atom-clipboard')).toBeNull()
    expect(prefs.enabled('clipboard')).toBe(true)
  })
})
