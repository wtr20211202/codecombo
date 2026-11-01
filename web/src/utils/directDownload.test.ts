import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  instanceApiBase,
  fileDownloadUrl,
  dirArchiveUrl,
  filesArchiveUrl,
  filesArchivePathsQuery,
  triggerDirectDownload,
  precheckDownload,
} from './directDownload'
import { setInstanceContext } from '../api/http'
import { setUnlockToken } from '../stores/lock'

// setInstanceContext / setUnlockToken 是模块级注入口（instanceFetch 同款测试形态）
afterEach(() => {
  setInstanceContext(null, false)
  setUnlockToken(null)
  vi.restoreAllMocks()
})

describe('instanceApiBase', () => {
  it('本机实例（默认模块态）= 同源 /api', () => {
    setInstanceContext(null, false)
    expect(instanceApiBase()).toBe('/api')
    setInstanceContext('local', false)
    expect(instanceApiBase()).toBe('/api')
  })

  it('远程实例 = 回环代理 /proxy/<id>/api（与 axios 实例改写同语义）', () => {
    setInstanceContext('inst-abc', true)
    expect(instanceApiBase()).toBe('/proxy/inst-abc/api')
  })

  it('远程标记但缺实例 id：回落 /api（不可构造代理 URL，同 axios 拦截器守卫）', () => {
    setInstanceContext(null, true)
    expect(instanceApiBase()).toBe('/api')
  })
})

describe('直链 URL 构造', () => {
  it('fileDownloadUrl：路径与项目 id 均编码（含 / 与 CJK 的路径安全进 query）', () => {
    setInstanceContext('inst-9', true)
    expect(fileDownloadUrl('p1', 'docs/中 文.txt')).toBe(
      '/proxy/inst-9/api/projects/p1/file/download?path=docs%2F%E4%B8%AD%20%E6%96%87.txt',
    )
  })

  it('dirArchiveUrl：override 缺省不带参数，确认后带 override=1', () => {
    expect(dirArchiveUrl('p1', 'docs/x')).toBe('/api/projects/p1/dir-archive?path=docs%2Fx')
    expect(dirArchiveUrl('p1', 'docs/x', true)).toBe('/api/projects/p1/dir-archive?path=docs%2Fx&override=1')
  })

  it('filesArchiveUrl：paths 手工序列化（非 paths[]= 形态）+ override 追加', () => {
    expect(filesArchiveUrl('p1', ['a.txt', 'docs/b'])).toBe(
      '/api/projects/p1/files-archive?paths=a.txt&paths=docs%2Fb',
    )
    expect(filesArchiveUrl('p1', ['a.txt'], true)).toBe(
      '/api/projects/p1/files-archive?paths=a.txt&override=1',
    )
  })

  it('filesArchivePathsQuery：路径逐个编码后以 & 相连', () => {
    expect(filesArchivePathsQuery(['a&b', 'c d'])).toBe('paths=a%26b&paths=c%20d')
  })
})

describe('triggerDirectDownload', () => {
  it('锚点入 DOM → click → 移除，href/download 属性就位', () => {
    const clicks: number[] = []
    const realClick = HTMLElement.prototype.click
    vi.spyOn(HTMLElement.prototype, 'click').mockImplementation(function (this: HTMLElement) {
      clicks.push(1)
      // 记录点击瞬间锚点是否仍在文档中（Firefox 游离锚点不导航——断言入 DOM 时机）
      expect(this.isConnected).toBe(true)
      expect(this.getAttribute('href')).toBe('/api/projects/p1/file/download?path=x')
      expect(this.getAttribute('download')).toBe('x.txt')
      return realClick.call(this)
    })
    triggerDirectDownload('/api/projects/p1/file/download?path=x', 'x.txt')
    expect(clicks).toHaveLength(1)
  })
})

describe('precheckDownload', () => {
  function stubFetch(status: number, body?: ReadableStream) {
    const fetchMock = vi.fn().mockResolvedValue({ ok: status >= 200 && status < 300, status, body: body ?? null })
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('2xx → null（通过）；带内存令牌时附 X-Lock-Token 头与 1 字节 Range', async () => {
    setUnlockToken('scl_tok')
    const m = stubFetch(206)
    await expect(precheckDownload('/api/projects/p1/file/download?path=a')).resolves.toBeNull()
    expect(m).toHaveBeenCalledWith('/api/projects/p1/file/download?path=a', {
      method: 'GET',
      headers: { Range: 'bytes=0-0', 'X-Lock-Token': 'scl_tok' },
    })
  })

  it('4xx/5xx → 返回状态码供调用方 toast（无令牌不带空头）', async () => {
    const m = stubFetch(404)
    await expect(precheckDownload('/api/projects/p1/file/download?path=gone')).resolves.toBe(404)
    expect(m.mock.calls[0]![1]!.headers).toEqual({ Range: 'bytes=0-0' })
  })

  it('网络层失败 → 0', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(precheckDownload('/api/projects/p1/file/download?path=a')).resolves.toBe(0)
  })

  it('响应体流即刻取消释放（不占浏览器缓冲）', async () => {
    const cancel = vi.fn().mockResolvedValue(undefined)
    const body = { cancel } as unknown as ReadableStream
    stubFetch(200, body)
    await expect(precheckDownload('/api/x')).resolves.toBeNull()
    expect(cancel).toHaveBeenCalled()
  })

  it('body.cancel 拒绝不影响预检结论', async () => {
    const cancel = vi.fn().mockRejectedValue(new Error('cancel failed'))
    const body = { cancel } as unknown as ReadableStream
    stubFetch(200, body)
    await expect(precheckDownload('/api/x')).resolves.toBeNull()
  })
})
